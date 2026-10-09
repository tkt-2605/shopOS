import { eq, and, desc } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { businessDate } from '../../dates.js'
import { newId } from '../../ids.js'
import type { Money } from '../../money.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { nextDocNo, seriesPrefix } from '../numbering.js'
import { closedFor, type PeriodClosed } from '../books.js'
import { OPENING_ADVANCE_REF } from '../../domain/credit.js'
import { type ReceiptMethod, type RecordPaymentResult, recordPayment } from './receipts.js'
import { requirePermission } from '../../integrity/permissions.js'
import { postVoucherGl } from '../ledger.js'
import { requireMayTakeMoney } from '../extraCounters.js'

/*
 * The rest of the khata: the receipts a customer has made, what the shop
 * writes off, and the balance the book carried when it moved here.
 */

/**
 * What has been received from this customer, newest first.
 *
 * Needed before anything can be undone: a receipt entered against the wrong
 * customer is the commonest correction in a khata shop, and until now
 * `cancelPayment` existed with nothing able to name a payment to it.
 */
export interface CustomerPayment {
  paymentId: string
  docNo: string
  postingDate: string
  method: ReceiptMethod
  amount: Money
  reference: string | null
  notes: string | null
  docstatus: number
  /** Which bills it settled, so cancelling it can say what goes back on the khata. */
  allocatedTo: { docNo: string; amount: Money }[]
}

export async function listCustomerPayments(
  db: SqlDriver,
  customerId: string,
  limit = 50,
): Promise<CustomerPayment[]> {
  const rows = await q(db)
    .select({
      id: schema.paymentEntries.id,
      docNo: schema.paymentEntries.docNo,
      postingDate: schema.paymentEntries.postingDate,
      method: schema.paymentEntries.method,
      amount: schema.paymentEntries.amount,
      reference: schema.paymentEntries.reference,
      notes: schema.paymentEntries.notes,
      docstatus: schema.paymentEntries.docstatus,
    })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.customerId, customerId),
      eq(schema.paymentEntries.partyType, 'customer'),
    ))
    .orderBy(desc(schema.paymentEntries.postingDate), desc(schema.paymentEntries.createdAt))
    .limit(limit)

  const out: CustomerPayment[] = []
  for (const r of rows) {
    const allocs = await q(db)
      .select({ docNo: schema.bills.docNo, amount: schema.paymentAllocations.amount })
      .from(schema.paymentAllocations)
      .innerJoin(schema.bills, eq(schema.bills.id, schema.paymentAllocations.billId))
      .where(eq(schema.paymentAllocations.paymentId, r.id))
      .orderBy(schema.bills.postingDate)

    out.push({
      paymentId: r.id,
      docNo: r.docNo,
      postingDate: r.postingDate,
      method: r.method as ReceiptMethod,
      amount: r.amount,
      reference: r.reference,
      notes: r.notes,
      docstatus: r.docstatus,
      allocatedTo: allocs,
    })
  }
  return out
}

/**
 * Giving up on money that is owed.
 *
 * The customer has gone, or the last ₹40 is not worth the phone call. Posted as
 * an adjustment rather than as a receipt, so the drawer is untouched and the
 * day's takings do not report money that never arrived — the difference between
 * a debt settled and a debt abandoned is exactly what an owner wants to see
 * separately later.
 *
 * Reversible the same way a payment is: it is a payment entry, so cancelling it
 * puts the debt back.
 */
export async function writeOff(
  db: SqlDriver,
  input: {
    customerId: string
    /** Omit to clear the oldest bills first, as a payment would. */
    billId?: string
    amount: Money
    reason: string
    registerPrefix?: string
    actorId: string
    now?: Date
  },
): Promise<RecordPaymentResult> {
  return recordPayment(db, {
    customerId: input.customerId,
    amount: input.amount,
    method: 'adjustment',
    reference: 'Written off',
    notes: input.reason,
    ...(input.billId ? { allocations: [{ billId: input.billId, amount: input.amount }] } : {}),
    ...(input.registerPrefix ? { registerPrefix: input.registerPrefix } : {}),
    actorId: input.actorId,
    ...(input.now ? { now: input.now } : {}),
  })
}

