import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listBarcodes, setBarcodes, productIdForBarcode, productIdsForBarcode } from '../src/services/barcodes.js'
import { searchProducts, findByBarcode, findAllByBarcode, scanChoices } from '../src/repos/catalog.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

describe('an item with several barcodes', () => {
  it('is found by any of them', async () => {
    const p = await makeProduct(fx.db, { name: 'Classmate notebook' })
    const set = await setBarcodes(fx.db, ctx(), p, [
      { barcode: '8901234567890', label: 'manufacturer' },
      { barcode: 'SHOP-0041', label: 'our label' },
    ])
    expect(set.ok).toBe(true)

    for (const code of ['8901234567890', 'SHOP-0041']) {
      const found = await findByBarcode(fx.db, code)
      expect(found?.id).toBe(p)
    }
  })

  it('puts a scanned match first in a search, whichever label was scanned', async () => {
    const other = await makeProduct(fx.db, { name: 'A notebook that sorts first' })
    const p = await makeProduct(fx.db, { name: 'Z notebook' })
    await setBarcodes(fx.db, ctx(), p, [{ barcode: '8901234567890' }, { barcode: 'SHOP-0041' }])
    await setBarcodes(fx.db, ctx(), other, [{ barcode: '1111111111111' }])

    const results = await searchProducts(fx.db, { term: 'SHOP-0041' })
    expect(results[0]?.id).toBe(p)
  })

  it('keeps the first as the one shown in lists', async () => {
    const p = await makeProduct(fx.db)
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'FIRST' }, { barcode: 'SECOND' }])

    const row = await fx.db.get<{ barcode: string }>(`SELECT barcode FROM products WHERE id = ?`, [p])
    expect(row?.barcode).toBe('FIRST')

    const codes = await listBarcodes(fx.db, p)
    expect(codes.map((c) => [c.barcode, c.isPrimary])).toEqual([['FIRST', true], ['SECOND', false]])
  })

  it('moves the printed code when the order changes', async () => {
    const p = await makeProduct(fx.db)
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'FIRST' }, { barcode: 'SECOND' }])
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'SECOND' }, { barcode: 'FIRST' }])

    const row = await fx.db.get<{ barcode: string }>(`SELECT barcode FROM products WHERE id = ?`, [p])
    expect(row?.barcode).toBe('SECOND')
  })
})

