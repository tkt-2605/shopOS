import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { processReturn, cancelReturn } from '../src/services/returns.js'
import { recordPayment, cancelPayment } from '../src/services/payments.js'
import { recordOpeningBalance, writeOff } from '../src/services/payments/khata.js'
import { refundAdvance } from '../src/services/payments/advance.js'
import { customerOutstanding } from '../src/services/payments/outstanding.js'
import { advanceCredit } from '../src/services/payments/advance.js'
import { createStockEntry, submitStockEntry, cancelStockEntry } from '../src/services/stockEntry.js'
import { getOrOpenSession, closeSession, recordPayout } from '../src/services/cash.js'
import { postMissingGl } from '../src/services/ledger.js'
import {
  trialBalance, profitAndLoss, balanceSheet, ledgerChecks, partyBalance,
} from '../src/repos/ledger.js'
import { setSetting } from '../src/services/settings.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The general ledger (migration 064).
 *
 * From the review of 4 October: the product kept a ledger of each thing --
 * stock, the drawer, the khata, points -- and no books, so "what did we make"
 * and "what do we own and owe" had no answer, and nothing showed that the
 * separate ledgers agreed. These tests hold the books to themselves and to the
 * ledgers they are posted from.
 */

let fx: Fixture
let pen: string
let customer: string
const day = (d: string) => new Date(`${d}T11:00:00`)

beforeEach(async () => {
  fx = await freshDb()
  await setSetting(fx.db, 'shop_state_code', '33')
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(118), taxRateBp: 1800 })
  customer = await makeCustomer(fx.db, 'Anand')
  const stock = await createStockEntry(fx.db, {
    entryType: 'purchase', postingDate: '2026-06-01',
    lines: [{ productId: pen, qty: fromUnits(100), unitCost: rupees(50) }], actorId: fx.adminId,
  })
  if (!stock.ok) throw new Error(stock.code)
  await submitStockEntry(fx.db, { entryId: stock.entryId, actorId: fx.adminId })
})
afterEach(async () => { await fx.db.close() })

async function sale(units: number, on: string, how: 'cash' | 'upi' | 'credit' = 'cash'): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId: pen, qty: fromUnits(units) }],
    ...(how === 'credit' ? { customerId: customer } : {}), actorId: fx.adminId, now: day(on),
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: how, amount: draft.grandTotal }], actorId: fx.adminId, now: day(on),
  })
  if (!done.ok) throw new Error(done.code)
  return draft.billId
}

/** Everything a shop does in a month, through the services. */
async function aMonth(): Promise<void> {
  await getOrOpenSession(fx.db, {
    registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(500) as Money, now: day('2026-06-02'),
  })
  const counter = await sale(3, '2026-06-02')
  await sale(2, '2026-06-03', 'upi')

  // A cash return, taken and then undone.
  const line = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [counter])
  const undoneReturn = await processReturn(fx.db, {
    billId: counter, lines: [{ billItemId: line!.id, qty: fromUnits(1) }], refundMethod: 'cash',
    actorId: fx.adminId, now: day('2026-06-03'),
  })
  if (!undoneReturn.ok) throw new Error(undoneReturn.code)
  await cancelReturn(fx.db, { returnId: undoneReturn.returnId, actorId: fx.adminId })
  const onCredit = await sale(4, '2026-06-04', 'credit')
  const cancelled = await sale(1, '2026-06-05')
  await cancelBill(fx.db, { billId: cancelled, actorId: fx.adminId })

  const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [onCredit])
  const ret = await processReturn(fx.db, {
    billId: onCredit, lines: [{ billItemId: item!.id, qty: fromUnits(1) }], refundMethod: 'credit',
    actorId: fx.adminId, now: day('2026-06-06'),
  })
  if (!ret.ok) throw new Error(ret.code)

  const paid = await recordPayment(fx.db, {
    customerId: customer, amount: rupees(200) as Money, method: 'cash', actorId: fx.adminId, now: day('2026-06-07'),
  })
  if (!paid.ok) throw new Error(paid.code)
  const undone = await recordPayment(fx.db, {
    customerId: customer, amount: rupees(10) as Money, method: 'upi', actorId: fx.adminId, now: day('2026-06-07'),
  })
  if (!undone.ok) throw new Error(undone.code)
  await cancelPayment(fx.db, { paymentId: undone.paymentId, actorId: fx.adminId })
  await writeOff(fx.db, { customerId: customer, amount: rupees(4) as Money, reason: 'Small balance', actorId: fx.adminId })

  const other = await makeCustomer(fx.db, 'Bhavani')
  await recordOpeningBalance(fx.db, {
    customerId: other, amount: rupees(300) as Money, asOf: '2026-06-01', registerId: fx.seed.registerId, actorId: fx.adminId,
  })
  const holding = await makeCustomer(fx.db, 'Chitra')
  await recordOpeningBalance(fx.db, {
    customerId: holding, amount: -rupees(150) as Money, asOf: '2026-06-01', registerId: fx.seed.registerId, actorId: fx.adminId,
  })
  await refundAdvance(fx.db, { customerId: holding, amount: rupees(50) as Money, method: 'cash', actorId: fx.adminId })

  const waste = await createStockEntry(fx.db, {
    entryType: 'wastage', postingDate: '2026-06-08',
    lines: [{ productId: pen, qty: fromUnits(-2) }], actorId: fx.adminId,
  })
  if (!waste.ok) throw new Error(waste.code)
  await submitStockEntry(fx.db, { entryId: waste.entryId, actorId: fx.adminId })
  const wrong = await createStockEntry(fx.db, {
    entryType: 'purchase', postingDate: '2026-06-09',
    lines: [{ productId: pen, qty: fromUnits(10) }, ], actorId: fx.adminId,
  })
  if (!wrong.ok) throw new Error(wrong.code)
  await submitStockEntry(fx.db, { entryId: wrong.entryId, actorId: fx.adminId })
  await cancelStockEntry(fx.db, { entryId: wrong.entryId, actorId: fx.adminId })

  const session = await fx.db.get<{ id: string }>(`SELECT id FROM cash_sessions WHERE closed_at IS NULL`)
  await recordPayout(fx.db, { sessionId: session!.id, amount: rupees(30) as Money, reason: 'Tea', userId: fx.adminId })
  await closeSession(fx.db, {
    sessionId: session!.id, actualCash: rupees(800) as Money, userId: fx.adminId, now: day('2026-06-10'),
  })
}

