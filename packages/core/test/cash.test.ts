import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, ZERO, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { recordPayment } from '../src/services/payments.js'
import { getOrOpenSession, closeSession, sessionSummary, postCashMovement, countDrawer } from '../src/services/cash.js'
import { createStockEntry, submitStockEntry, cancelStockEntry } from '../src/services/stockEntry.js'
import { currentStock, productValuation, recomputeStock } from '../src/services/stock.js'
import { toUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
})
afterEach(async () => { await fx.db.close() })

async function stockIn(units: number, unitCost: Money) {
  const e = await createStockEntry(fx.db, {
    entryType: 'purchase',
    lines: [{ productId: product, qty: fromUnits(units), unitCost }],
    supplierName: 'Acme',
    actorId: fx.adminId,
  })
  if (!e.ok) throw new Error(e.code)
  await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
  return e.entryId
}

async function sell(units: number, method: 'cash' | 'upi' | 'credit' = 'cash', customerId?: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(customerId ? { customerId } : {}),
    lines: [{ productId: product, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')
  const r = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method, amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(`submit failed: ${r.code}`)
  return { billId: draft.billId, total: draft.grandTotal }
}

describe('stock entries', () => {
  it('brings stock in and records what it cost', async () => {
    await stockIn(100, rupees(60))
    expect(toUnits(await currentStock(fx.db, product))).toBe(100)

    const row = await fx.db.get<{ unit_cost: number; voucher_type: string }>(
      `SELECT unit_cost, voucher_type FROM stock_ledger WHERE product_id = ?`, [product],
    )
    expect(row?.unit_cost).toBe(rupees(60))
    expect(row?.voucher_type).toBe('stock_entry')
  })

  it('reverses on cancel', async () => {
    const entryId = await stockIn(50, rupees(40))
    await cancelStockEntry(fx.db, { entryId, actorId: fx.adminId })
    expect(toUnits(await currentStock(fx.db, product))).toBe(0)
    expect(await recomputeStock(fx.db)).toEqual([])
  })

  it('refuses a purchase with negative quantity', async () => {
    const e = await createStockEntry(fx.db, {
      entryType: 'purchase',
      lines: [{ productId: product, qty: fromUnits(-5) }],
      actorId: fx.adminId,
    })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.code).toBe('INFLOW_NEEDS_POSITIVE_QTY')
  })

  it('allows a negative adjustment but not past zero', async () => {
    await stockIn(10, rupees(50))
    const e = await createStockEntry(fx.db, {
      entryType: 'wastage',
      lines: [{ productId: product, qty: fromUnits(-25) }],
      actorId: fx.adminId,
    })
    if (!e.ok) throw new Error(e.code)
    const r = await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WOULD_GO_NEGATIVE')
  })
})

describe('valuation', () => {
  it('computes a moving average across purchases at different costs', async () => {
    await stockIn(100, rupees(50))
    await stockIn(100, rupees(70))

    const v = await productValuation(fx.db, product)
    expect(toUnits(v.qtyOnHand)).toBe(200)
    expect(v.totalValue).toBe(rupees(12_000))
    expect(v.averageCost).toBe(rupees(60))
  })

  it('values remaining stock by FIFO layers after a sale', async () => {
    await stockIn(100, rupees(50))
    await stockIn(100, rupees(70))
    await sell(150)

    const v = await productValuation(fx.db, product, 'fifo')
    expect(toUnits(v.qtyOnHand)).toBe(50)
    // 100 @ 50 then 50 @ 70 consumed; 50 @ 70 left.
    expect(v.totalValue).toBe(rupees(3500))
    expect(v.consumedCost).toBe(rupees(8500))
  })

  it('is computable at all — the thing the old schema made impossible', async () => {
    await stockIn(10, rupees(45))
    const v = await productValuation(fx.db, product)
    expect(v.averageCost).toBe(rupees(45))
  })
})

describe('cash sessions', () => {
  it('opens once per register and reuses the open one', async () => {
    const first = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(2000) })
    expect(first.opened).toBe(true)
    const second = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    expect(second.opened).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
  })

  it('counts cash sales into the drawer', async () => {
    await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    await sell(2)
    await sell(3)

    const summary = await sessionSummary(fx.db, (await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })).sessionId)
    expect(summary.cashIn).toBe(rupees(500))
    expect(summary.expectedCash).toBe(rupees(1500))
  })

  it('keeps UPI out of the drawer count but still records it', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    await sell(2, 'upi')

    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.cashIn).toBe(ZERO)
    expect(summary.nonCashIn).toBe(rupees(200))
    expect(summary.expectedCash).toBe(rupees(1000))
    expect(summary.movementCount).toBe(1)
  })

  it('leaves credit sales out of the drawer entirely', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    const c = await makeCustomer(fx.db)
    await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [c])
    await sell(5, 'credit', c)

    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.movementCount).toBe(0)
    expect(summary.expectedCash).toBe(rupees(1000))
  })

  it('takes a refund back out of the drawer', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    const sale = await sell(4)
    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [sale.billId])

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: item!.id, qty: fromUnits(1) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) return
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })

    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.cashIn).toBe(rupees(400))
    expect(summary.cashOut).toBe(rupees(100))
    expect(summary.expectedCash).toBe(rupees(1300))
  })

  it('takes the tender back out when a bill is cancelled', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    const sale = await sell(3)
    await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })

    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.expectedCash).toBe(rupees(1000))
  })

  it('counts a customer receipt into the drawer', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: ZERO })
    await stockIn(100, rupees(50))
    const c = await makeCustomer(fx.db)
    await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [c])
    await sell(5, 'credit', c)

    await recordPayment(fx.db, {
      customerId: c, amount: rupees(300), method: 'cash',
      registerId: fx.seed.registerId, actorId: fx.adminId,
    })

    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.cashIn).toBe(rupees(300))
  })
})