describe('one barcode on several items (069)', () => {
  /* A manufacturer puts one EAN on two pack sizes, and the shop keeps them as
     two items. Refusing the second its code left it findable only by name. */
  it('is saved on both, and says which other item has it', async () => {
    const small = await makeProduct(fx.db, { name: 'Glue 50ml' })
    const large = await makeProduct(fx.db, { name: 'Glue 100ml' })
    await setBarcodes(fx.db, ctx(), small, [{ barcode: '8901234567890' }])

    const result = await setBarcodes(fx.db, ctx(), large, [{ barcode: '8901234567890' }])
    expect(result).toMatchObject({ ok: true, shared: [{ barcode: '8901234567890', productId: small, productName: 'Glue 50ml' }] })
    expect((await listBarcodes(fx.db, large)).map((b) => b.barcode)).toEqual(['8901234567890'])
    // And the first item still has it: the second did not take it away.
    expect((await listBarcodes(fx.db, small)).map((b) => b.barcode)).toEqual(['8901234567890'])
  })

  it('makes a scan find both, and refuses to pick one when asked for one', async () => {
    const small = await makeProduct(fx.db, { name: 'Glue 50ml', baseRate: 2500 })
    const large = await makeProduct(fx.db, { name: 'Glue 100ml', baseRate: 4500 })
    await setBarcodes(fx.db, ctx(), small, [{ barcode: 'SHARED' }])
    await setBarcodes(fx.db, ctx(), large, [{ barcode: 'SHARED' }])

    expect((await findAllByBarcode(fx.db, 'SHARED')).map((p) => p.id).sort()).toEqual([small, large].sort())
    expect((await productIdsForBarcode(fx.db, 'SHARED')).sort()).toEqual([small, large].sort())
    // Handing back the first of two would be choosing for the cashier.
    expect(await findByBarcode(fx.db, 'SHARED')).toBeNull()
    expect(await productIdForBarcode(fx.db, 'SHARED')).toBeNull()
  })

  it('marks both in a search, so the screen asks which', async () => {
    const small = await makeProduct(fx.db, { name: 'Glue 50ml' })
    const large = await makeProduct(fx.db, { name: 'Glue 100ml' })
    const other = await makeProduct(fx.db, { name: 'SHARED glue, by name only' })
    await setBarcodes(fx.db, ctx(), small, [{ barcode: 'SHARED' }])
    await setBarcodes(fx.db, ctx(), large, [{ barcode: 'SHARED' }])

    const rows = await searchProducts(fx.db, { term: 'SHARED' })
    expect(rows.slice(0, 2).map((r) => r.scanned)).toEqual([true, true])
    expect(rows.find((r) => r.id === other)?.scanned).toBe(false)
    expect(scanChoices(rows)?.map((r) => r.id).sort()).toEqual([small, large].sort())
  })

  it('asks nothing of a code only one item has', async () => {
    const p = await makeProduct(fx.db, { name: 'Glue 50ml' })
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'ONLY' }])
    expect(scanChoices(await searchProducts(fx.db, { term: 'ONLY' }))).toBeNull()
    expect(await setBarcodes(fx.db, ctx(), p, [{ barcode: 'ONLY' }])).toMatchObject({ ok: true, shared: [] })
  })

  it('takes the code off one item without taking it off the other', async () => {
    const small = await makeProduct(fx.db, { name: 'Glue 50ml' })
    const large = await makeProduct(fx.db, { name: 'Glue 100ml' })
    await setBarcodes(fx.db, ctx(), small, [{ barcode: 'SHARED' }])
    await setBarcodes(fx.db, ctx(), large, [{ barcode: 'SHARED' }])
    await setBarcodes(fx.db, ctx(), small, [])

    expect(await productIdForBarcode(fx.db, 'SHARED')).toBe(large)
    // Put back on, it is its own row again rather than the other item's moved.
    await setBarcodes(fx.db, ctx(), small, [{ barcode: 'SHARED' }])
    expect((await productIdsForBarcode(fx.db, 'SHARED')).sort()).toEqual([small, large].sort())
  })
})

describe('keeping the scan unambiguous', () => {

  it('lets an item keep its own barcode when it is edited again', async () => {
    const p = await makeProduct(fx.db)
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'KEEP-ME' }])
    const again = await setBarcodes(fx.db, ctx(), p, [{ barcode: 'KEEP-ME' }, { barcode: 'AND-THIS' }])
    expect(again.ok).toBe(true)
  })

  it('ignores blanks and repeats in what it is given', async () => {
    const p = await makeProduct(fx.db)
    const result = await setBarcodes(fx.db, ctx(), p, [
      { barcode: '  ' }, { barcode: 'ONE' }, { barcode: 'ONE' }, { barcode: '' },
    ])
    if (!result.ok) throw new Error(result.code)
    expect(result.barcodes.map((b) => b.barcode)).toEqual(['ONE'])
  })

  it('clears the printed code when every barcode is removed', async () => {
    const p = await makeProduct(fx.db)
    await setBarcodes(fx.db, ctx(), p, [{ barcode: 'GONE' }])
    await setBarcodes(fx.db, ctx(), p, [])

    const row = await fx.db.get<{ barcode: string | null }>(`SELECT barcode FROM products WHERE id = ?`, [p])
    expect(row?.barcode).toBeNull()
    expect(await productIdForBarcode(fx.db, 'GONE')).toBeNull()
  })
})

describe('the barcode a product was created with', () => {
  /* The scanner reads product_barcodes. A product whose printed code has no row
     there is invisible to the scanner, which is how this breaks quietly. */
  it('is scannable', async () => {
    const p = await makeProduct(fx.db, { barcode: '8901111111111' })
    expect((await findByBarcode(fx.db, '8901111111111'))?.id).toBe(p)
    expect(await productIdForBarcode(fx.db, '8901111111111')).toBe(p)
  })
})