describe('the books', () => {
  it('balance, voucher by voucher, and agree with the stock ledger to the paisa', async () => {
    await aMonth()
    const checks = await ledgerChecks(fx.db)
    expect(checks.unbalanced).toEqual([])
    expect(checks.stockDrift).toBe(0)

    const tb = await trialBalance(fx.db, '2026-12-31')
    expect(tb.debit).toBe(tb.credit)
    expect(tb.debit).toBeGreaterThan(0)
  })

  it('own as much as they owe, on any day', async () => {
    await aMonth()
    for (const asOf of ['2026-06-03', '2026-06-06', '2026-12-31']) {
      const bs = await balanceSheet(fx.db, asOf)
      expect(bs.totalAssets).toBe(bs.totalClaims)
    }
  })

  it('carry each customer at what the khata says they owe, less what the shop holds for them', async () => {
    await aMonth()
    const customers = await fx.db.query<{ id: string }>(`SELECT id FROM customers`)
    for (const c of customers) {
      const owed = await customerOutstanding(fx.db, c.id)
      const held = (await advanceCredit(fx.db, c.id)).amount
      expect(await partyBalance(fx.db, { type: 'customer', id: c.id }), c.id).toBe(owed - held)
    }
  })

  it('make a sale at ₹118 of a pen that cost ₹50 a profit of ₹50', async () => {
    await sale(1, '2026-06-02')
    const pl = await profitAndLoss(fx.db, { from: '2026-06-01', to: '2026-06-30' })
    expect(pl.totalIncome).toBe(rupees(100))
    expect(pl.totalExpense).toBe(rupees(50))
    expect(pl.profit).toBe(rupees(50))
  })

  it('leave nothing behind when a bill is cancelled', async () => {
    const billId = await sale(2, '2026-06-02')
    await cancelBill(fx.db, { billId, actorId: fx.adminId })
    const net = await fx.db.query<{ account: string; net: number }>(
      `SELECT account, SUM(debit) - SUM(credit) AS net FROM gl_entries WHERE voucher_id = ? GROUP BY account`, [billId])
    for (const row of net) expect(row.net, row.account).toBe(0)
  })

  it('refuse a document whose entries would not balance, rather than issue it', async () => {
    /* A bill whose tender does not match its lines is refused by the service
       long before the books; this reaches the books by writing one directly,
       which is the only way there is. */
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    await fx.db.execute(`UPDATE bills SET docstatus = 1, doc_no = 'BMR/X/1' WHERE id = ?`, [draft.billId])
    const found = await postMissingGl(fx.db)
    expect(found.unbalanced).toEqual([`bill:${draft.billId}`])
    expect(await fx.db.query(`SELECT id FROM gl_entries WHERE voucher_id = ?`, [draft.billId])).toEqual([])
  })
})

describe('filling in what is missing', () => {
  it('writes exactly the entries the documents would have written, and only once', async () => {
    await aMonth()
    const before = await fx.db.query(
      `SELECT id, account, party_id, debit, credit, posting_date FROM gl_entries ORDER BY id`)

    // The shop as it was before the ledger: documents, and no books.
    await fx.db.execute(`DROP TRIGGER gl_entries_is_append_only_del`)
    await fx.db.execute(`DELETE FROM gl_entries`)

    const first = await postMissingGl(fx.db)
    expect(first.unbalanced).toEqual([])
    const after = await fx.db.query(
      `SELECT id, account, party_id, debit, credit, posting_date FROM gl_entries ORDER BY id`)
    expect(after).toEqual(before)

    expect((await postMissingGl(fx.db)).posted).toBe(0)
  })
})
