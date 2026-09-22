import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseCsv, parseCsvRecords, toCsv } from '../src/domain/csv.js'
import { planImport, applyImport, exportCatalogue, IMPORT_COLUMNS } from '../src/services/import.js'
import { rupees } from '../src/money.js'
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

const ctx = { actorId: 'owner' }

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
    expect(await applyImport(fx.db, ctx, plan)).toEqual({ created: 1, updated: 0, skipped: 0 })

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
    expect(await applyImport(fx.db, ctx, plan)).toEqual({ created: 1, updated: 0, skipped: 1 })
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
