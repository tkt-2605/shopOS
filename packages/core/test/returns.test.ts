import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, add, type Money } from '../src/money.js'
import { fromUnits, toUnits, qty } from '../src/quantity.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn, cancelReturn, returnableQty } from '../src/services/returns.js'
import { currentStock, postMovement, recomputeStock } from '../src/services/stock.js'
import { setSetting } from '../src/services/bootstrap.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

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

async function soldBill(productId: string, units: number, customerId?: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(customerId ? { customerId } : {}),
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const submitted = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!submitted.ok) throw new Error('submit failed')
  const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])
  return { billId: draft.billId, itemId: item!.id, grandTotal: draft.grandTotal }
}

describe('full return', () => {
  it('refunds the line exactly and restores stock', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, p, 10)
    const sale = await soldBill(p, 3)
    expect(toUnits(await currentStock(fx.db, p))).toBe(7)

    const ret = await createReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemId, qty: fromUnits(3) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
    })
    expect(ret.ok).toBe(true)
    if (!ret.ok) return
    expect(ret.refundTotal).toBe(sale.grandTotal)

    const submitted = await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(submitted.ok).toBe(true)
    if (submitted.ok) expect(submitted.docNo).toMatch(/^CRN\/MR\//)

    expect(toUnits(await currentStock(fx.db, p))).toBe(10)
  })

  it('reverses the same tax the invoice charged', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, p, 10)
    const sale = await soldBill(p, 2)

    const billTax = await fx.db.get<{ cgst: number; sgst: number }>(
      `SELECT cgst_amount AS cgst, sgst_amount AS sgst FROM bill_items WHERE bill_id = ?`, [sale.billId],
    )

    const ret = await createReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    const retTax = await fx.db.get<{ cgst: number; sgst: number }>(
      `SELECT cgst_amount AS cgst, sgst_amount AS sgst FROM sales_return_items WHERE return_id = ?`, [ret.returnId],
    )
    expect(retTax).toEqual(billTax)
  })
})

describe('partial returns', () => {
  it('refunds proportionally', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 1800 })
    await stockUp(fx.db, p, 20)
    const sale = await soldBill(p, 10)

    const ret = await createReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemId, qty: fromUnits(3) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(ret.ok).toBe(true)
    if (ret.ok) expect(ret.refundTotal).toBe(rupees(300))
  })

  it('successive partials sum back to the original line total', async () => {
    // 3 lots out of 7 at an amount that does not divide evenly.
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 20)
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(7) }],
      billDiscount: rupees(33.33),
      actorId: fx.adminId,
    })
    if (!draft.ok) return
    await submitBill(fx.db, { billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId })
    const item = await fx.db.get<{ id: string; line_total: number }>(
      `SELECT id, line_total FROM bill_items WHERE bill_id = ?`, [draft.billId],
    )

    const refunds: Money[] = []
    for (const units of [2, 2, 3]) {
      const ret = await createReturn(fx.db, {
        billId: draft.billId,
        lines: [{ billItemId: item!.id, qty: fromUnits(units) }],
        refundMethod: 'cash', actorId: fx.adminId,
      })
      if (!ret.ok) throw new Error(`return failed: ${ret.code}`)
      await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
      refunds.push(ret.refundTotal)
    }

    expect(add(...refunds)).toBe(item!.line_total as Money)
    expect(await returnableQty(fx.db, item!.id)).toBe(qty(0))
  })

  it('refuses to return more than was sold', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 20)
    const sale = await soldBill(p, 5)

    const ret = await createReturn(fx.db, {
      billId: sale.billId,
      lines: [{ billItemId: sale.itemId, qty: fromUnits(6) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(ret.ok).toBe(false)
    if (!ret.ok && ret.code === 'EXCEEDS_RETURNABLE') expect(ret.returnable).toBe(fromUnits(5))
  })

  it('refuses a second return that would exceed the remainder', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 20)
    const sale = await soldBill(p, 5)

    const first = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(4) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!first.ok) return
    await submitReturn(fx.db, { returnId: first.returnId, actorId: fx.adminId })

    const second = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('EXCEEDS_RETURNABLE')
  })
})