export type OpeningBalanceResult =
  /** They owed the shop. Recorded as a bill; `billId` is it. */
  | { ok: true; direction: 'owed'; billId: string; docNo: string }
  /** The shop was holding theirs. Recorded as a receipt nothing points at. */
  | { ok: true; direction: 'held'; paymentId: string; docNo: string }
  | { ok: false; code: 'INVALID_AMOUNT' }
  | { ok: false; code: 'ALREADY_SET'; docNo: string }
  | PeriodClosed

/**
 * What the customer already owed before this shop started using ShopOS.
 *
 * Recorded as a bill, because a bill is the only thing a payment can be
 * allocated against, and an opening balance that cannot be paid off is useless.
 * It carries `kind = 'opening'` so that no sales report ever counts it as
 * something the shop sold — that mark is the whole reason it is safe to put it
 * here rather than inventing a parallel ledger the outstanding query would have
 * to learn about.
 *
 * One per customer. A second one is refused rather than added, because "the
 * opening balance" is a single fact about a single moment; getting it wrong is
 * corrected by cancelling and re-entering.
 */
export async function recordOpeningBalance(
  db: SqlDriver,
  input: {
    customerId: string
    amount: Money
    /** The day the shop's own book was closed. Defaults to today. */
    asOf?: string
    note?: string
    registerId: string
    registerPrefix?: string
    actorId: string
    now?: Date
  },
): Promise<OpeningBalanceResult> {
  await requirePermission(db, input.actorId, 'payment', 'create')
  await requireMayTakeMoney(db)
  if (input.amount === 0) return { ok: false, code: 'INVALID_AMOUNT' }

  const closed = await closedFor(db, input.asOf ?? businessDate(input.now ?? new Date()))
  if (closed) return closed

  /* A balance carried over can point either way, and the two are different
     kinds of thing rather than one number with a sign.

     Positive is a receivable: they owed the shop, and it becomes a bill,
     because a bill is the only thing a payment can be allocated against.

     Negative is a liability: the shop was holding *their* money before any of
     this started -- an advance, a deposit, an overpayment in the old book --
     and it becomes a receipt that no allocation points at, which is exactly
     what `advanceCredit` reads. The argument against storing it as a negative
     receivable is on that function: "Balance due -490.00" reads as an error in
     the arithmetic rather than as money the shop has to hand back. */
  if (input.amount < 0) return recordOpeningAdvance(db, input)

  const [existing] = await q(db)
    .select({ docNo: schema.bills.docNo })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, input.customerId),
      eq(schema.bills.kind, 'opening'),
      eq(schema.bills.docstatus, SUBMITTED),
    ))
  if (existing) return { ok: false, code: 'ALREADY_SET', docNo: existing.docNo }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const postingDate = input.asOf ?? businessDate(now)
  const billId = newId()

  const [customer] = await q(db)
    .select({ name: schema.customers.name })
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))

  let docNo = ''
  await db.transaction(async (tx) => {
    /* The counter it was entered at, read from the register the caller
       already named -- the same way `documents.ts` does it, and better than
       asking which counter this till sits at, because this one is a fact the
       screen passed in.

       `OB` stays in front of it. An opening balance is not a sale and must
       not take a number out of the invoice series; handing it the register
       prefix alone would file it among real invoices. So the marker keeps
       the prefix beside it, which is a longer number and an unambiguous
       one. */
    const [at] = await q(tx)
      .select({ prefix: schema.registers.prefix })
      .from(schema.registers)
      .where(eq(schema.registers.id, input.registerId))
    docNo = await nextDocNo(tx, 'bill', input.registerPrefix ?? (at ? `OB${at.prefix}` : await seriesPrefix(tx, 'OB')), now)
    await q(tx).insert(schema.bills).values({
      id: billId,
      docNo,
      docstatus: SUBMITTED,
      kind: 'opening',
      registerId: input.registerId,
      customerId: input.customerId,
      customerName: customer?.name ?? null,
      postingDate,
      /* The whole of it is owed and none of it was paid, which is what an
         opening balance is. The other money columns keep their defaults of
         zero: nothing was sold, so there is no subtotal and no tax. */
      grandTotal: input.amount,
      creditTotal: input.amount,
      notes: input.note ?? 'Balance carried over',
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    await postVoucherGl(tx, 'bill', billId)
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: billId, action: 'submit',
      docstatusTo: SUBMITTED,
      after: { kind: 'opening', amount: input.amount, posting_date: postingDate },
    })
  })

  return { ok: true, direction: 'owed', billId, docNo }
}

