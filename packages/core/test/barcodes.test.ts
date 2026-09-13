import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listBarcodes, setBarcodes, productIdForBarcode } from '../src/services/barcodes.js'
import { searchProducts, findByBarcode } from '../src/repos/catalog.js'
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

describe('keeping the scan unambiguous', () => {
  /* A scan that could mean two things is worse than a scan that means nothing. */
  it('refuses a barcode another item already answers to', async () => {
    const mine = await makeProduct(fx.db, { name: 'Mine' })
    const theirs = await makeProduct(fx.db, { name: 'Sakthi pen' })
    await setBarcodes(fx.db, ctx(), theirs, [{ barcode: '8901234567890' }])

    const result = await setBarcodes(fx.db, ctx(), mine, [{ barcode: '8901234567890' }])
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('TAKEN')
    expect(result.productName).toBe('Sakthi pen')

    // And nothing was written: the refusal happens before the rewrite.
    expect(await listBarcodes(fx.db, mine)).toHaveLength(0)
  })

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
