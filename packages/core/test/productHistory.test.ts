import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { productHistory, productProfit, noCostBasis } from '../src/repos/productHistory.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'

/**
 * Reading one product's life out of the ledger.
 *
 * All of this has been in `stock_ledger` since Phase 0 and nothing could read
 * it. Inventory had a Cost button that gave the current valuation as a single
 * number with no way to see how it got there.
 *
 * That gap is worse than a missing screen, because the average cost is *derived*
 * rather than stored -- `domain/valuation.ts` argues why, and the argument is
 * right -- and a derived figure a shopkeeper cannot take apart is one they have
 * to either trust or ignore. "Why does this say 272.73 when I have always paid
 * 300" has an answer and it is in these rows.
 */

let fx: Fixture
let product: string
let today: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  today = businessDate(new Date())
})

afterEach(async () => { await fx.db.close() })

async function stockIn(units: number, unitCost?: Money) {
  const e = await createStockEntry(fx.db, {
    entryType: 'purchase',
    lines: [{
      productId: product,
      qty: fromUnits(units),
      ...(unitCost === undefined ? {} : { unitCost }),
    }],
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  const done = await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
  return done.docNo
}

async function sell(units: number) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId: product, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const r = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(r.code)
  return draft.grandTotal
}

const range = () => ({ from: today, to: today })

describe('the movements of one product', () => {
  it('shows what came in and what went out, newest first', async () => {
    await stockIn(100, rupees(60))
    await sell(10)

    const rows = await productHistory(fx.db, product)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.voucherType, 'newest first').toBe('bill')
    expect(rows[0]!.qtyChange, 'an issue is negative').toBe(fromUnits(-10))
    expect(rows[1]!.qtyChange).toBe(fromUnits(100))
  })

  it('names the document each movement came from, so a row leads to paper', async () => {
    /* The doc number lives in a different table per voucher type. Without it a
       history is a list of numbers with nothing to check them against. */
    const entryNo = await stockIn(50, rupees(60))
    await sell(5)

    const rows = await productHistory(fx.db, product)
    expect(rows.find((r) => r.voucherType === 'stock_entry')?.docNo).toBe(entryNo)
    expect(rows.find((r) => r.voucherType === 'bill')?.docNo).toMatch(/^B/)
  })

  it('says which kind of stock entry it was', async () => {
    await stockIn(20, rupees(60))
    const e = await createStockEntry(fx.db, {
      entryType: 'wastage',
      lines: [{ productId: product, qty: fromUnits(3), unitCost: rupees(60) }],
      actorId: fx.adminId,
    })
    if (!e.ok) throw new Error(e.code)
    await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })

    const rows = await productHistory(fx.db, product)
    expect(rows[0]!.entryType, 'a purchase and a wastage are both stock entries').toBe('wastage')
    expect(rows[0]!.qtyChange).toBe(fromUnits(-3))
  })

  it('reports the balance as it was recorded, not as recomputed now', async () => {
    /* The column answers "what did the shelf say at that moment". A running
       total worked out today would instead say what today's arithmetic thinks
       should have happened -- and the two differing is exactly the drift
       `recomputeStock` exists to find. A history that hides it cannot be used
       to investigate it. */
    await stockIn(100, rupees(60))
    await sell(30)

    const rows = await productHistory(fx.db, product)
    expect(rows[0]!.balanceQty).toBe(fromUnits(70))
    expect(rows[1]!.balanceQty).toBe(fromUnits(100))
  })

  it('values each movement, and leaves it null where no rate was ever given', async () => {
    await stockIn(10)

    const [row] = await productHistory(fx.db, product)
    expect(row!.unitCost, 'nothing to record').toBeNull()
    expect(row!.value, 'and so nothing to value it at — not zero').toBeNull()
  })

  it("shows this till's shelf count, and not another till's as if it were", async () => {
    /* 060. Each row's balance is the running total on the till that posted it;
       a movement that arrived from another counter carries that counter's. */
    await stockIn(10, rupees(60))
    await fx.db.execute(
      `INSERT INTO stock_ledger (id, product_id, posting_date, qty_change, unit_cost, balance_qty,
                                 voucher_type, voucher_id, created_at, device_id)
       VALUES (?, ?, ?, ?, NULL, 999999, 'bill', ?, ?, 'another-till')`,
      [newId(), product, today, -fromUnits(1), newId(), new Date().toISOString()],
    )
    const rows = await productHistory(fx.db, product)
    const theirs = rows.find((r) => r.balanceQty === null)
    const mine = rows.find((r) => r.qtyChange > 0)
    expect(theirs, "the other till's movement is listed, without a balance").toBeDefined()
    expect(mine?.balanceQty).toBe(fromUnits(10))
  })

  it('values a sale by what actually left the shelf, not the rate times the quantity', async () => {
    /* 058. What a sale took plus what is left on the shelf is what was
       bought -- to the paisa, because both are the stored value moving, not a
       rate multiplied back out and rounded on each side. */
    await stockIn(3, 333 as Money)
    await sell(1)
    const [sale] = await productHistory(fx.db, product)
    const shelf = await fx.db.get<{ stock_value: number }>(
      'SELECT stock_value FROM product_stock WHERE product_id = ?', [product])
    expect(sale!.value! + shelf!.stock_value).toBe(await fx.db.get<{ v: number }>(
      'SELECT value_change AS v FROM stock_ledger WHERE qty_change > 0').then((r) => r!.v))
  })
})

