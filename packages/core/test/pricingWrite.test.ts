import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listUnits, setUnits, listPriceLists, createPriceList, updatePriceList,
  listItemPrices, setItemPrice, removeItemPrice,
  listCustomerPrices, setCustomerPrice, setCustomerPriceList, perBaseUnit,
  archivePriceList, restorePriceList,
} from '../src/services/pricing.js'
import { loadPriceCandidates, pricingContextFor, resolveLinePrice } from '../src/repos/pricing.js'
import { resolvePrice } from '../src/domain/pricing.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { rupees } from '../src/money.js'
import { fromUnits, qty } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

describe('the units a product sells in', () => {
  it('are whatever the shop calls them', async () => {
    const p = await makeProduct(fx.db, { name: 'A4 paper' })
    const set = await setUnits(fx.db, ctx(), p, [
      { saleUnit: 'ream', baseUnits: fromUnits(500) },
      { saleUnit: 'packet', baseUnits: fromUnits(100) },
    ])
    if (!set.ok) throw new Error(set.code)

    // Smallest first, so a list reads from the loose one upwards.
    expect(set.units.map((u) => u.saleUnit)).toEqual(['packet', 'ream'])
    expect(set.units[1]!.baseUnits).toBe(fromUnits(500))
  })

  /* The base unit is what stock is held in and valuation is calculated in. A
     pack is ten pieces; the piece is not a pack of anything. */
  it('cannot be the base unit itself', async () => {
    const p = await makeProduct(fx.db)
    const result = await setUnits(fx.db, ctx(), p, [{ saleUnit: 'piece', baseUnits: fromUnits(10) }])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('CLASHES_WITH_BASE')
  })

  it('cannot be worth nothing', async () => {
    const p = await makeProduct(fx.db)
    const result = await setUnits(fx.db, ctx(), p, [{ saleUnit: 'box', baseUnits: qty(0) }])
    expect(result.ok).toBe(false)
  })

  it('cannot be taken away once bills have been written in them', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    await setUnits(fx.db, ctx(), p, [{ saleUnit: 'dozen', baseUnits: fromUnits(12) }])
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'dozen', rate: rupees(110),
    })

    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(1), saleUnit: 'dozen' }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: bill.grandTotal }],
      actorId: fx.adminId,
    })

    const result = await setUnits(fx.db, ctx(), p, [])
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('IN_USE')
    expect(await listUnits(fx.db, p)).toHaveLength(1)
  })
})

describe('price lists', () => {
  it('come with the shop already having one', async () => {
    const lists = await listPriceLists(fx.db)
    expect(lists.some((l) => l.isDefault)).toBe(true)
  })

  it('refuse a name another list has', async () => {
    await createPriceList(fx.db, ctx(), { name: 'Wholesale' })
    const again = await createPriceList(fx.db, ctx(), { name: 'wholesale' })
    expect(again.ok).toBe(false)
  })

  /* A shop with two defaults has no answer for a walk-in customer. */
  it('never leave two marked default', async () => {
    const made = await createPriceList(fx.db, ctx(), { name: 'Festival', isDefault: true })
    if (!made.ok) throw new Error(made.code)

    const lists = await listPriceLists(fx.db)
    expect(lists.filter((l) => l.isDefault).map((l) => l.name)).toEqual(['Festival'])
  })

  it('say how many customers would be affected by a change', async () => {
    const made = await createPriceList(fx.db, ctx(), { name: 'Wholesale' })
    if (!made.ok) throw new Error(made.code)
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerPriceList(fx.db, ctx(), customer, made.priceListId)

    const list = (await listPriceLists(fx.db)).find((l) => l.id === made.priceListId)
    expect(list?.customerCount).toBe(1)
  })

  it('can be renamed without losing their prices', async () => {
    const made = await createPriceList(fx.db, ctx(), { name: 'Wholesale' })
    if (!made.ok) throw new Error(made.code)
    const p = await makeProduct(fx.db)
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: made.priceListId, saleUnit: 'piece', rate: rupees(8),
    })

    await updatePriceList(fx.db, ctx(), { priceListId: made.priceListId, name: 'Bulk' })
    const list = (await listPriceLists(fx.db)).find((l) => l.id === made.priceListId)
    expect(list?.name).toBe('Bulk')
    expect(list?.priceCount).toBe(1)
  })
})

/**
 * Taking a price list off the screen.
 *
 * `price_lists` had two retirement columns and neither of them worked.
 * `is_active` was written on every create and update and read by nothing --
 * not the resolver, not `listPriceLists`, not `defaultPriceListId` -- so a
 * list marked inactive went on pricing every line it had ever priced.
 * `deleted_at` was the opposite: filtered by every reader and set by nothing,
 * so a list typed in by mistake stayed forever. Migration 031 drops the first
 * and these tests are the writing half of the second.
 */