describe('return guards', () => {
  it('refuses to return against a draft bill', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) return
    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])

    const ret = await createReturn(fx.db, {
      billId: draft.billId, lines: [{ billItemId: item!.id, qty: fromUnits(1) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(ret.ok).toBe(false)
    if (!ret.ok) expect(ret.code).toBe('BILL_NOT_SUBMITTED')
  })

  it('respects a product marked non-returnable', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const sale = await soldBill(p, 1)
    await fx.db.execute(`UPDATE products SET return_blocked = 1 WHERE id = ?`, [p])

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    expect(ret.ok).toBe(false)
    if (!ret.ok) expect(ret.code).toBe('RETURN_BLOCKED')
  })

  it('blocks cancelling a bill that has a submitted return against it', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const sale = await soldBill(p, 2)
    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })

    const cancelled = await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.code).toBe('HAS_RETURNS')
  })
})

describe('cancelling a return', () => {
  it('takes the stock back out and frees the quantity to return again', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 10)
    const sale = await soldBill(p, 4)

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(8)
    expect(await returnableQty(fx.db, sale.itemId)).toBe(fromUnits(2))

    await cancelReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, p))).toBe(6)
    expect(await returnableQty(fx.db, sale.itemId)).toBe(fromUnits(4))
  })

  it('leaves no stock drift', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100) })
    await stockUp(fx.db, p, 50)
    for (let i = 0; i < 8; i++) {
      const sale = await soldBill(p, 2)
      const ret = await createReturn(fx.db, {
        billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }],
        refundMethod: 'cash', actorId: fx.adminId,
      })
      if (!ret.ok) continue
      await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
      if (i % 3 === 0) await cancelReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    }
    expect(await recomputeStock(fx.db)).toEqual([])
  })
})

describe('loyalty clawback', () => {
  beforeEach(async () => {
    await setSetting(fx.db, 'loyalty_program', JSON.stringify({
      enabled: true,
      tiers: [{ minSpend: 0, pointsPerHundred: 1 }],
      expiryDays: 365, pointValue: 100,
      earnOnCreditPortion: false, minBillForEarn: 0, maxRedeemFractionBp: 10_000,
    }))
  })

  it('claws back in proportion to the refund', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 10)
    const c = await makeCustomer(fx.db)
    const sale = await soldBill(p, 2, c)

    const earned = await fx.db.get<{ points: number }>(`SELECT points FROM loyalty_entries WHERE bill_id = ?`, [sale.billId])
    expect(earned?.points).toBe(10)

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(1) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    const submitted = await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(submitted.ok && submitted.pointsClawedBack).toBe(5)

    const after = await fx.db.get<{ points: number }>(`SELECT points FROM loyalty_entries WHERE bill_id = ?`, [sale.billId])
    expect(after?.points).toBe(5)
  })

  it('never claws back points the customer has already spent', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
    await stockUp(fx.db, p, 20)
    const c = await makeCustomer(fx.db)
    const sale = await soldBill(p, 2, c)

    const second = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: c,
      lines: [{ productId: p, qty: fromUnits(2) }], actorId: fx.adminId,
    })
    if (!second.ok) return
    await submitBill(fx.db, {
      billId: second.billId,
      payments: [{ method: 'cash', amount: rupees(990) }],
      redeemPoints: 10, actorId: fx.adminId,
    })

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    const submitted = await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(submitted.ok && submitted.pointsClawedBack).toBe(0)

    const after = await fx.db.get<{ points: number; consumed: number }>(
      `SELECT points, consumed FROM loyalty_entries WHERE bill_id = ?`, [sale.billId],
    )
    expect(after?.points).toBe(10)
    expect(after?.consumed).toBe(10)
  })
})
