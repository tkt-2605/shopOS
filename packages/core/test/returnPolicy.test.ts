import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { processReturn, previewReturn, cancelReturn, listReturns } from '../src/services/returns.js'
import { postMovement, currentStock } from '../src/services/stock.js'
import { setSetting } from '../src/services/bootstrap.js'
import { customerOutstanding } from '../src/services/payments.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId, qtyChange: fromUnits(units), unitCost: rupees(50),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
}

async function loyaltyOn(earnOnCreditPortion = false): Promise<void> {
  await setSetting(fx.db, 'loyalty_program', JSON.stringify({
    enabled: true,
    tiers: [{ minSpend: 0, pointsPerHundred: 1 }],
    expiryDays: 365, pointValue: 100,
    earnOnCreditPortion, minBillForEarn: 0, maxRedeemFractionBp: 10_000,
  }))
}

interface Sale { billId: string; itemIds: string[]; grandTotal: Money }

async function sell(
  lines: { productId: string; units: number }[],
  opts: {
    customerId?: string
    billDiscount?: Money
    redeemPoints?: number
    method?: 'cash' | 'credit'
  } = {},
): Promise<Sale> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    ...(opts.billDiscount ? { billDiscount: opts.billDiscount } : {}),
    lines: lines.map((l) => ({ productId: l.productId, qty: fromUnits(l.units) })),
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(`draft: ${draft.code}`)

  const pointsValue = (opts.redeemPoints ?? 0) * 100
  const due = (draft.grandTotal - pointsValue) as Money
  const submitted = await submitBill(fx.db, {
    billId: draft.billId,
    payments: due > 0 ? [{ method: opts.method ?? 'cash', amount: due }] : [],
    ...(opts.redeemPoints ? { redeemPoints: opts.redeemPoints } : {}),
    actorId: fx.adminId,
  })
  if (!submitted.ok) throw new Error(`submit: ${submitted.code}`)

  const items = await fx.db.query<{ id: string }>(
    `SELECT id FROM bill_items WHERE bill_id = ? ORDER BY idx`, [draft.billId],
  )
  return { billId: draft.billId, itemIds: items.map((i) => i.id), grandTotal: draft.grandTotal }
}

describe('what a discounted bill refunds', () => {
  /* The one that costs a shop real money if it is wrong: refunding the list
     price on a bill that was discounted gives the discount away twice. */
  it('refunds what was paid, not what was on the shelf', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const sale = await sell([{ productId: p, units: 10 }], { billDiscount: rupees(200) })
    expect(sale.grandTotal).toBe(rupees(800))

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(10) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(done.ok && done.refundTotal).toBe(rupees(800))
  })

  it('takes the discount off a part return in the same proportion', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const sale = await sell([{ productId: p, units: 10 }], { billDiscount: rupees(200) })

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(4) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(done.ok && done.refundTotal).toBe(rupees(320))
  })

  /* The discount is not re-spread over what the customer keeps: that invoice has
     been printed, and possibly filed against tax. */
  it('leaves the kept lines priced as they were billed', async () => {
    const a = await makeProduct(fx.db, { name: 'A', baseRate: rupees(100), taxRateBp: 0 })
    const b = await makeProduct(fx.db, { name: 'B', baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, a, 10)
    await stockUp(fx.db, b, 10)
    const sale = await sell([{ productId: a, units: 5 }, { productId: b, units: 5 }], {
      billDiscount: rupees(100),
    })

    await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(5) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })

    const kept = await fx.db.get<{ line_total: number }>(
      `SELECT line_total FROM bill_items WHERE id = ?`, [sale.itemIds[1]!],
    )
    expect(kept?.line_total).toBe(rupees(450))
  })

  it('an item that takes no discount refunds its full rate', async () => {
    const thin = await makeProduct(fx.db, { name: 'Recharge', baseRate: rupees(100), taxRateBp: 0, discountBlocked: true })
    const other = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, thin, 10)
    await stockUp(fx.db, other, 10)
    const sale = await sell([{ productId: thin, units: 5 }, { productId: other, units: 5 }], {
      billDiscount: rupees(100),
    })

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(5) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(done.ok && done.refundTotal).toBe(rupees(500))
  })
})