describe('a price list taken off the screen', () => {
  async function list(name: string): Promise<string> {
    const made = await createPriceList(fx.db, ctx(), { name })
    if (!made.ok) throw new Error(made.code)
    return made.priceListId
  }

  it('goes out of the list of lists, and comes back', async () => {
    const id = await list('Festival')
    expect(await archivePriceList(fx.db, ctx(), id)).toEqual({ ok: true })
    expect((await listPriceLists(fx.db)).map((l) => l.id)).not.toContain(id)

    const withArchived = await listPriceLists(fx.db, { includeArchived: true })
    expect(withArchived.find((l) => l.id === id)?.archived).toBe(true)

    await restorePriceList(fx.db, ctx(), id)
    expect((await listPriceLists(fx.db)).map((l) => l.id)).toContain(id)
  })

  it('keeps every rate that was ever on it', async () => {
    const id = await list('Festival')
    const p = await makeProduct(fx.db)
    await setItemPrice(fx.db, ctx(), { productId: p, priceListId: id, saleUnit: 'piece', rate: rupees(8) })

    await archivePriceList(fx.db, ctx(), id)
    await restorePriceList(fx.db, ctx(), id)

    /* The rates were never touched, which is what makes the button safe to
       press: a list that comes back comes back priced. A hard delete would
       have taken `item_prices` with it, and with them the `price_source_id`
       chain that answers "why was this one 8 rupees last March". */
    const back = (await listPriceLists(fx.db)).find((l) => l.id === id)
    expect(back?.priceCount).toBe(1)
  })

  it('refuses on the default list, which a walk-in customer needs', async () => {
    const theDefault = (await listPriceLists(fx.db)).find((l) => l.isDefault)!

    expect(await archivePriceList(fx.db, ctx(), theDefault.id)).toEqual({ ok: false, code: 'IS_DEFAULT' })
    expect((await listPriceLists(fx.db)).some((l) => l.isDefault)).toBe(true)
  })

  it('refuses while customers are still buying on it', async () => {
    const id = await list('Wholesale')
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerPriceList(fx.db, ctx(), customer, id)

    /* Hiding the list does not move them off it. It changes what they are
       charged, quietly, at the counter, tomorrow morning. */
    expect(await archivePriceList(fx.db, ctx(), id)).toEqual({ ok: false, code: 'IN_USE', customerCount: 1 })
    expect((await listPriceLists(fx.db)).map((l) => l.id)).toContain(id)
  })

  it('stops pricing anything, for a customer left pointing at it', async () => {
    /* The refusal above means the shop cannot get here by pressing buttons.
       This is the second lock: a customer row keeps its `price_list_id` when a
       list is archived -- that pointer is how restoring puts them back on
       their old rates -- so the list has to be checked where the rate is
       decided. Without it an archived list prices exactly as before, which is
       what `is_active` did for this table's whole life. */
    const id = await list('Wholesale')
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    await setItemPrice(fx.db, ctx(), { productId: p, priceListId: id, saleUnit: 'piece', rate: rupees(8) })

    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerPriceList(fx.db, ctx(), customer, id)

    const before = await pricingContextFor(fx.db, customer)
    expect(before.customerPriceListId).toBe(id)

    await fx.db.execute(
      `UPDATE price_lists SET deleted_at = '2026-03-01T00:00:00Z' WHERE id = ?`, [id])

    const after = await pricingContextFor(fx.db, customer)
    expect(after.customerPriceListId).toBeNull()

    const rate = await resolveLinePrice(fx.db, after, { productId: p, saleUnit: 'piece', qty: fromUnits(1) })
    expect(rate.rate).toBe(rupees(10))
  })

  it('keeps its name spoken for, and says so', async () => {
    const id = await list('Wholesale')
    await archivePriceList(fx.db, ctx(), id)

    /* `price_lists.name` is UNIQUE in the schema and the archived row is still
       there, so letting this through would have handed the shop a raw SQLite
       constraint error. It names the list instead, because the useful answer
       is to bring that one back rather than invent a second spelling. */
    const again = await createPriceList(fx.db, ctx(), { name: 'Wholesale' })
    expect(again).toEqual({ ok: false, code: 'NAME_TAKEN_ARCHIVED', priceListId: id })
  })
})

