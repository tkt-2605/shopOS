import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setUnits, setItemPrice, setCustomerPrice } from '../src/services/pricing.js'
import { setBarcodes } from '../src/services/barcodes.js'
import { derivedId, newId } from '../src/ids.js'
import { rupees } from '../src/money.js'
import { fromUnits, qty } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * Rows two tills can write without asking each other.
 *
 * Almost everything in this database is an event — a bill, a payment, a stock
 * movement — and the till that recorded it is entitled to name it. A handful of
 * tables are not events but statements about a combination: what this product
 * costs on that list in that unit, that it comes in boxes of twelve, that this
 * barcode is its. Two counters out of touch can make the same statement, and
 * with a minted id they make it twice.
 *
 * Nothing refuses that. The two rows are both valid, both replicate, and the
 * shop is left holding one fact under two ids, each with its own revision,
 * disagreeing for ever about a rate nobody edited. The pricing ladder shows two
 * identical rungs and the scanner finds a barcode on two rows.
 *
 * So these ids are derived from the combination, and the two tills write the
 * same row without ever having met.
 */

let one: Fixture
let two: Fixture

beforeEach(async () => {
  one = await freshDb()
  two = await freshDb()
})
afterEach(async () => {
  await one.db.close()
  await two.db.close()
})

const ctx = (fx: Fixture) => ({ actorId: fx.adminId })

/**
 * The same product, customer and price list on both tills, which is what
 * replication leaves behind: one shop, two machines, one set of ids.
 *
 * The ids have to be shared for this to be a test of anything. Two fixtures
 * bootstrap two shops with two price lists, and a derived id that includes the
 * list would then differ for the honest reason. What is being pinned is the
 * other case — one shop, and both counters naming the same combination.
 */
async function onBoth(): Promise<{ product: string; customer: string; list: string }> {
  const product = newId()
  const customer = newId()
  const list = newId()
  const now = new Date().toISOString()
  for (const fx of [one, two]) {
    await makeProduct(fx.db, { id: product, name: 'Rice 1kg' })
    await fx.db.execute(
      `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, 'Anand Stores', ?, ?)`,
      [customer, now, now],
    )
    await fx.db.execute(
      `INSERT INTO price_lists (id, name, is_default, created_at, updated_at)
       VALUES (?, 'Shared', 0, ?, ?)`,
      [list, now, now],
    )
  }
  return { product, customer, list }
}

async function idsIn(fx: Fixture, table: string): Promise<string[]> {
  const rows = await fx.db.query<{ id: string }>(`SELECT id FROM "${table}" ORDER BY id`)
  return rows.map((r) => r.id)
}

describe('two tills that have never met', () => {
  it('price the same item under one id', async () => {
    const { product, list } = await onBoth()
    for (const fx of [one, two]) {
      const set = await setItemPrice(fx.db, ctx(fx), {
        productId: product,
        priceListId: list,
        saleUnit: 'piece',
        rate: rupees(90),
      })
      if (!set.ok) throw new Error(set.code)
    }

    /* One row each, with the same id, so the merge sees one record. With a
       minted id these are two rows carrying one fact, and the ladder the
       resolver walks has two identical rungs on it. */
    expect(await idsIn(one, 'item_prices')).toEqual(await idsIn(two, 'item_prices'))
  })

  it('give a customer the same special rate under one id', async () => {
    const { product, customer } = await onBoth()
    for (const fx of [one, two]) {
      const set = await setCustomerPrice(fx.db, ctx(fx), {
        customerId: customer, productId: product, saleUnit: 'piece', rate: rupees(85),
      })
      if (!set.ok) throw new Error(set.code)
    }

    expect(await idsIn(one, 'customer_item_prices')).toEqual(await idsIn(two, 'customer_item_prices'))
  })

  it('agree on what a box of twelve is', async () => {
    const { product } = await onBoth()
    for (const fx of [one, two]) {
      const set = await setUnits(fx.db, ctx(fx), product, [
        { saleUnit: 'box', baseUnits: fromUnits(12) },
      ])
      if (!set.ok) throw new Error(set.code)
    }

    expect(await idsIn(one, 'product_units')).toEqual(await idsIn(two, 'product_units'))
  })

  it('agree on a barcode', async () => {
    const { product } = await onBoth()
    for (const fx of [one, two]) {
      const set = await setBarcodes(fx.db, ctx(fx), product, [{ barcode: '8901234567890' }])
      if (!set.ok) throw new Error(set.code)
    }

    expect(await idsIn(one, 'product_barcodes')).toEqual(await idsIn(two, 'product_barcodes'))
  })

  /**
   * The whole set is rewritten on every save, which is what made a minted id
   * so expensive: a barcode nobody touched came back as a different row, and
   * that row had to cross to every other till.
   */
  it('do not churn the id of something nobody touched', async () => {
    const { product } = await onBoth()
    await setBarcodes(one.db, ctx(one), product, [{ barcode: '8901234567890' }])
    const first = await idsIn(one, 'product_barcodes')

    await setBarcodes(one.db, ctx(one), product, [
      { barcode: '8901234567890' },
      { barcode: '8909999999999' },
    ])
    const second = await idsIn(one, 'product_barcodes')

    expect(second).toHaveLength(2)
    expect(second, 'the first barcode kept the id it had').toContain(first[0])
  })
})

describe('the derivation itself', () => {
  it('is the same answer every time and on every machine', async () => {
    expect(await derivedId('item_prices', 'a', 'b')).toBe(await derivedId('item_prices', 'a', 'b'))
  })

  it('tells two combinations apart even when the words run together', async () => {
    /* Without a separator `('ab', 'c')` and `('a', 'bc')` are one name, and two
       different rows would be handed one id — which in these tables is a
       `UNIQUE` failure on a shop's counter rather than a curiosity. */
    expect(await derivedId('ab', 'c')).not.toBe(await derivedId('a', 'bc'))
  })

  it('keeps the kinds apart, so one combination cannot mean two rows', async () => {
    expect(await derivedId('product_units', 'x', 'box'))
      .not.toBe(await derivedId('product_barcodes', 'x', 'box'))
  })

  it('is a version 5 uuid, so nothing downstream can tell it from any other', async () => {
    const id = await derivedId('item_prices', 'a')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('counts a quantity as what it is, not as what it looks like', async () => {
    expect(await derivedId('item_prices', 'p', 'l', 'NOS', qty(0)))
      .not.toBe(await derivedId('item_prices', 'p', 'l', 'NOS', fromUnits(1)))
  })
})