describe('closing the drawer', () => {
  it('reports a variance when the count is short', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(1000) })
    await stockIn(100, rupees(50))
    await sell(5)

    const r = await closeSession(fx.db, { sessionId, actualCash: rupees(1450), userId: fx.adminId })
    expect(r.expectedCash).toBe(rupees(1500))
    expect(r.variance).toBe(rupees(-50))
  })

  it('reports zero variance on an exact count', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(500) })
    await stockIn(100, rupees(50))
    await sell(2)
    const r = await closeSession(fx.db, { sessionId, actualCash: rupees(700), userId: fx.adminId })
    expect(r.variance).toBe(ZERO)
  })

  it('cannot be closed twice', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    await closeSession(fx.db, { sessionId, actualCash: ZERO, userId: fx.adminId })
    await expect(closeSession(fx.db, { sessionId, actualCash: ZERO, userId: fx.adminId })).rejects.toThrow()
  })

  it('frees the register for a new session once closed', async () => {
    const first = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    await closeSession(fx.db, { sessionId: first.sessionId, actualCash: ZERO, userId: fx.adminId })
    const second = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId })
    expect(second.opened).toBe(true)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('adds up a denomination count', async () => {
    expect(await countDrawer({ '500': 3, '100': 4, '10': 2, '1': 5 })).toBe(rupees(1925))
  })
})

describe('manual drawer movements', () => {
  it('records a payout and reduces the expected cash', async () => {
    const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(2000) })
    await fx.db.transaction(async (tx) => {
      await postCashMovement(tx, {
        sessionId, direction: 'out', amount: rupees(250),
        sourceType: 'expense', reference: 'tea and snacks', userId: fx.adminId,
      })
    })
    const summary = await sessionSummary(fx.db, sessionId)
    expect(summary.expectedCash).toBe(rupees(1750))
  })
})

describe('a payout', () => {
  it('goes on the history, and is refused against a drawer already closed', async () => {
    const { recordPayout, getOrOpenSession, closeSession } = await import('../src/services/cash.js')
    const { freshDb } = await import('./helpers.js')
    const fx = await freshDb()
    try {
      const { sessionId } = await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: 50_000 as never })
      expect(await recordPayout(fx.db, { sessionId, amount: 2_000 as never, reason: 'Tea', userId: fx.adminId })).toEqual({ ok: true })
      const audited = await fx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'cash_sessions' AND entity_id = ? AND diff LIKE '%payout%'`, [sessionId],
      )
      expect(audited?.n).toBe(1)

      await closeSession(fx.db, { sessionId, actualCash: 48_000 as never, userId: fx.adminId })
      expect(await recordPayout(fx.db, { sessionId, amount: 100 as never, reason: null, userId: fx.adminId }))
        .toEqual({ ok: false, code: 'SESSION_CLOSED' })
    } finally {
      await fx.db.close()
    }
  })
})
