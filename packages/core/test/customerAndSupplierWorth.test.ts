import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { customerProfit, customerItems } from '../src/repos/customerHistory.js'
import { supplierItems, createSupplier } from '../src/services/suppliers.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * What a customer is worth, and what a supplier has been charging.
 *
 * The Credit screen has always been able to say what a customer *owes*.
 * Nothing anywhere could say what the shop *makes* on them, and that is the
 * figure a discount is argued over: somebody buying fifty thousand rupees of
 * goods at four points is a different customer from one buying twenty at
 * thirty, and they look identical on every screen that existed.
 *
 * Both sides are computable from what is already written down, because every
 * sale stamps its own cost into the ledger as it leaves. Nothing here estimates
 * anything.
 */

let fx: Fixture
let cheap: string
let dear: string
let customer: string
let today: string

beforeEach(async () => {
  fx = await freshDb()
  // Sells at 100, costs 90 — the line a shop competes on.
  cheap = await makeProduct(fx.db, { name: 'Rice 1kg', baseRate: rupees(100), taxRateBp: 0 })
  // Sells at 100, costs 40.
  dear = await makeProduct(fx.db, { name: 'Soap', baseRate: rupees(100), taxRateBp: 0 })
  customer = await makeCustomer(fx.db, 'Priya Traders')
  today = businessDate(new Date())
})

afterEach(async () => { await fx.db.close() })

const range = () => ({ from: today, to: today })

async function receive(
  productId: string, units: number, unitCost?: Money, supplierId?: string,
) {
  const e = await createStockEntry(fx.db, {
    entryType: 'purchase',
    ...(supplierId ? { supplierId } : {}),
    lines: [{
      productId, qty: fromUnits(units),
      ...(unitCost === undefined ? {} : { unitCost }),
    }],
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  const done = await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
}

async function sellTo(who: string | null, productId: string, units: number) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(who ? { customerId: who } : {}),
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const r = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(r.code)
}

describe('what a customer is worth', () => {
  it('is revenue less what their goods cost the shop', async () => {
    await receive(cheap, 100, rupees(90))
    await sellTo(customer, cheap, 10)

    const p = await customerProfit(fx.db, customer, range())
    expect(p.bills).toBe(1)
    expect(p.revenue).toBe(rupees(1000))
    expect(p.cost).toBe(rupees(900))
    expect(p.margin).toBe(rupees(100))
    expect(p.marginBp, 'ten percent').toBe(1000)
  })

  it('counts only this customer, not the counter takings around them', async () => {
    await receive(cheap, 100, rupees(90))
    await sellTo(customer, cheap, 10)
    await sellTo(null, cheap, 40)

    expect((await customerProfit(fx.db, customer, range())).revenue).toBe(rupees(1000))
  })

  it('counts a bill once however many lines it has', async () => {
    /* The reason revenue and cost are gathered in two passes. The ledger has a
       row per issue and the bill a row per line; joining them first multiplies
       one by the other and every figure comes out too large. */
    await receive(cheap, 100, rupees(90))
    await receive(dear, 100, rupees(40))

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId: customer,
      lines: [
        { productId: cheap, qty: fromUnits(10) },
        { productId: dear, qty: fromUnits(10) },
      ],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })

    const p = await customerProfit(fx.db, customer, range())
    expect(p.bills, 'one bill, two lines').toBe(1)
    expect(p.revenue, 'and not twice the revenue').toBe(rupees(2000))
    expect(p.cost, 'nor twice the cost').toBe(rupees(1300))
  })

  it('says how many of their purchases it could not price', async () => {
    await receive(cheap, 100)
    await sellTo(customer, cheap, 5)

    const p = await customerProfit(fx.db, customer, range())
    expect(p.uncostedLines).toBe(1)
  })

  it('is all zeros for somebody who has never bought anything', async () => {
    const other = await makeCustomer(fx.db, 'Nobody')
    expect(await customerProfit(fx.db, other, range())).toMatchObject({
      bills: 0, revenue: 0, cost: 0, margin: 0,
    })
  })
})

describe('what a customer buys', () => {
  it('is ordered by what the shop makes, not by what they spend', async () => {
    /* The two disagree often enough to be worth the choice. Here the customer
       spends the same on both, and only one of them is worth having. */
    await receive(cheap, 100, rupees(90))
    await receive(dear, 100, rupees(40))
    await sellTo(customer, cheap, 10)
    await sellTo(customer, dear, 10)

    const items = await customerItems(fx.db, customer, range())
    expect(items).toHaveLength(2)
    expect(items[0]!.name, 'sixty rupees a unit beats ten').toBe('Soap')
    expect(items[0]!.margin).toBe(rupees(600))
    expect(items[1]!.margin).toBe(rupees(100))
  })

  it('reports each line as a share of its own revenue', async () => {
    await receive(dear, 100, rupees(40))
    await sellTo(customer, dear, 10)

    const [item] = await customerItems(fx.db, customer, range())
    expect(item!.marginBp).toBe(6000)
    expect(item!.qty).toBe(fromUnits(10))
  })
})

describe('what a supplier sends', () => {
  it('groups deliveries by item, with what has been spent on each', async () => {
    const s = await createSupplier(fx.db, { name: 'Acme', actorId: fx.adminId })
    if (!s.ok) throw new Error(s.code)

    await receive(cheap, 10, rupees(90), s.supplierId)
    await receive(cheap, 20, rupees(90), s.supplierId)
    await receive(dear, 5, rupees(40), s.supplierId)

    const items = await supplierItems(fx.db, s.supplierId)
    const rice = items.find((i) => i.name === 'Rice 1kg')!
    expect(rice.deliveries, 'two deliveries of the same item').toBe(2)
    expect(rice.qty).toBe(fromUnits(30))
    expect(rice.spent).toBe(rupees(2700))
  })

  it('shows the first and last rate, so a rise can be seen', async () => {
    /* Two numbers a person can check against their own paperwork, rather than
       one computed trend they have to take on trust. */
    const s = await createSupplier(fx.db, { name: 'Acme', actorId: fx.adminId })
    if (!s.ok) throw new Error(s.code)

    await receive(cheap, 10, rupees(90), s.supplierId)
    await fx.db.execute(`UPDATE stock_entries SET posting_date = '2026-01-01'`)
    await receive(cheap, 10, rupees(95), s.supplierId)

    const [rice] = await supplierItems(fx.db, s.supplierId)
    expect(rice!.firstRate).toBe(rupees(90))
    expect(rice!.lastRate).toBe(rupees(95))
  })

  it('leaves out another supplier entirely', async () => {
    const a = await createSupplier(fx.db, { name: 'Acme', actorId: fx.adminId })
    const b = await createSupplier(fx.db, { name: 'Other', actorId: fx.adminId })
    if (!a.ok || !b.ok) throw new Error('setup')

    await receive(cheap, 10, rupees(90), a.supplierId)
    await receive(dear, 10, rupees(40), b.supplierId)

    const items = await supplierItems(fx.db, a.supplierId)
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('Rice 1kg')
  })

  it('is empty for a supplier nothing has come from', async () => {
    const s = await createSupplier(fx.db, { name: 'Never used', actorId: fx.adminId })
    if (!s.ok) throw new Error(s.code)
    expect(await supplierItems(fx.db, s.supplierId)).toHaveLength(0)
  })
})
