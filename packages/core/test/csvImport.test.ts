import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseCsv, parseCsvRecords, toCsv } from '../src/domain/csv.js'
import { planImport, applyImport, exportCatalogue, IMPORT_COLUMNS } from '../src/services/import.js'
import { rupees } from '../src/money.js'
import { findByBarcode } from '../src/repos/catalog/products.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * A shop's catalogue, in and out.
 *
 * Typing two thousand items at a counter is not a slow start, it is a reason
 * not to buy. The file a shop already has came out of Excel, or Tally, or a
 * wholesaler's portal, and none of those agree about what CSV is — so most of
 * what is tested here is the reader coping with somebody else's idea of a
 * comma.
 */

/* The shop's own administrator, read when used: an actor is checked against
   the roles now, so a made-up name would be refused. */
const ctx = { get actorId(): string { return fx.adminId } }

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('reading somebody else\'s CSV', () => {
  it('keeps a comma that is inside quotes', () => {
    /* `Rice, 5kg` is one field. A split on commas turns a catalogue into
       rubbish, and does it silently. */
    expect(parseCsv('name,rate\r\n"Rice, 5kg",120\r\n'))
      .toEqual([['name', 'rate'], ['Rice, 5kg', '120']])
  })

  it('reads a doubled quote as one quote', () => {
    expect(parseCsv('name\r\n"6"" pipe"\r\n')).toEqual([['name'], ['6" pipe']])
  })

  it('keeps a newline that is inside quotes', () => {
    const rows = parseCsv('name,note\r\n"Rice","5kg\nbag"\r\n')
    expect(rows[1]).toEqual(['Rice', '5kg\nbag'])
  })

  it('takes CRLF, LF and a mixture of the two', () => {
    expect(parseCsv('a,b\nc,d\r\ne,f')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']])
  })

  it('eats the byte-order mark Excel puts on the front', () => {
    /* Otherwise the first header is an invisible character plus `name`, and
       the symptom is a column called name that does not match name. */
    const { headers } = parseCsvRecords('\u{FEFF}name,rate\r\nRice,120\r\n')
    expect(headers).toEqual(['name', 'rate'])
  })

  it('does not count a trailing newline as a row', () => {
    expect(parseCsvRecords('name\r\nRice\r\n').rows).toHaveLength(1)
  })

  it('pads a short row rather than refusing it', () => {
    // Excel truncates trailing empty cells.
    const { rows } = parseCsvRecords('name,barcode,rate\r\nRice\r\n')
    expect(rows[0]?.values).toEqual({ name: 'Rice', barcode: '', rate: '' })
  })

  it('treats Tax %, tax_% and TAX% as one column', () => {
    expect(parseCsvRecords('Tax %\r\n5\r\n').headers).toEqual(['tax%'])
    expect(parseCsvRecords('tax_%\r\n5\r\n').headers).toEqual(['tax%'])
  })

  it('survives a round trip through the writer', () => {
    const awkward = [['Rice, 5kg', '6" pipe', 'two\nlines']]
    const back = parseCsv(toCsv(['a', 'b', 'c'], awkward))
    expect(back[1]).toEqual(awkward[0])
  })
})

describe('planning an import', () => {
  const file = (body: string) => `name,barcode,hsn,tax,unit,rate\r\n${body}`

  it('writes nothing at all', async () => {
    await planImport(fx.db, file('Rice,,1006,5,kg,120\r\n'))
    const products = await fx.db.query('SELECT id FROM products')
    expect(products).toHaveLength(0)
  })

  it('counts what it would create and what it would change', async () => {
    await makeProduct(fx.db, { name: 'Rice' })

    const plan = await planImport(fx.db, file('Rice,,1006,5,kg,120\r\nDal,,0713,5,kg,90\r\n'))
    expect(plan).toMatchObject({ create: 1, update: 1, skip: 0 })
  })

  it('matches on barcode before name', async () => {
    const id = await makeProduct(fx.db, { name: 'Old name', barcode: '8901234567890' })

    const plan = await planImport(fx.db, file('Rice 5kg,8901234567890,1006,5,kg,120\r\n'))
    expect(plan.rows[0]).toMatchObject({ action: 'update', productId: id })
  })

  it('refuses a barcode that belongs to a different product', async () => {
    /* The file and the shop disagree about what that code is. Matching either
       way silently renames something or duplicates it. */
    await makeProduct(fx.db, { name: 'Sugar', barcode: '8901234567890' })
    await makeProduct(fx.db, { name: 'Rice' })

    const plan = await planImport(fx.db, file('Rice,8901234567890,,5,kg,120\r\n'))
    expect(plan.rows[0]).toMatchObject({ problem: 'BARCODE_TAKEN', action: null })
    expect(plan.skip).toBe(1)
  })

  it('names the line number Excel shows', async () => {
    const plan = await planImport(fx.db, file('Rice,,1006,5,kg,120\r\n,,,,,\r\nDal,,,999,kg,90\r\n'))
    // Line 2 is Rice, line 3 is blank and dropped, line 4 is the bad tax.
    expect(plan.rows.find((r) => r.problem === 'BAD_TAX')?.line).toBe(4)
  })

  it('refuses the rubbish row and keeps the rest', async () => {
    const plan = await planImport(fx.db, file(
      'Rice,,1006,5,kg,120\r\n,,,,,\r\nNo rate,,,,,abc\r\nBad tax,,,999,,\r\nBad hsn,,12,,,\r\n',
    ))
    expect(plan.create).toBe(1)
    expect(plan.rows.map((r) => r.problem).filter(Boolean).sort())
      .toEqual(['BAD_HSN', 'BAD_RATE', 'BAD_TAX'])
  })

  it('refuses the same barcode or name twice in one file', async () => {
    const plan = await planImport(fx.db, file(
      'Rice,111,,,,10\r\nDal,111,,,,20\r\nRice,,,,,30\r\n',
    ))
    expect(plan.rows.map((r) => r.problem))
      .toEqual([null, 'BARCODE_TWICE', 'NAME_TWICE'])
  })

  it('says which columns it did not understand rather than guessing', async () => {
    const plan = await planImport(fx.db, 'name,rate,supplier code\r\nRice,120,SUP1\r\n')
    expect(plan.unknownColumns).toEqual(['suppliercode'])
    // And still imports what it does understand.
    expect(plan.create).toBe(1)
  })

  it('takes a rupee sign and thousands commas off a wholesaler file', async () => {
    const plan = await planImport(fx.db, 'name,rate\r\n"Rice","₹1,250.00"\r\n')
    expect(plan.rows[0]?.rate).toBe(rupees(1250))
  })

  it('reads 5, 5% and 5.0 as five per cent', async () => {
    const plan = await planImport(fx.db, 'name,tax\r\nA,5\r\nB,5%\r\nC,5.0\r\n')
    expect(plan.rows.map((r) => r.taxRateBp)).toEqual([500, 500, 500])
  })

  it('refuses a tax above 100, rather than clamping it', async () => {
    /* Somebody has typed basis points into a percent column. Importing 2800
       as 2,800% would only be visible on the first bill. */
    const plan = await planImport(fx.db, 'name,tax\r\nA,2800\r\n')
    expect(plan.rows[0]?.problem).toBe('BAD_TAX')
  })
})

describe('applying one', () => {
  it('creates what it said it would', async () => {
    const plan = await planImport(fx.db, 'name,hsn,tax,unit,rate\r\nRice,1006,5,kg,120\r\n')
    expect(await applyImport(fx.db, ctx, plan)).toEqual({ created: 1, updated: 0, skipped: 0, stocked: 0, stockIgnored: 0 })

    const row = await fx.db.get<{ name: string; tax_rate_bp: number; base_rate: number }>(
      'SELECT name, tax_rate_bp, base_rate FROM products',
    )
    expect(row).toMatchObject({ name: 'Rice', tax_rate_bp: 500, base_rate: rupees(120) })
  })

  it('leaves a blank cell alone rather than wiping what is there', async () => {
    /* A file carrying only name and rate is a price update. It must not wipe
       every HSN code in the shop on its way through. */
    const id = await makeProduct(fx.db, { name: 'Rice', baseRate: rupees(100) })
    await fx.db.execute('UPDATE products SET hsn_code = ?, base_unit = ? WHERE id = ?',
      ['1006', 'kg', id])

    const plan = await planImport(fx.db, 'name,rate\r\nRice,150\r\n')
    await applyImport(fx.db, ctx, plan)

    const row = await fx.db.get<{ hsn_code: string; base_unit: string; base_rate: number }>(
      'SELECT hsn_code, base_unit, base_rate FROM products WHERE id = ?', [id],
    )
    expect(row).toMatchObject({ hsn_code: '1006', base_unit: 'kg', base_rate: rupees(150) })
  })

  it('skips the rows the plan refused', async () => {
    const plan = await planImport(fx.db, 'name,tax\r\nRice,5\r\nBad,999\r\n')
    expect(await applyImport(fx.db, ctx, plan)).toEqual({ created: 1, updated: 0, skipped: 1, stocked: 0, stockIgnored: 0 })
    expect(await fx.db.query('SELECT id FROM products')).toHaveLength(1)
  })

  it('records where the change came from', async () => {
    const plan = await planImport(fx.db, 'name,rate\r\nRice,120\r\n')
    await applyImport(fx.db, ctx, plan)

    const audit = await fx.db.get<{ diff: string }>(
      `SELECT diff FROM audit_log WHERE entity = 'products'`,
    )
    expect(audit?.diff).toContain('csv import')
  })

  it('is all or nothing', async () => {
    /* Half an imported catalogue is worse than none: nobody can tell which
       half, and running the file again duplicates everything that landed.

       The failure is injected at the driver rather than faked in the plan,
       because the thing being pinned is that the writes are inside one
       transaction — and the only way to see a rollback is to make something
       fail after the first row has already been written. */
    const plan = await planImport(fx.db, 'name,rate\r\nRice,120\r\nDal,90\r\n')

    let inserts = 0
    const failsOnTheSecond: SqlDriver = {
      ...fx.db,
      query: (sql, params) => fx.db.query(sql, params),
      get: (sql, params) => fx.db.get(sql, params),
      queryValues: (sql, params) => fx.db.queryValues(sql, params),
      transaction: (fn, opts) => fx.db.transaction((tx) => fn({
        ...tx,
        query: (sql, params) => tx.query(sql, params),
        get: (sql, params) => tx.get(sql, params),
        queryValues: (sql, params) => tx.queryValues(sql, params),
        transaction: (inner) => inner(tx),
        close: () => Promise.resolve(),
        execute: (sql, params) => {
          if (/^\s*insert into "products"/i.test(sql) && ++inserts === 2) {
            throw new Error('the disk went away')
          }
          return tx.execute(sql, params)
        },
      }), opts),
      execute: (sql, params) => fx.db.execute(sql, params),
      close: () => Promise.resolve(),
    }

    /* The message that comes back is drizzle's, wrapping ours. What matters
       is that it came back out rather than being swallowed. */
    await expect(applyImport(failsOnTheSecond, ctx, plan)).rejects.toThrow()

    // Rice was written before Dal failed. Neither survives.
    expect(await fx.db.query('SELECT id FROM products')).toHaveLength(0)
  })
})

describe('the round trip', () => {
  it('exports only columns the import understands', async () => {
    /* An exported column the importer ignores is a column of edits that
       silently do nothing — which is the worst kind of nothing. */
    await makeProduct(fx.db, { name: 'Rice' })
    const headers = (await exportCatalogue(fx.db)).split('\r\n')[0]?.split(',') ?? []
    for (const header of headers) {
      expect(IMPORT_COLUMNS as readonly string[]).toContain(header)
    }
  })

  it('exports, re-imports, and changes nothing', async () => {
    await makeProduct(fx.db, { name: 'Rice', baseRate: rupees(120), taxRateBp: 500 })
    await makeProduct(fx.db, { name: 'Dal, split', baseRate: rupees(90) })

    const file = await exportCatalogue(fx.db)
    const plan = await planImport(fx.db, file)

    // Every row matches something, and nothing new is created.
    expect(plan).toMatchObject({ create: 0, skip: 0 })
    expect(plan.update).toBe(2)

    await applyImport(fx.db, ctx, plan)
    expect(await exportCatalogue(fx.db)).toBe(file)
  })
})

describe('a name that a spreadsheet would run', () => {
  it('is written as text, and an amount is left an amount', () => {
    const csv = toCsv(['name', 'balance'], [['=HYPERLINK("http://x")', '-500.00'], ['@SUM(A1)', 12], ['-cmd|x', '-1,23,456.50']])
    const [, first, second, third] = parseCsv(csv)
    expect(first).toEqual([`'=HYPERLINK("http://x")`, '-500.00'])
    expect(second).toEqual([`'@SUM(A1)`, '12'])
    expect(third).toEqual([`'-cmd|x`, '-1,23,456.50'])
  })

  it('reads back as it was written, so an export and an import agree', () => {
    const csv = toCsv(['name'], [['+Plus Pen'], ['-minus ruler'], ['Plain']])
    expect(parseCsvRecords(csv).rows.map((r) => r.values['name'])).toEqual(['+Plus Pen', '-minus ruler', 'Plain'])
  })
})

describe('opening stock on the way in', () => {
  it('is recorded for a new item, and left alone on one the shop already has', async () => {
    const fx = await freshDb()
    try {
      const existing = await makeProduct(fx.db, { name: 'Pencil HB' })
      const plan = await planImport(fx.db, 'name,rate,openingqty\nEraser,5,40\nPencil HB,4,100\n')
      const result = await applyImport(fx.db, { actorId: fx.adminId }, plan)
      expect(result).toMatchObject({ created: 1, updated: 1, stocked: 1, stockIgnored: 1 })

      const stock = await fx.db.query<{ name: string; qty: number }>(
        `SELECT p.name, COALESCE(s.qty_on_hand, 0) AS qty FROM products p
           LEFT JOIN product_stock s ON s.product_id = p.id ORDER BY p.name`,
      )
      expect(stock.find((r) => r.name === 'Eraser')?.qty).toBe(40 * 10_000)
      expect(stock.find((r) => r.name === 'Pencil HB')?.qty ?? 0).toBe(0)
      expect(existing).toBeTruthy()
    } finally {
      await fx.db.close()
    }
  })

  it('refuses a negative opening quantity', async () => {
    const fx = await freshDb()
    try {
      const plan = await planImport(fx.db, 'name,openingqty\nGlue,-3\n')
      expect(plan.rows[0]?.problem).toBe('BAD_QTY')
    } finally {
      await fx.db.close()
    }
  })
})

describe('brand, category and cost', () => {
  it('makes an imported barcode one the scanner finds', async () => {
    /* The import wrote `products.barcode` and nothing else, and the scanner reads
       `product_barcodes`: every item it made showed a barcode and did not scan. */
    await applyImport(fx.db, ctx, await planImport(fx.db, 'name,barcode,rate\r\nRice,8901234567890,120\r\n'))
    const found = await findByBarcode(fx.db, '8901234567890')
    expect(found?.name).toBe('Rice')
  })

  it('adds a new barcode to an item it updates, keeping the ones it had', async () => {
    const id = await makeProduct(fx.db, { name: 'Rice', barcode: '111' })
    await applyImport(fx.db, ctx, await planImport(fx.db, 'name,barcode\r\nRice,222\r\n'))
    expect((await findByBarcode(fx.db, '222'))?.id).toBe(id)
    expect((await findByBarcode(fx.db, '111'))?.id).toBe(id)
    const row = await fx.db.get<{ barcode: string }>('SELECT barcode FROM products WHERE id = ?', [id])
    expect(row?.barcode).toBe('222')
  })

  it('matches on a barcode the item answers to besides its primary', async () => {
    const id = await makeProduct(fx.db, { name: 'Rice', barcode: '111' })
    await fx.db.execute(
      `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at) VALUES ('x', ?, '999', 0, '2026-01-01')`, [id])
    const plan = await planImport(fx.db, 'name,barcode,rate\r\nSugar,999,50\r\n')
    // No item is called Sugar, so the code decides: the item it is on, not a duplicate of it.
    expect(plan.rows[0]).toMatchObject({ problem: null, action: 'update', productId: id })
  })

  it('lets one name come from several brands', async () => {
    const plan = await planImport(fx.db,
      'name,brand,barcode,rate\r\nOil Pastels 12S,Doms,1,50\r\nOil Pastels 12S,Camel,2,40\r\nOil Pastels 12S,doms,3,45\r\n')
    expect(plan.rows.map((r) => r.problem)).toEqual([null, null, 'NAME_TWICE'])

    await applyImport(fx.db, ctx, plan)
    const rows = await fx.db.query<{ brand: string }>(`SELECT brand FROM products ORDER BY brand`)
    expect(rows.map((r) => r.brand)).toEqual(['Camel', 'Doms'])
  })

  it('matches the item of that brand, and refuses a bare name that is two items', async () => {
    const doms = await makeProduct(fx.db, { name: 'Clay 8S' })
    const apsara = await makeProduct(fx.db, { name: 'Clay 8S' })
    await fx.db.execute(`UPDATE products SET brand = 'Doms' WHERE id = ?`, [doms])
    await fx.db.execute(`UPDATE products SET brand = 'Apsara' WHERE id = ?`, [apsara])

    const branded = await planImport(fx.db, 'name,brand,rate\r\nClay 8S,APSARA,60\r\n')
    expect(branded.rows[0]).toMatchObject({ action: 'update', productId: apsara })

    // Without a brand there is no telling which, and guessing reprices the wrong one.
    const bare = await planImport(fx.db, 'name,rate\r\nClay 8S,60\r\n')
    expect(bare.rows[0]?.problem).toBe('NAME_AMBIGUOUS')
  })

  it('gives a brand to an item that had none, rather than making a second', async () => {
    const id = await makeProduct(fx.db, { name: 'Fevibond' })
    const plan = await planImport(fx.db, 'name,brand\r\nFevibond,Pidilite\r\n')
    expect(plan.rows[0]).toMatchObject({ action: 'update', productId: id })
    await applyImport(fx.db, ctx, plan)
    expect((await fx.db.get<{ brand: string }>('SELECT brand FROM products WHERE id = ?', [id]))?.brand).toBe('Pidilite')
  })

  it('files items under a category by name, making the ones the shop lacks once', async () => {
    const now = new Date().toISOString()
    await fx.db.execute(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', 'Glue', ?, ?)`, [now, now])

    await applyImport(fx.db, ctx, await planImport(fx.db,
      'name,category\r\nFevicol 50g,glue\r\nClay 6S,Clay\r\nClay Jar,CLAY\r\n'))

    const rows = await fx.db.query<{ name: string; category: string }>(
      `SELECT p.name, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.name`)
    expect(rows).toEqual([
      { name: 'Clay 6S', category: 'Clay' },
      { name: 'Clay Jar', category: 'Clay' },
      { name: 'Fevicol 50g', category: 'Glue' },
    ])
    expect(await fx.db.query('SELECT id FROM categories')).toHaveLength(2)
  })

  it('values opening stock at the cost the file gives', async () => {
    await applyImport(fx.db, ctx, await planImport(fx.db, 'name,rate,cost,openingqty\r\nEraser,5,3.50,40\r\n'))
    const stock = await fx.db.get<{ stock_value: number }>('SELECT stock_value FROM product_stock')
    expect(stock?.stock_value).toBe(rupees(140))
  })

  it('refuses a cost that is not a number', async () => {
    const plan = await planImport(fx.db, 'name,cost\r\nEraser,abc\r\n')
    expect(plan.rows[0]?.problem).toBe('BAD_COST')
  })

  it('exports brand, category and cost, and they come back unchanged', async () => {
    await applyImport(fx.db, ctx, await planImport(fx.db,
      'name,brand,category,barcode,rate,cost,openingqty\r\nEraser,Apsara,Stationery,555,5,3.50,40\r\n'))
    const file = await exportCatalogue(fx.db)
    expect(file).toContain('Eraser,Apsara,Stationery,555,,,piece,5.00,,3.50,40')

    const plan = await planImport(fx.db, file)
    expect(plan).toMatchObject({ create: 0, update: 1, skip: 0 })
    await applyImport(fx.db, ctx, plan)
    expect(await exportCatalogue(fx.db)).toBe(file)
  })
})

describe('the same file on two tills', () => {
  it('creates the same items, so the merge joins them rather than doubling the catalogue', async () => {
    /* Two tills importing one supplier's list while apart used to mint two ids
       per item. Nothing refused it -- an import leaves `code` empty -- and the
       shop had every item twice. */
    const other = await freshDb()
    try {
      const csv = 'name,barcode,rate\r\nRice 5kg,8901234567890,120\r\nDal,,90\r\n'
      await applyImport(fx.db, ctx, await planImport(fx.db, csv))
      await applyImport(other.db, { actorId: other.adminId }, await planImport(other.db, csv))

      const ids = async (db: typeof fx.db) => (await db.query<{ id: string }>(
        `SELECT id FROM products WHERE name IN ('Rice 5kg', 'Dal') ORDER BY name`)).map((r) => r.id)
      expect(await ids(other.db)).toEqual(await ids(fx.db))
    } finally {
      await other.db.close()
    }
  })

  it('still imports an item whose derived id is already taken here', async () => {
    const csv = 'name,rate\r\nDal,90\r\n'
    await applyImport(fx.db, ctx, await planImport(fx.db, csv))
    await fx.db.execute(`UPDATE products SET name = 'Toor Dal' WHERE name = 'Dal'`)
    const again = await applyImport(fx.db, ctx, await planImport(fx.db, csv))
    expect(again.created).toBe(1)
  })
})
