import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getOrOpenSession, closeSession, postCashMovement, sessionSummary, CashSessionClosedError } from '../src/services/cash.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A bill held at the counter overnight.
 *
 * Found in the review of 4 October. A draft is started at 20:30 on 31 March,
 * the drawer is counted and closed at 21:00, and the customer comes back and
 * pays at 10:00 on 1 April. Before the fix the cash went into the drawer that
 * had already been counted -- in neither night's figure -- and the invoice was
 * dated 31 March under a 2026-27 number.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function heldOverNight() {
  const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
  const { sessionId: evening } = await getOrOpenSession(fx.db, {
    registerId: fx.seed.registerId, userId: fx.adminId,
    openingCash: rupees(0) as Money, now: new Date('2026-03-31T20:00:00'),
  })
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: p, qty: fromUnits(1) }],
    actorId: fx.adminId, now: new Date('2026-03-31T20:30:00'),
  })
  if (!draft.ok) throw new Error(JSON.stringify(draft))
  await closeSession(fx.db, {
    sessionId: evening, actualCash: rupees(0) as Money, userId: fx.adminId,
    now: new Date('2026-03-31T21:00:00'),
  })
  return { evening, billId: draft.billId }
}

describe('a bill held overnight', () => {
  it('is dated, and numbered, on the day it is paid', async () => {
    const { billId } = await heldOverNight()
    const r = await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: rupees(100) as Money }],
      actorId: fx.adminId, now: new Date('2026-04-01T10:00:00'),
    })
    expect(r.ok).toBe(true)
    const bill = await fx.db.get<{ doc_no: string; posting_date: string }>(
      `SELECT doc_no, posting_date FROM bills WHERE id = ?`, [billId])
    expect(bill!.posting_date).toBe('2026-04-01')
    expect(bill!.doc_no).toContain('/2627/')
  })

  it('moves its goods on the day it is paid', async () => {
    const { billId } = await heldOverNight()
    await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: rupees(100) as Money }],
      actorId: fx.adminId, now: new Date('2026-04-01T10:00:00'),
    })
    const moves = await fx.db.query<{ posting_date: string }>(
      `SELECT posting_date FROM stock_ledger WHERE voucher_id = ?`, [billId])
    expect(moves.map((m) => m.posting_date)).toEqual(['2026-04-01'])
  })

  it('puts the money in the drawer open when it is paid, not the one already counted', async () => {
    const { evening, billId } = await heldOverNight()
    const { sessionId: morning } = await getOrOpenSession(fx.db, {
      registerId: fx.seed.registerId, userId: fx.adminId,
      openingCash: rupees(0) as Money, now: new Date('2026-04-01T09:00:00'),
    })
    await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: rupees(100) as Money }],
      actorId: fx.adminId, now: new Date('2026-04-01T10:00:00'),
    })

    expect((await sessionSummary(fx.db, morning)).expectedCash).toBe(rupees(100))
    const counted = await fx.db.query(`SELECT id FROM cash_movements WHERE session_id = ?`, [evening])
    expect(counted).toEqual([])
    const bill = await fx.db.get<{ session_id: string }>(`SELECT session_id FROM bills WHERE id = ?`, [billId])
    expect(bill!.session_id).toBe(morning)
  })

  it('with no drawer open, records the tender and moves no drawer', async () => {
    const { billId } = await heldOverNight()
    const r = await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: rupees(100) as Money }],
      actorId: fx.adminId, now: new Date('2026-04-01T10:00:00'),
    })
    expect(r.ok).toBe(true)
    expect(await fx.db.query(`SELECT id FROM cash_movements`)).toEqual([])
    const bill = await fx.db.get<{ session_id: string | null }>(`SELECT session_id FROM bills WHERE id = ?`, [billId])
    expect(bill!.session_id).toBeNull()
  })
})

describe('a drawer that has been counted', () => {
  it('takes no more money', async () => {
    const { evening } = await heldOverNight()
    await expect(fx.db.transaction((tx) => postCashMovement(tx, {
      sessionId: evening, direction: 'in', amount: rupees(5) as Money,
      sourceType: 'bill', userId: fx.adminId,
    }))).rejects.toBeInstanceOf(CashSessionClosedError)
  })
})