describe('what one product earned', () => {
  it('is revenue less what the goods cost as they left', async () => {
    await stockIn(100, rupees(60))
    const takings = await sell(10)

    const p = await productProfit(fx.db, product, range())
    expect(p.qtySold).toBe(fromUnits(10))
    expect(p.revenue).toBe(takings)
    expect(p.cost, 'ten units at sixty').toBe(rupees(600))
    expect(p.margin).toBe((takings - rupees(600)) as Money)
  })

  it('reports the margin in basis points of revenue', async () => {
    await stockIn(100, rupees(60))
    await sell(10)

    const p = await productProfit(fx.db, product, range())
    expect(p.marginBp, 'sells at 100, cost 60, so 40%').toBe(4000)
  })

  it('counts the sales it could not price rather than calling them free', async () => {
    /* The honest half of the answer to "there is no default cost price". A sale
       whose issue carried no rate makes the margin look larger than it is, and a
       percentage that quietly leaves it out is worse than one standing beside
       the number of lines it could not price. */
    await stockIn(50)
    await sell(5)

    const p = await productProfit(fx.db, product, range())
    expect(p.uncostedLines).toBe(1)
    expect(p.cost, 'no rate to cost it at').toBe(0)
  })

  it('is all zeros for a product nothing has happened to', async () => {
    const p = await productProfit(fx.db, product, range())
    expect(p).toMatchObject({ qtySold: 0, revenue: 0, cost: 0, margin: 0, marginBp: 0 })
  })
})

describe('items with no cost basis at all', () => {
  it('lists an item that has never been received with a rate', async () => {
    await stockIn(10)

    const rows = await noCostBasis(fx.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.productId).toBe(product)
    expect(rows[0]!.receipts).toBe(1)
  })

  it('leaves out an item that has been priced at least once', async () => {
    /* A blank cost falls back to the last rate known for the item, which is a
       reasonable guess and usually right. The item this report is looking for is
       the one with nothing to fall back to. */
    await stockIn(10, rupees(60))
    await stockIn(10)

    expect(await noCostBasis(fx.db)).toHaveLength(0)
  })

  it('asks whether a rate was ever recorded, not whether the value is zero', async () => {
    /* A shop that sold everything it had is at zero value legitimately, and must
       not appear here. */
    await stockIn(10, rupees(60))
    await sell(10)

    expect(await noCostBasis(fx.db)).toHaveLength(0)
  })
})
