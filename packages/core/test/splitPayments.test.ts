import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { processReturn, cancelReturn } from '../src/services/returns.js'
import { recordPayment } from '../src/services/payments.js'
import { customerOutstanding } from '../src/services/payments/outstanding.js'
import { getOrOpenSession, sessionSummary } from '../src/services/cash.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { ledgerChecks, partyBalance } from '../src/repos/ledger.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * One bill paid several ways -- half in cash and half by UPI, or some now and
 * the rest on the customer's account -- and everything that can happen to it
 * afterwards: the drawer's count, the account, a return, and either of them
 * cancelled. Decided 15 Nov: a return on a bill sold partly on credit takes
 * what the bill still owes off the account first, and only the rest goes back
 * by hand (`creditFirst`).
 */

let fx: Fixture
let pen: string
let customer: string
let session: string

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Pen box', baseRate: rupees(100), taxRateBp: 0 })
  const opening = await createStockEntry(fx.db, {
    entryType: 'opening', lines: [{ productId: pen, qty: fromUnits(100), unitCost: rupees(50) }], actorId: fx.adminId,
  })
  if (!opening.ok) throw new Error(opening.code)
  await submitStockEntry(fx.db, { entryId: opening.entryId, actorId: fx.adminId })
  customer = await makeCustomer(fx.db)
  await fx.db.execute(`UPDATE customers SET credit_enforcement = 'none' WHERE id = ?`, [customer])
  session = (await getOrOpenSession(fx.db, { registerId: fx.seed.registerId, userId: fx.adminId, openingCash: rupees(0) })).sessionId
})
afterEach(async () => { await fx.db.close() })

/** Ten pen boxes, ₹1,000, paid the ways given. */
async function sell(payments: { method: 'cash' | 'upi' | 'card' | 'credit'; amount: Money }[]) {
  const bill = await createBill(fx.db, {
    registerId: fx.seed.registerId, customerId: customer, lines: [{ productId: pen, qty: fromUnits(10) }], actorId: fx.adminId,
  })
  if (!bill.ok) throw new Error(bill.code)
  const paid = await submitBill(fx.db, { billId: bill.billId, payments, actorId: fx.adminId })
  if (!paid.ok) throw new Error(paid.code)
  const [item] = await fx.db.query<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [bill.billId])
  return { billId: bill.billId, itemId: item!.id }
}

async function giveBack(sale: { billId: string; itemId: string }, units: number, refundMethod: 'cash' | 'upi' | 'credit' = 'cash') {
  const r = await processReturn(fx.db, {
    billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(units) }], refundMethod, actorId: fx.adminId,
  })
  if (!r.ok) throw new Error(r.code)
  return r
}

const drawer = async () => (await sessionSummary(fx.db, session)).expectedCash
const owed = () => customerOutstanding(fx.db, customer)
async function booksAgree() {
  const checks = await ledgerChecks(fx.db)
  expect(checks.unbalanced).toEqual([])
  expect(checks.stockDrift).toBe(0)
  // The customer's account in the books says what the khata says.
  expect(await partyBalance(fx.db, { type: 'customer', id: customer })).toBe(await owed())
}

describe('a bill paid two ways', () => {
  it('half cash, half UPI: the drawer expects the cash only, and nothing is owed', async () => {
    await sell([{ method: 'cash', amount: rupees(400) }, { method: 'upi', amount: rupees(600) }])
    expect(await drawer()).toBe(rupees(400))
    expect((await sessionSummary(fx.db, session)).nonCashIn).toBe(rupees(600))
    expect(await owed()).toBe(0)
    await booksAgree()
  })

  it('refuses tenders that do not add up to the bill', async () => {
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId, customerId: customer, lines: [{ productId: pen, qty: fromUnits(10) }], actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    const r = await submitBill(fx.db, {
      billId: bill.billId, payments: [{ method: 'cash', amount: rupees(400) }, { method: 'upi', amount: rupees(500) }], actorId: fx.adminId,
    })
    expect(r).toMatchObject({ ok: false, code: 'PAYMENT_MISMATCH' })
  })

  it('cancelled, gives back each part the way it came', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    expect(await owed()).toBe(rupees(500))
    const c = await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })
    expect(c.ok).toBe(true)
    expect(await drawer()).toBe(0)
    expect(await owed()).toBe(0)
    await booksAgree()
  })

  it('is not cancelled once some of its credit has been paid', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    await recordPayment(fx.db, { customerId: customer, amount: rupees(200), method: 'cash', actorId: fx.adminId })
    expect(await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })).toMatchObject({ ok: false, code: 'HAS_PAYMENTS' })
  })
})

describe('goods back on a bill sold partly on credit', () => {
  it('everything back: the unpaid credit comes off the account, only the cash part goes back in cash', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    const r = await giveBack(sale, 10)
    expect(r.refundToAccount).toBe(rupees(500))
    expect(r.refundCash).toBe(rupees(500))
    expect(await owed()).toBe(0)
    expect(await drawer()).toBe(0)
    await booksAgree()
  })

  it('half back: all of it comes off what the bill owes, and no cash leaves the drawer', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    const r = await giveBack(sale, 5)
    expect(r.refundToAccount).toBe(rupees(500))
    expect(r.refundCash).toBe(0)
    expect(await owed()).toBe(0)
    expect(await drawer()).toBe(rupees(500))
    await booksAgree()
  })

  it('credit partly paid already: only what is still owed comes off, the rest goes back in cash', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    await recordPayment(fx.db, { customerId: customer, amount: rupees(200), method: 'upi', actorId: fx.adminId })
    const r = await giveBack(sale, 10)
    expect(r.refundToAccount).toBe(rupees(300))
    expect(r.refundCash).toBe(rupees(700))
    expect(await owed()).toBe(0)
    await booksAgree()
  })

  it('settles the bill the goods came from, not an older one on the same account', async () => {
    const older = await sell([{ method: 'credit', amount: rupees(1000) }])
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    await giveBack(sale, 10)
    const due = await fx.db.query<{ id: string; due: number }>(
      `SELECT b.id, b.credit_total - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payment_entries p ON p.id = a.payment_id
          WHERE a.bill_id = b.id AND p.docstatus = 1), 0) AS due FROM bills b WHERE b.id IN (?, ?)`, [older.billId, sale.billId])
    expect(Object.fromEntries(due.map((d) => [d.id, d.due]))).toEqual({ [older.billId]: rupees(1000), [sale.billId]: 0 })
    await booksAgree()
  })

  it('a bill paid in full in cash refunds in cash, as it always did', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(1000) }])
    const r = await giveBack(sale, 4)
    expect(r).toMatchObject({ refundToAccount: 0, refundCash: rupees(400) })
    expect(await drawer()).toBe(rupees(600))
    await booksAgree()
  })

  it('cancelled, puts everything back: the debt on the account, and the cash in the drawer count', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    const r = await giveBack(sale, 10)
    expect(await drawer()).toBe(0)
    const c = await cancelReturn(fx.db, { returnId: r.returnId, actorId: fx.adminId })
    expect(c.ok).toBe(true)
    expect(await owed()).toBe(rupees(500))
    expect(await drawer()).toBe(rupees(500))
    await booksAgree()
  })

  it('stops the bill being cancelled while the return stands', async () => {
    const sale = await sell([{ method: 'cash', amount: rupees(500) }, { method: 'credit', amount: rupees(500) }])
    await giveBack(sale, 2)
    const c = await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })
    expect(c.ok).toBe(false)
  })
})
