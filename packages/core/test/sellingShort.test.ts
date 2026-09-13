import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits, qty } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { currentStock, postMovement, recomputeStock, stockValue, productValuation } from '../src/services/stock.js'
import { loadStockPolicy, setStockPolicy } from '../src/services/features.js'
import { movingAverage } from '../src/domain/valuation.js'
import { grossMargin } from '../src/repos/reports.js'
import { listShortfalls, countShortfalls } from '../src/repos/shortfalls.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Selling what the count says is not there.
 *
 * Every shop's opening counts are wrong, and a till that refuses the item in the
 * customer's hand is a till that gets worked around with a paper book. So the
 * counter can go on — and the books have to stay honest while it does, which is
 * the harder half and the reason these are one theme rather than two.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ctx = () => ({ actorId: fx.adminId })

async function receive(db: SqlDriver, productId: string, units: number, cost: Money): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: cost,
      voucherType: 'opening',
      voucherId: `open-${Math.random()}`,
      postingDate: businessDate(),
    })
  })
}

async function sell(productId: string, units: number, rate = rupees(100)) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId, qty: fromUnits(units), rateOverride: rate }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  return submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
}

describe('what a shop starts on', () => {
  /* Refusing was never a decision anybody made — it was the only branch that had
     been written. A shop that upgrades should not keep a behaviour it was never
     offered. */
  it('warns rather than refuses, without anyone choosing', async () => {
    expect(await loadStockPolicy(fx.db)).toBe('warn')
  })
})

describe('a sale with nothing on the shelf', () => {
  it('goes through, and says what was short', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(60))

    const r = await sell(p, 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.shortfalls).toHaveLength(1)
    expect(r.shortfalls[0]?.available).toBe(fromUnits(2))
    expect(r.shortfalls[0]?.required).toBe(fromUnits(5))
  })

  it('takes the quantity below zero rather than stopping at it', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(60))
    await sell(p, 5)
    expect(toUnits(await currentStock(fx.db, p))).toBe(-3)
  })

  it('says nothing at all when the shop has asked for quiet', async () => {
    await setStockPolicy(fx.db, ctx(), 'allow')
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    const r = await sell(p, 5)
    expect(r.ok).toBe(true)
    // The sale is identical; only what the counter is told differs, and that is
    // the screen's business rather than this layer's.
    expect(toUnits(await currentStock(fx.db, p))).toBe(-5)
  })

  it('is written down against the shop, not against the till', async () => {
    await setStockPolicy(fx.db, ctx(), 'block')
    const row = await fx.db.get<{ action: string; diff: string }>(
      `SELECT action, diff FROM audit_log WHERE entity = 'settings' AND entity_id = 'stock_policy'`,
    )
    expect(row?.action).toBe('update')
    expect(row?.diff).toContain('Selling below the count')
  })
})

describe('what the goods cost when there were none', () => {
  /* The alternative is no cost at all, which reports the sale as pure profit —
     a worse lie than an old rate. */
  it('leaves at the last rate the item was known at', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(60))
    await sell(p, 2)          // clears the shelf at ₹60
    await sell(p, 3)          // sold from nothing

    const rows = await fx.db.query<{ unit_cost: number | null; qty_change: number }>(
      `SELECT unit_cost, qty_change FROM stock_ledger WHERE product_id = ? ORDER BY rowid`, [p],
    )
    const lastSale = rows[rows.length - 1]!
    expect(lastSale.qty_change).toBe(fromUnits(-3))
    expect(lastSale.unit_cost).toBe(rupees(60))
  })

  it('keeps the margin report honest instead of counting it as free', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100), taxRateBp: 0 })
    await receive(fx.db, p, 2, rupees(60))
    await sell(p, 4, rupees(100))

    const today = businessDate()
    const margin = await grossMargin(fx.db, { from: today, to: today })
    // Four sold at ₹100, every one of them costing ₹60 — including the two the
    // shop did not have.
    expect(margin.revenue).toBe(rupees(400))
    expect(margin.cost).toBe(rupees(240))
    expect(margin.uncostedLines).toBe(0)
  })
})

describe('the delivery that fills the hole', () => {
  /* The bug this replaces: the whole delivery's value landed on the survivors,
     so two units that cost ₹12 each were valued at ₹30 each. */
  it('values what is left over at what it cost, not at what the whole lorry cost', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(10))
    await sell(p, 5)                       // three short
    await receive(fx.db, p, 5, rupees(12)) // two left over

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(2)
    expect(held.unitCost).toBe(rupees(12))
    expect(held.value).toBe(rupees(24))
  })

  it('is worth nothing while the hole is only part filled', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(10))
    await sell(p, 7)                       // five short
    await receive(fx.db, p, 2, rupees(12)) // three still short

    const held = await stockValue(fx.db, p)
    expect(toUnits(held.qty)).toBe(-3)
    expect(held.value).toBe(0)
  })
})

