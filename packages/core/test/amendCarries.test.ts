import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill, amendBill } from '../src/services/billing.js'
import { businessDate } from '../src/dates.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * An amendment is the bill again, not most of the bill.
 *
 * `amendBill` selected each line's `discount` and then did not pass it, and
 * never read the bill discount or the notes at all. So amending a bill of
 * ₹1,000 less ₹100 produced a draft for the full ₹1,000, with tax on the full
 * ₹1,000 — a shop correcting one line handed the customer a *larger* bill than
 * the one being corrected, and the discount had to be found on the cancelled
 * copy and typed in again.
 *
 * Under GST there is no such thing as an amended invoice. This is a cancel and
 * a new document, which is why the new one takes today's date and its own
 * number. Everything else about it has to be what the customer had agreed to.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function totals(db: SqlDriver, billId: string) {
  return db.get<{
    subtotal: number; discount: number; taxable_total: number
    tax_total: number; grand_total: number; notes: string | null; posting_date: string
  }>(
    `SELECT subtotal, discount, taxable_total, tax_total, grand_total, notes, posting_date
       FROM bills WHERE id = ?`, [billId],
  )
}

describe('amending a discounted bill', () => {
  it('charges exactly what the original charged, rather than more', async () => {
    const productId = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(1000) })

    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      billDiscount: rupees(100) as Money,
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    const original = await totals(fx.db, made.billId)
    expect(original?.grand_total).toBe(rupees(900))

    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'wrong item' })
    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    const draft = await totals(fx.db, amended.billId)

    /* To the paisa. The old behaviour produced ₹1,000 here -- more than the
       bill being corrected. What is asserted is what the customer owes and
       what the return is filed on, not how the reduction is presented: the
       amendment carries the whole of it against the line, because the split
       between line and bill discount is not recoverable from a stored row. */
    expect(draft?.grand_total).toBe(rupees(900))
    expect(draft?.tax_total).toBe(original?.tax_total)
    expect(draft?.taxable_total).toBe(original?.taxable_total)
  })

  it('carries a discount taken on one line', async () => {
    const productId = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(500) })

    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(2), discount: rupees(50) as Money }],
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'x' })

    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    const line = await fx.db.get<{ discount: number; line_total: number }>(
      `SELECT discount, line_total FROM bill_items WHERE bill_id = ?`, [amended.billId])

    // Selected by the old query and then dropped on the floor.
    expect(line?.discount).toBe(rupees(50))
    expect(line?.line_total).toBe(rupees(950))
  })

  it('carries the notes, which are what the correction is usually about', async () => {
    const productId = await makeProduct(fx.db, { name: 'Ruler' })

    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      notes: 'Delivered to the school gate',
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'x' })

    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    expect((await totals(fx.db, amended.billId))?.notes).toBe('Delivered to the school gate')
  })

  it('keeps the customer and takes a new number from the same series', async () => {
    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    const productId = await makeProduct(fx.db, { name: 'Chalk' })

    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'x' })

    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    /* An amendment is a draft until somebody submits it, and a draft has no
       invoice number -- the series may not be spent on a document that might
       never be issued. The number is taken at submit, from the same series. */
    await submitBill(fx.db, {
      billId: amended.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: amended.grandTotal }],
    })

    const both = await fx.db.query<{ id: string; doc_no: string; customer_id: string | null }>(
      `SELECT id, doc_no, customer_id FROM bills ORDER BY created_at`)

    expect(both).toHaveLength(2)
    expect(both[1]!.customer_id).toBe(customerId)
    // A separate consecutive number, because the cancelled one has been issued.
    expect(both[1]!.doc_no).not.toBe(both[0]!.doc_no)
    expect(both[1]!.doc_no.slice(0, 8)).toBe(both[0]!.doc_no.slice(0, 8))
  })

  it('dates the amendment today, not the day the original was raised', async () => {
    const productId = await makeProduct(fx.db, { name: 'Tape' })

    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      postingDate: '2026-04-01',
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    await cancelBill(fx.db, { billId: made.billId, actorId: fx.adminId, reason: 'x' })

    const amended = await amendBill(fx.db, { billId: made.billId, actorId: fx.adminId })
    expect(amended.ok).toBe(true)
    if (!amended.ok) return

    /* The one thing deliberately not carried. There is no amended invoice under
       GST; this is a fresh document and it is dated the day it was raised.
       Carrying the old date would back-date a document into a period that may
       already have been filed. */
    expect((await totals(fx.db, amended.billId))?.posting_date).toBe(businessDate())
  })
})