describe('a bill settled partly with points', () => {
  beforeEach(loyaltyOn)

  async function customerWithPoints(points: number): Promise<string> {
    const c = await makeCustomer(fx.db)
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO loyalty_entries (id, customer_id, points, earned_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [newId(), c, points, now, now],
    )
    return c
  }

  /* ₹1,000 of goods settled with ₹900 and 100 points. Half comes back: ₹450 and
     50 points, not ₹500 of either. */
  it('hands back each currency in the share it paid', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await customerWithPoints(100)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c, redeemPoints: 100 })

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(5) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.refundTotal).toBe(rupees(500))
    expect(done.refundCash).toBe(rupees(450))
    expect(done.pointsRestored).toBe(50)
  })

  it('puts the points back where they came from, with their own expiry', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await customerWithPoints(100)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c, redeemPoints: 100 })

    await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(5) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })

    const entry = await fx.db.get<{ points: number; consumed: number }>(
      `SELECT points, consumed FROM loyalty_entries WHERE customer_id = ? AND bill_id IS NULL`, [c],
    )
    expect(entry?.consumed).toBe(50)
  })

  it('takes only what the drawer actually paid out', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await customerWithPoints(100)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c, redeemPoints: 100 })

    const preview = await previewReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(10) }],
    })
    expect(preview.ok && preview.cash).toBe(rupees(900))
    expect(preview.ok && preview.pointsRestored).toBe(100)
  })
})

describe('a refund put back on the khata', () => {
  it('takes the money off what the customer owes', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c, method: 'credit' })
    expect(await customerOutstanding(fx.db, c)).toBe(rupees(1000))

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(4) }],
      refundMethod: 'credit', actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.creditNoteDocNo).not.toBeNull()

    expect(await customerOutstanding(fx.db, c)).toBe(rupees(600))
  })

  /* There is no store-credit wallet in this product, so a refund with nothing to
     come off would go nowhere and be found by nobody. */
  it('is refused when there is nothing owed to take it off', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c })

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(4) }],
      refundMethod: 'credit', actorId: fx.adminId,
    })
    expect(done.ok).toBe(false)
    if (!done.ok) expect(done.code).toBe('NOTHING_TO_CREDIT')
  })

  it('leaves no half-made return behind when it refuses', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c })

    await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(4) }],
      refundMethod: 'credit', actorId: fx.adminId,
    })
    expect(await listReturns(fx.db, sale.billId)).toHaveLength(0)
  })
})

describe('cancelling a return', () => {
  // Earning on credit as well, so one cancellation exercises the khata and the
  // points together rather than needing two bills to do it.
  beforeEach(() => loyaltyOn(true))

  it('takes back the stock, the money and the points together', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)
    const sale = await sell([{ productId: p, units: 10 }], { customerId: c, method: 'credit' })

    const earned = await fx.db.get<{ points: number }>(
      `SELECT points FROM loyalty_entries WHERE bill_id = ?`, [sale.billId],
    )
    expect(earned?.points).toBe(10)

    const done = await processReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(10) }],
      refundMethod: 'credit', actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)

    expect(await customerOutstanding(fx.db, c)).toBe(0)
    expect(toUnits(await currentStock(fx.db, p))).toBe(20)

    await cancelReturn(fx.db, { returnId: done.returnId, actorId: fx.adminId })

    expect(await customerOutstanding(fx.db, c)).toBe(rupees(1000))
    expect(toUnits(await currentStock(fx.db, p))).toBe(10)

    const after = await fx.db.get<{ points: number; cancelled_at: string | null }>(
      `SELECT points, cancelled_at FROM loyalty_entries WHERE bill_id = ?`, [sale.billId],
    )
    expect(after?.points).toBe(10)
    expect(after?.cancelled_at).toBeNull()
  })
})

describe('what the counter is shown before it commits', () => {
  it('says what will be handed over, and writes nothing', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const sale = await sell([{ productId: p, units: 10 }], { billDiscount: rupees(200) })

    const preview = await previewReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(5) }],
    })
    expect(preview.ok && preview.cash).toBe(rupees(400))
    expect(preview.ok && preview.lines[0]?.productName).toBe('Test Product')

    expect(await listReturns(fx.db, sale.billId)).toHaveLength(0)
    expect(toUnits(await currentStock(fx.db, p))).toBe(10)
  })

  it('refuses an item the shop does not take back, before anything happens', async () => {
    const p = await makeProduct(fx.db, { name: 'Cut cloth', baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const sale = await sell([{ productId: p, units: 5 }])
    await fx.db.execute(`UPDATE products SET return_blocked = 1 WHERE id = ?`, [p])

    const preview = await previewReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemIds[0]!, qty: fromUnits(1) }],
    })
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.code).toBe('RETURN_BLOCKED')
  })
})