/** The series an opening advance is numbered in, for a person reading a statement. */
const OPENING_ADVANCE_PREFIX = 'OA'


/**
 * Money the shop was already holding for this customer when the books moved.
 *
 * A receipt with no allocations, which is precisely what an advance is
 * everywhere else in this file. Two things differ from an ordinary receipt and
 * both matter:
 *
 * **`method` is `adjustment` and no cash movement is posted.** The money
 * arrived before ShopOS existed. Putting it in today's drawer would make the
 * evening count short by exactly this amount, and the cashier would be told
 * they had lost it.
 *
 * **The posting date is the day the old book closed**, not today, so the
 * statement shows it where it happened.
 */
async function recordOpeningAdvance(
  db: SqlDriver,
  input: {
    customerId: string
    amount: Money
    asOf?: string
    note?: string
    registerId: string
    registerPrefix?: string
    actorId: string
    now?: Date
  },
): Promise<OpeningBalanceResult> {
  const held = Math.abs(input.amount) as Money

  /* raw: `reference` is not on the query builder's path for this table and
     this is a one-column existence check. See `OPENING_ADVANCE_REF` for why
     the marker is a column rather than a prefix on the document number. */
  const existing = await db.get<{ doc_no: string }>(
    `SELECT doc_no FROM payment_entries
      WHERE customer_id = ? AND party_type = 'customer'
        AND docstatus = ? AND reference = ?
      LIMIT 1`,
    [input.customerId, SUBMITTED, OPENING_ADVANCE_REF],
  )
  if (existing) return { ok: false, code: 'ALREADY_SET', docNo: existing.doc_no }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const postingDate = input.asOf ?? businessDate(now)
  const paymentId = newId()
  let docNo = ''

  await db.transaction(async (tx) => {
    const [at] = await q(tx)
      .select({ prefix: schema.registers.prefix })
      .from(schema.registers)
      .where(eq(schema.registers.id, input.registerId))

    docNo = await nextDocNo(
      tx, 'payment',
      input.registerPrefix ?? `${OPENING_ADVANCE_PREFIX}${at?.prefix ?? ''}`,
      now,
    )

    await q(tx).insert(schema.paymentEntries).values({
      id: paymentId,
      docNo,
      docstatus: SUBMITTED,
      partyType: 'customer',
      customerId: input.customerId,
      postingDate,
      method: 'adjustment',
      amount: held,
      reference: OPENING_ADVANCE_REF,
      notes: input.note ?? 'Balance carried over — money already held',
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    // No `payment_allocations` rows on purpose: what nothing points at is the
    // advance, and `advanceCredit` reads exactly that.
    await postVoucherGl(tx, 'payment', paymentId)

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: paymentId, action: 'submit',
      docstatusTo: SUBMITTED,
      after: { kind: 'opening_advance', amount: held, posting_date: postingDate },
    })
  })

  return { ok: true, direction: 'held', paymentId, docNo }
}