describe('writing a tiered price', () => {
  it('puts a rung on the ladder that the resolver then climbs', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9), minQty: fromUnits(10),
    })
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(8), minQty: fromUnits(50),
    })

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: null, customerPriceListId: null,
    })

    expect(resolvePrice(candidates, fromUnits(1)).rate).toBe(rupees(10))
    expect(resolvePrice(candidates, fromUnits(10)).rate).toBe(rupees(9))
    expect(resolvePrice(candidates, fromUnits(60)).rate).toBe(rupees(8))
  })

  it('replaces the same rung rather than making a second one', async () => {
    const p = await makeProduct(fx.db)
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9), minQty: fromUnits(10),
    })
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(7), minQty: fromUnits(10),
    })

    const prices = await listItemPrices(fx.db, { productId: p })
    expect(prices).toHaveLength(1)
    expect(prices[0]!.rate).toBe(rupees(7))
  })

  /* A rate against a unit the product does not sell in never resolves — it sits
     in the table looking as though it works. */
  it('refuses a unit the product does not sell in', async () => {
    const p = await makeProduct(fx.db)
    const result = await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'ream', rate: rupees(300),
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('UNKNOWN_UNIT')
  })

  it('accepts one once the unit exists', async () => {
    const p = await makeProduct(fx.db)
    await setUnits(fx.db, ctx(), p, [{ saleUnit: 'ream', baseUnits: fromUnits(500) }])
    const result = await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'ream', rate: rupees(300),
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a window that ends before it starts', async () => {
    const p = await makeProduct(fx.db)
    const result = await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9),
      validFrom: '2026-12-01', validTo: '2026-11-01',
    })
    expect(result.ok).toBe(false)
  })

  /* A submitted bill points at the row through price_source_id, and support has
     to answer "why was this ₹42" next March. */
  it('keeps a deleted rate readable rather than removing the row', async () => {
    const p = await makeProduct(fx.db)
    const made = await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9),
    })
    if (!made.ok) throw new Error(made.code)

    await removeItemPrice(fx.db, ctx(), made.itemPriceId)
    expect(await listItemPrices(fx.db, { productId: p })).toHaveLength(0)

    const row = await fx.db.get<{ rate: number }>(`SELECT rate FROM item_prices WHERE id = ?`, [made.itemPriceId])
    expect(row?.rate).toBe(rupees(9))
  })
})

describe('a price for one customer', () => {
  it('beats the list they are on', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: fx.seed.priceListId, saleUnit: 'piece', rate: rupees(9),
    })
    await setCustomerPrice(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rate: rupees(7),
    })

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: customer, customerPriceListId: null,
    })
    const resolved = resolvePrice(candidates, fromUnits(1))
    expect(resolved.rate).toBe(rupees(7))
    expect(resolved.source).toBe('customer_override')
  })

  it('is listed against the customer who has it', async () => {
    const p = await makeProduct(fx.db, { name: 'Notebook' })
    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerPrice(fx.db, ctx(), {
      customerId: customer, productId: p, saleUnit: 'piece', rate: rupees(7),
    })

    const rows = await listCustomerPrices(fx.db, { customerId: customer })
    expect(rows.map((r) => [r.customerName, r.productName])).toEqual([['Ramesh Stores', 'Notebook']])
  })

  it('replaces itself rather than stacking up', async () => {
    const p = await makeProduct(fx.db)
    const customer = await makeCustomer(fx.db)
    await setCustomerPrice(fx.db, ctx(), { customerId: customer, productId: p, saleUnit: 'piece', rate: rupees(7) })
    await setCustomerPrice(fx.db, ctx(), { customerId: customer, productId: p, saleUnit: 'piece', rate: rupees(6) })

    const rows = await listCustomerPrices(fx.db, { customerId: customer })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.rate).toBe(rupees(6))
  })
})

describe('putting a customer on a price list', () => {
  it('changes what they are charged', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(10) })
    const wholesale = await createPriceList(fx.db, ctx(), { name: 'Wholesale' })
    if (!wholesale.ok) throw new Error(wholesale.code)
    await setItemPrice(fx.db, ctx(), {
      productId: p, priceListId: wholesale.priceListId, saleUnit: 'piece', rate: rupees(8),
    })

    const customer = await makeCustomer(fx.db, 'Ramesh Stores')
    await setCustomerPriceList(fx.db, ctx(), customer, wholesale.priceListId)

    const row = await fx.db.get<{ price_list_id: string }>(
      `SELECT price_list_id FROM customers WHERE id = ?`, [customer],
    )
    expect(row?.price_list_id).toBe(wholesale.priceListId)

    const candidates = await loadPriceCandidates(fx.db, {
      productId: p, saleUnit: 'piece', defaultPriceListId: fx.seed.priceListId,
      customerId: customer, customerPriceListId: wholesale.priceListId,
    })
    expect(resolvePrice(candidates, fromUnits(1)).rate).toBe(rupees(8))
  })
})

describe('is the pack actually cheaper', () => {
  it('works out what one piece costs inside a bigger unit', () => {
    // A dozen at ₹110 is a shade over ₹9.16 a piece.
    expect(perBaseUnit(rupees(110), fromUnits(12))).toBe(917)
    expect(perBaseUnit(rupees(10), fromUnits(1))).toBe(rupees(10))
  })
})