describe('the cache and the ledger', () => {
  /* If these two ever disagree, something wrote stock outside the one module
     that is allowed to. Going below zero used to make them disagree for ever,
     because the cache floors the running value and a sum does not. */
  it('still agree after a shop has sold short and been restocked', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(10))
    await sell(p, 5)
    await receive(fx.db, p, 5, rupees(12))
    await sell(p, 1)

    expect(await recomputeStock(fx.db)).toEqual([])
  })

  it('rebuild to the same answer the counter arrived at', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 3, rupees(20))
    await sell(p, 8)
    await receive(fx.db, p, 10, rupees(25))

    const live = await stockValue(fx.db, p)
    const replayed = await productValuation(fx.db, p)
    expect(replayed.qtyOnHand).toBe(live.qty)
    expect(replayed.totalValue).toBe(live.value)
  })
})

describe('the rule on its own', () => {
  const m = (q: number, cost: number | null) => ({
    qtyChange: fromUnits(q), unitCost: cost as Money | null,
  })

  it('holds nothing back for goods the shop never had', () => {
    const v = movingAverage([m(2, rupees(10)), m(-5, rupees(10))])
    expect(toUnits(v.qtyOnHand)).toBe(-3)
    expect(v.totalValue).toBe(0)
  })

  it('remembers the last rate so an overdrawn item still has one', () => {
    const v = movingAverage([m(2, rupees(10)), m(-5, rupees(10))])
    expect(v.lastKnownCost).toBe(rupees(10))
    // Nothing on the shelf, so nothing to average.
    expect(v.averageCost).toBe(0)
  })

  it('rebases on the receipt that clears the shortfall', () => {
    const v = movingAverage([m(2, rupees(10)), m(-5, rupees(10)), m(5, rupees(12))])
    expect(toUnits(v.qtyOnHand)).toBe(2)
    expect(v.averageCost).toBe(rupees(12))
    expect(v.totalValue).toBe(rupees(24))
  })

  it('leaves an ordinary shop exactly where it was', () => {
    const v = movingAverage([m(10, rupees(10)), m(10, rupees(20)), m(-5, null)])
    expect(toUnits(v.qtyOnHand)).toBe(15)
    expect(v.averageCost).toBe(rupees(15))
  })

  it('never reports a negative quantity as worth something', () => {
    const v = movingAverage([m(-4, rupees(10))])
    expect(toUnits(v.qtyOnHand)).toBe(-4)
    expect(v.totalValue).toBe(0)
    expect(v.averageCost).toBe(0)
  })

  it('does not divide by a quantity of zero', () => {
    const v = movingAverage([m(2, rupees(10)), m(-2, rupees(10)), m(-1, null)])
    expect(toUnits(v.qtyOnHand)).toBe(-1)
    expect(Number.isFinite(v.totalValue)).toBe(true)
    expect(Number.isFinite(v.averageCost)).toBe(true)
    expect(v.qtyOnHand).toBe(qty(-10_000))
  })
})

describe('finding the counts that need fixing', () => {
  /* Allowing a shop to sell below its count is only safe if it can find the
     items again. Without this the number stays wrong for ever, which is worse
     than the refusal it replaced — at least a refusal was noticed. */
  it('lists what has gone below zero, worst first', async () => {
    const pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    const pad = await makeProduct(fx.db, { name: 'Pad', baseRate: rupees(100) })
    const ink = await makeProduct(fx.db, { name: 'Ink', baseRate: rupees(100) })
    await receive(fx.db, ink, 10, rupees(50))

    await sell(pen, 3)
    await sell(pad, 9)

    const { rows, count } = await listShortfalls(fx.db)
    expect(count).toBe(2)
    expect(rows.map((r) => r.name)).toEqual(['Pad', 'Pen'])
    expect(toUnits(rows[0]!.onHand)).toBe(-9)
  })

  it('leaves out an item that is merely empty', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 2, rupees(50))
    await sell(p, 2)
    expect(await countShortfalls(fx.db)).toBe(0)
  })

  it('says how much was sold against nothing, and when it started', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await receive(fx.db, p, 1, rupees(50))
    await sell(p, 4)

    const row = (await listShortfalls(fx.db)).rows[0]!
    expect(toUnits(row.soldShort)).toBe(4)
    expect(row.shortSince).toBe(businessDate())
    expect(row.lastReceivedOn).toBe(businessDate())
  })

  it('drops off the list once the delivery arrives', async () => {
    const p = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100) })
    await sell(p, 3)
    expect(await countShortfalls(fx.db)).toBe(1)

    await receive(fx.db, p, 5, rupees(50))
    expect(await countShortfalls(fx.db)).toBe(0)
  })
})
