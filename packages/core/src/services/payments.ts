import type { SqlDriver } from '../db/driver.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, add, sub } from '../money.js'
import { planAllocation, totalOutstanding, type OpenBill, type PaymentAllocation } from '../domain/credit.js'
import { SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { nextDocNo } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'

export type ReceiptMethod = 'cash' | 'upi' | 'card' | 'adjustment'

export interface RecordPaymentInput {
  customerId: string
  amount: Money
  method: ReceiptMethod
  reference?: string
  notes?: string
  /** Omit to settle oldest bills first, which is what clearing khata means. */
  allocations?: PaymentAllocation[]
  registerPrefix?: string
  registerId?: string
  actorId: string
  now?: Date
}

export type RecordPaymentResult =
  | { ok: true; paymentId: string; docNo: string; allocated: Money; unallocated: Money; allocations: PaymentAllocation[] }
  | { ok: false; code: 'INVALID_AMOUNT' }
  | { ok: false; code: 'OVER_ALLOCATED'; billId: string; requested: Money; due: Money }
  | { ok: false; code: 'ALLOCATION_EXCEEDS_PAYMENT'; payment: Money; allocated: Money }

/**
 * A receipt is created complete — there is no half-taken payment to build up, so
 * it goes straight to submitted. Correction is cancel, which releases the
 * allocations because every outstanding query joins on docstatus = 1.
 */
export async function recordPayment(db: SqlDriver, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  if (input.amount <= 0) return { ok: false, code: 'INVALID_AMOUNT' }

  const now = input.now ?? new Date()
  const openBills = await loadOpenBills(db, input.customerId)

  let allocations: PaymentAllocation[]
  let unallocated: Money

  if (input.allocations) {
    const requested = add(...input.allocations.map((a) => a.amount))
    if (requested > input.amount) {
      return { ok: false, code: 'ALLOCATION_EXCEEDS_PAYMENT', payment: input.amount, allocated: requested }
    }
    for (const alloc of input.allocations) {
      const bill = openBills.find((b) => b.id === alloc.billId)
      const due = bill ? sub(bill.creditTotal, bill.allocated) : ZERO
      if (alloc.amount > due) {
        return { ok: false, code: 'OVER_ALLOCATED', billId: alloc.billId, requested: alloc.amount, due }
      }
    }
    allocations = input.allocations
    unallocated = sub(input.amount, requested)
  } else {
    const plan = planAllocation(input.amount, openBills)
    allocations = plan.allocations
    unallocated = plan.unallocated
  }

  const paymentId = newId()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'payment', input.registerPrefix ?? 'MR', now)

    await tx.execute(
      `INSERT INTO payment_entries
         (id, doc_no, docstatus, party_type, customer_id, posting_date, method, amount, reference, notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, 1, 'customer', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId, docNo, input.customerId, postingDate, input.method, input.amount,
        input.reference ?? null, input.notes ?? null, input.actorId, nowIso, nowIso,
      ],
    )

    for (const alloc of allocations) {
      await tx.execute(
        `INSERT INTO payment_allocations (id, payment_id, bill_id, amount) VALUES (?, ?, ?, ?)`,
        [newId(), paymentId, alloc.billId, alloc.amount],
      )
    }

    if (input.registerId && input.method !== 'adjustment') {
      const session = await openSessionFor(tx, input.registerId)
      if (session) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'in',
          amount: input.amount,
          method: input.method,
          sourceType: 'customer_receipt',
          sourceId: paymentId,
          reference: input.reference ?? null,
          userId: input.actorId,
          now,
        })
      }
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: paymentId, action: 'submit',
      docstatusTo: SUBMITTED,
      after: { amount: input.amount, allocations: allocations.length },
    })
  })

  return { ok: true, paymentId, docNo, allocated: sub(input.amount, unallocated), unallocated, allocations }
}

/**
 * A receipt raised by something else, inside that thing's transaction.
 *
 * A refund put back on the khata is a receipt against the customer: the goods
 * came back, so the money they owe for them goes away. Written here rather than
 * through `recordPayment` so it commits or rolls back with the return itself —
 * a return that posted stock but left the customer still owing for it is the
 * one outcome worth being paranoid about.
 *
 * The method is `adjustment` because no money moved: nothing goes in the drawer
 * and nothing comes out of it.
 */
export async function postCreditNote(
  tx: SqlDriver,
  input: {
    customerId: string
    amount: Money
    reference: string
    notes?: string | null
    registerPrefix?: string
    actorId: string
    now: Date
  },
): Promise<{ paymentId: string; docNo: string; allocated: Money }> {
  const openBills = await loadOpenBills(tx, input.customerId)
  const plan = planAllocation(input.amount, openBills)

  const paymentId = newId()
  const nowIso = input.now.toISOString()
  const docNo = await nextDocNo(tx, 'payment', input.registerPrefix ?? 'MR', input.now)

  await tx.execute(
    `INSERT INTO payment_entries
       (id, doc_no, docstatus, party_type, customer_id, posting_date, method, amount, reference, notes,
        created_by, created_at, updated_at)
     VALUES (?, ?, 1, 'customer', ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
    [
      paymentId, docNo, input.customerId, businessDate(input.now), input.amount,
      input.reference, input.notes ?? null, input.actorId, nowIso, nowIso,
    ],
  )

  for (const alloc of plan.allocations) {
    await tx.execute(
      `INSERT INTO payment_allocations (id, payment_id, bill_id, amount) VALUES (?, ?, ?, ?)`,
      [newId(), paymentId, alloc.billId, alloc.amount],
    )
  }

  await writeAudit(tx, { actorId: input.actorId }, {
    entity: 'payment_entries', entityId: paymentId, action: 'submit',
    docstatusTo: SUBMITTED,
    after: { amount: input.amount, reference: input.reference },
  })

  return { paymentId, docNo, allocated: plan.allocated }
}

export async function cancelPayment(
  db: SqlDriver,
  input: { paymentId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true; paymentId: string }> {
  const now = input.now ?? new Date()
  const row = await db.get<{ docstatus: number }>(`SELECT docstatus FROM payment_entries WHERE id = ?`, [input.paymentId])
  if (!row) throw new Error(`unknown payment: ${input.paymentId}`)
  assertCanApply('payment', parseDocStatus(row.docstatus), 'cancel')

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE payment_entries SET docstatus = 2, updated_at = ? WHERE id = ?`,
      [now.toISOString(), input.paymentId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: input.paymentId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, paymentId: input.paymentId }
}

export async function loadOpenBills(db: SqlDriver, customerId: string): Promise<OpenBill[]> {
  const rows = await db.query<{
    id: string; doc_no: string; posting_date: string; credit_total: number; allocated: number
  }>(
    `SELECT b.id, b.doc_no, b.posting_date, b.credit_total,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                       WHERE pa.bill_id = b.id), 0) AS allocated
       FROM bills b
      WHERE b.customer_id = ? AND b.docstatus = 1 AND b.credit_total > 0`,
    [customerId],
  )
  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    postingDate: r.posting_date,
    creditTotal: r.credit_total as Money,
    allocated: r.allocated as Money,
  }))
}

export async function customerOutstanding(db: SqlDriver, customerId: string): Promise<Money> {
  return totalOutstanding(await loadOpenBills(db, customerId))
}

export interface OutstandingTotal {
  /** What the shop is owed, across every customer there is. */
  total: Money
  /** How many customers that is spread over. */
  customers: number
  /** The one to start with on a collection day, or null if nobody owes. */
  worst: { id: string; name: string; outstanding: Money } | null
  /** How many are past a limit they were given. Customers with no limit set
      cannot be over it, and are not counted. */
  overLimit: number
}

/**
 * What the shop is owed, over all of it.
 *
 * The Credit page used to add up the rows it had: `searchCustomers(db, '', 500)`
 * and then `.reduce()` over the result. On a shop with six hundred customers
 * that headline is the total owed by the first five hundred *by name* — the
 * shopkeeper is told what they are owed and it is short by however much the
 * back of the alphabet happens to owe. Nothing on the screen says so, and the
 * number is wrong in the safe-looking direction: always too small, never too
 * large, so it never looks alarming enough to question.
 *
 * Two passes instead of six hundred: the credit billed, grouped, and the money
 * taken against it, grouped, joined once. A correlated subquery per customer is
 * the obvious way to write this and it re-reads `bills` once for every name on
 * the list.
 *
 * ## All three numbers, not one
 *
 * "Owes the most" and "Over their limit" sat beside the total and were computed
 * the same wrong way, off the same five hundred rows. Fixing only the headline
 * would have left two thirds of one bug on one screen, looking fixed. They come
 * off the same two passes, so they cost nothing extra.
 *
 * ## Positive balances only, added up
 *
 * Not `SUM(credit) - SUM(payments)` over the whole shop, which is a different
 * number. A customer who has paid in advance is in credit, and their credit is
 * not available to reduce what somebody else owes — the shop still has to
 * collect that money from that person. Netting them off understates the
 * collection problem, which is the one thing this figure exists to describe.
 * It is also what the page already did by filtering to `outstanding > 0` before
 * adding, so this preserves the meaning the screen had rather than quietly
 * changing it while fixing the range.
 *
 * ## The definition is `searchCustomers`', deliberately
 *
 * Same balance expression, same `is_active = 1 AND deleted_at IS NULL`. The
 * headline and the rows beneath it have to be the same arithmetic or the page
 * contradicts itself in public, and an archived customer's old debt appearing
 * in a total but in no row would be unanswerable.
 */
export async function totalOutstandingAll(db: SqlDriver): Promise<OutstandingTotal> {
  const row = await db.get<{
    total: number; customers: number; over_limit: number
    worst_id: string | null; worst_name: string | null; worst_owed: number | null
  }>(
    /* `balances` is every customer who has ever been billed on credit, with
       what they owe now. Starting from `billed` rather than from `customers`
       is deliberate: somebody who has never taken credit cannot owe anything,
       and on a shop with thousands of walk-in accounts that is most of the
       table.

       The two "worst" columns sort identically, name included, so a tie
       between two customers owing the same amount cannot return one person's
       name beside another person's figure. */
    `WITH billed AS (
       SELECT b.customer_id AS id, SUM(b.credit_total) AS amount
         FROM bills b
        WHERE b.docstatus = 1 AND b.credit_total > 0 AND b.customer_id IS NOT NULL
        GROUP BY b.customer_id
     ),
     taken AS (
       SELECT b.customer_id AS id, SUM(pa.amount) AS amount
         FROM payment_allocations pa
         JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
         JOIN bills b ON b.id = pa.bill_id
        WHERE b.customer_id IS NOT NULL
        GROUP BY b.customer_id
     ),
     balances AS (
       SELECT c.id, c.name, c.credit_limit,
              billed.amount - COALESCE(taken.amount, 0) AS owed
         FROM billed
         JOIN customers c ON c.id = billed.id
         LEFT JOIN taken ON taken.id = billed.id
        WHERE c.is_active = 1 AND c.deleted_at IS NULL
     )
     SELECT
       (SELECT COUNT(*) FROM balances WHERE owed > 0) AS customers,
       (SELECT COALESCE(SUM(owed), 0) FROM balances WHERE owed > 0) AS total,
       (SELECT COUNT(*) FROM balances WHERE credit_limit > 0 AND owed > credit_limit) AS over_limit,
       (SELECT id   FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_id,
       (SELECT name FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_name,
       (SELECT owed FROM balances WHERE owed > 0 ORDER BY owed DESC, name LIMIT 1) AS worst_owed`,
  )

  return {
    total: (row?.total ?? 0) as Money,
    customers: row?.customers ?? 0,
    overLimit: row?.over_limit ?? 0,
    worst: row?.worst_id
      ? { id: row.worst_id, name: row.worst_name ?? '', outstanding: (row.worst_owed ?? 0) as Money }
      : null,
  }
}

/* ------------------------------------------------------- advance credit --- */

export interface AdvanceReceipt {
  paymentId: string
  docNo: string
  postingDate: string
  /** What is still unspent out of that receipt. */
  left: Money
}

export interface AdvanceCredit {
  /** What the shop is holding for this customer, over and above any bill. */
  amount: Money
  /** The receipts it came out of, oldest first — the order it is spent in. */
  receipts: AdvanceReceipt[]
}

/**
 * Money the shop is holding that belongs to the customer.
 *
 * A customer who owed 710 and handed over 1,200 is 490 in credit. That 490 has
 * always been in the database — it is the part of the receipt no allocation
 * points at — and it has never been shown anywhere. The Credit list read the
 * customer as owing nothing, which is true and is not the whole truth: the shop
 * owes *them*, and nothing on any screen said so.
 *
 * ## Why it is not simply a negative balance
 *
 * Because the two are answers to different questions and a shop acts on them
 * differently. "Owes nothing" ends a conversation; "we are holding 490 of
 * yours" starts one, and the answer is either to knock it off the next bill or
 * to hand it back. A single signed number with a minus in front of it is how
 * the statement used to put it — "Balance due -490.00" — which reads as an
 * error in the arithmetic rather than as money.
 *
 * ## Refunds come off the top
 *
 * A refund is not tied to the receipt it came out of, because a customer taking
 * 200 back does not care which of three receipts it is drawn from. So the
 * advance is what was over-received less what has been handed back, and the
 * per-receipt list is the order it would be spent in rather than a set of
 * separate pots.
 */
export async function advanceCredit(db: SqlDriver, customerId: string): Promise<AdvanceCredit> {
  const receipts = await db.query<{
    id: string; doc_no: string; posting_date: string; left: number
  }>(
    `SELECT pe.id, pe.doc_no, pe.posting_date,
            pe.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                   WHERE pa.payment_id = pe.id), 0) AS left
       FROM payment_entries pe
      WHERE pe.customer_id = ? AND pe.party_type = 'customer'
        AND pe.docstatus = 1 AND pe.direction = 'in'
      ORDER BY pe.posting_date, pe.doc_no`,
    [customerId],
  )

  const handedBack = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_entries
      WHERE customer_id = ? AND party_type = 'customer'
        AND docstatus = 1 AND direction = 'out'`,
    [customerId],
  )

  const over = receipts.filter((r) => r.left > 0)
  const total = over.reduce((sum, r) => sum + r.left, 0) - (handedBack?.total ?? 0)

  return {
    amount: paiseOrZero(total),
    receipts: over.map((r) => ({
      paymentId: r.id,
      docNo: r.doc_no,
      postingDate: r.posting_date,
      left: r.left as Money,
    })),
  }
}

/** Never below zero: more handed back than held would be a bug, not a debt. */
function paiseOrZero(n: number): Money {
  return Math.max(0, n) as Money
}

export type ApplyAdvanceResult =
  | { ok: true; applied: Money; allocations: PaymentAllocation[] }
  | { ok: false; code: 'NO_CREDIT' }
  | { ok: false; code: 'NOTHING_OWED' }

/**
 * Spends a customer's advance against what they now owe.
 *
 * This is the whole of "redeemed on a future bill", and it needs nothing the
 * schema did not already have: an allocation from the over-paid receipt to the
 * new bill is exactly what redeeming means, and it is the same row a payment
 * taken today would write.
 *
 * Oldest receipt first, and oldest bill first inside that, which is what
 * `planAllocation` does with a payment handed over at the counter. A shop that
 * spent the newest money first would leave the oldest sitting there for ever
 * and answer "how long have we been holding this" wrongly.
 *
 * No money moves, so no cash movement is posted and no drawer is touched. What
 * changes is which bills the money the shop already has is pointed at.
 */
export async function applyAdvance(
  db: SqlDriver,
  input: { customerId: string; actorId: string; billId?: string; now?: Date },
): Promise<ApplyAdvanceResult> {
  const credit = await advanceCredit(db, input.customerId)
  if (credit.amount <= 0) return { ok: false, code: 'NO_CREDIT' }

  const open = (await loadOpenBills(db, input.customerId))
    .filter((b) => (input.billId ? b.id === input.billId : true))
    .filter((b) => sub(b.creditTotal, b.allocated) > 0)
    .sort((a, b) => a.postingDate.localeCompare(b.postingDate))
  if (open.length === 0) return { ok: false, code: 'NOTHING_OWED' }

  /* Two queues drained against each other: receipts with money left in them,
     and bills with money owed on them. Each step writes one allocation for the
     smaller of the two, which is what keeps a receipt from over-allocating and
     a bill from being over-paid. */
  const purse = credit.receipts.map((r) => ({ id: r.paymentId, left: r.left as number }))
  const owed = open.map((b) => ({ id: b.id, due: sub(b.creditTotal, b.allocated) as number }))

  const written: { paymentId: string; billId: string; amount: number }[] = []
  let spendable = credit.amount as number

  for (const bill of owed) {
    for (const receipt of purse) {
      if (bill.due <= 0 || spendable <= 0) break
      if (receipt.left <= 0) continue
      const take = Math.min(bill.due, receipt.left, spendable)
      if (take <= 0) continue
      written.push({ paymentId: receipt.id, billId: bill.id, amount: take })
      receipt.left -= take
      bill.due -= take
      spendable -= take
    }
  }

  if (written.length === 0) return { ok: false, code: 'NOTHING_OWED' }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    for (const row of written) {
      /* A receipt already pointing at this bill gets its allocation raised
         rather than a second row: `payment_allocations` is unique on
         (payment_id, bill_id), and two rows for one pair would be the same
         money counted twice by every query that sums them. */
      await tx.execute(
        `INSERT INTO payment_allocations (id, payment_id, bill_id, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (payment_id, bill_id) DO UPDATE SET amount = amount + excluded.amount`,
        [newId(), row.paymentId, row.billId, row.amount],
      )
    }
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries',
      entityId: written[0]!.paymentId,
      action: 'update',
      after: { applied_advance: written.reduce((t, r) => t + r.amount, 0), bills: open.length },
    })
    void nowIso
  })

  const applied = written.reduce((t, r) => t + r.amount, 0) as Money
  return {
    ok: true,
    applied,
    allocations: written.map((r) => ({ billId: r.billId, amount: r.amount as Money })),
  }
}

export type RefundAdvanceResult =
  | { ok: true; paymentId: string; docNo: string; refunded: Money; left: Money }
  | { ok: false; code: 'INVALID_AMOUNT' }
  | { ok: false; code: 'MORE_THAN_HELD'; requested: Money; held: Money }

/**
 * Hands a customer's advance back to them.
 *
 * Recorded as a receipt going the other way — migration 035 carries why that is
 * a column on `payment_entries` rather than a table of its own. It is a
 * document in the same series with a number, a date and a person against it,
 * because a shopkeeper taking money out of the drawer needs the same paper
 * trail as one putting it in, and rather more.
 *
 * ## It refuses to hand back more than it holds
 *
 * Not for tidiness. Refunding past the advance would take the shop into a
 * negative advance, which is the same arithmetic as the customer owing money —
 * and the money would then be owed with no bill behind it, invisible to the
 * khata and to every figure on the Credit page. A shop that wants to lend
 * somebody money is doing something else, and should do it somewhere it can be
 * seen.
 *
 * The drawer moves, so this posts a cash movement out of the open session —
 * unlike `applyAdvance`, where nothing leaves the shop.
 */
export async function refundAdvance(
  db: SqlDriver,
  input: {
    customerId: string
    amount: Money
    method: ReceiptMethod
    reference?: string
    notes?: string
    registerPrefix?: string
    registerId?: string
    actorId: string
    now?: Date
  },
): Promise<RefundAdvanceResult> {
  if (input.amount <= 0) return { ok: false, code: 'INVALID_AMOUNT' }

  const held = (await advanceCredit(db, input.customerId)).amount
  if (input.amount > held) {
    return { ok: false, code: 'MORE_THAN_HELD', requested: input.amount, held }
  }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)
  const paymentId = newId()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'payment', input.registerPrefix ?? 'MR', now)

    await tx.execute(
      `INSERT INTO payment_entries
         (id, doc_no, docstatus, party_type, customer_id, posting_date, method, amount,
          direction, reference, notes, created_by, created_at, updated_at)
       VALUES (?, ?, 1, 'customer', ?, ?, ?, ?, 'out', ?, ?, ?, ?, ?)`,
      [
        paymentId, docNo, input.customerId, postingDate, input.method, input.amount,
        input.reference ?? null, input.notes ?? null, input.actorId, nowIso, nowIso,
      ],
    )

    if (input.registerId && input.method !== 'adjustment') {
      const session = await openSessionFor(tx, input.registerId)
      if (session) {
        await postCashMovement(tx, {
          sessionId: session,
          direction: 'out',
          amount: input.amount,
          method: input.method,
          sourceType: 'customer_refund',
          sourceId: paymentId,
          reference: input.reference ?? null,
          userId: input.actorId,
          now,
        })
      }
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: paymentId, action: 'submit',
      docstatusTo: SUBMITTED,
      after: { amount: input.amount, direction: 'out', held_before: held },
    })
  })

  return {
    ok: true,
    paymentId,
    docNo,
    refunded: input.amount,
    left: sub(held, input.amount),
  }
}

export interface CustomerStatementRow {
  billId: string
  docNo: string
  postingDate: string
  creditTotal: Money
  allocated: Money
  outstanding: Money
}

export async function customerStatement(db: SqlDriver, customerId: string): Promise<CustomerStatementRow[]> {
  const bills = await loadOpenBills(db, customerId)
  return bills
    .map((b) => ({
      billId: b.id,
      docNo: b.docNo,
      postingDate: b.postingDate,
      creditTotal: b.creditTotal,
      allocated: b.allocated,
      outstanding: sub(b.creditTotal, b.allocated),
    }))
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => a.postingDate.localeCompare(b.postingDate))
}

/* ------------------------------------------------ the rest of the khata --- */

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
  const rows = await db.query<{
    id: string; doc_no: string; posting_date: string; method: string
    amount: number; reference: string | null; notes: string | null; docstatus: number
  }>(
    `SELECT id, doc_no, posting_date, method, amount, reference, notes, docstatus
       FROM payment_entries
      WHERE customer_id = ? AND party_type = 'customer'
      ORDER BY posting_date DESC, created_at DESC
      LIMIT ?`,
    [customerId, limit],
  )

  const out: CustomerPayment[] = []
  for (const r of rows) {
    const allocs = await db.query<{ doc_no: string; amount: number }>(
      `SELECT b.doc_no, pa.amount FROM payment_allocations pa
         JOIN bills b ON b.id = pa.bill_id
        WHERE pa.payment_id = ?
        ORDER BY b.posting_date`,
      [r.id],
    )
    out.push({
      paymentId: r.id,
      docNo: r.doc_no,
      postingDate: r.posting_date,
      method: r.method as ReceiptMethod,
      amount: r.amount as Money,
      reference: r.reference,
      notes: r.notes,
      docstatus: r.docstatus,
      allocatedTo: allocs.map((a) => ({ docNo: a.doc_no, amount: a.amount as Money })),
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
  | { ok: true; billId: string; docNo: string }
  | { ok: false; code: 'INVALID_AMOUNT' }
  | { ok: false; code: 'ALREADY_SET'; docNo: string }

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
  if (input.amount <= 0) return { ok: false, code: 'INVALID_AMOUNT' }

  const existing = await db.get<{ doc_no: string }>(
    `SELECT doc_no FROM bills WHERE customer_id = ? AND kind = 'opening' AND docstatus = 1`,
    [input.customerId],
  )
  if (existing) return { ok: false, code: 'ALREADY_SET', docNo: existing.doc_no }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const postingDate = input.asOf ?? businessDate(now)
  const billId = newId()

  const customer = await db.get<{ name: string }>(`SELECT name FROM customers WHERE id = ?`, [input.customerId])

  let docNo = ''
  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'bill', input.registerPrefix ?? 'OB', now)
    await tx.execute(
      `INSERT INTO bills
         (id, doc_no, docstatus, kind, register_id, customer_id, customer_name, posting_date,
          subtotal, discount, taxable_total, tax_total, round_off, grand_total,
          paid_total, credit_total, notes, created_by, created_at, updated_at)
       VALUES (?, ?, 1, 'opening', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 0, ?, ?, ?, ?, ?)`,
      [
        billId, docNo, input.registerId, input.customerId, customer?.name ?? null, postingDate,
        input.amount, input.amount, input.note ?? 'Balance carried over', input.actorId, nowIso, nowIso,
      ],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'bills', entityId: billId, action: 'submit',
      docstatusTo: SUBMITTED,
      after: { kind: 'opening', amount: input.amount, posting_date: postingDate },
    })
  })

  return { ok: true, billId, docNo }
}

export type StatementKind =
  /** What they owed before this shop started keeping the account here. */
  | 'opening'
  /** Goods taken. */
  | 'bill'
  /** Paid there and then, when the bill was made. */
  | 'counter'
  /** Paid later, against the account. */
  | 'receipt'
  /** Goods came back. */
  | 'return'
  /** Given up on. */
  | 'writeoff'
  /** Money the shop was holding, handed back. */
  | 'refund'

export interface StatementEntry {
  kind: StatementKind
  id: string
  docNo: string
  postingDate: string
  /** What the line says on the page, already in words. */
  description: string
  /** Increases what they owe. */
  debit: Money
  /** Reduces it. */
  credit: Money
  /** What is owed after this line — the figure the customer reads. */
  balance: Money
}

export interface CustomerAccount {
  /** Owed at the start of the window. Zero when the window is the whole account. */
  openingBalance: Money
  entries: StatementEntry[]
  /**
   * Owed at the end of it. Negative when the shop is the one holding money.
   *
   * Kept signed rather than clamped, because a statement has to add up: the
   * closing figure is the opening figure plus every line between, and a number
   * that had been floored at zero would make the page stop reconciling. What a
   * screen should *say* about a negative one is `advance` below, which is the
   * same money with the sign taken off and a name put on it.
   */
  closingBalance: Money
  /**
   * What the shop is holding for them, over and above any bill.
   *
   * Zero for almost every customer. It is not simply `-closingBalance`: a
   * customer can be in credit on their receipts and owing on a bill raised
   * since, and the two figures answer different questions.
   */
  advance: Money
  /** The three figures a customer looks for at the bottom of a statement. */
  totals: { bought: Money; paid: Money; returned: Money }
}

/**
 * A customer's account, the way a bank states one.
 *
 * The khata ledger this replaces listed only what had been put on credit, so a
 * customer who paid cash for eleven months appeared to have bought nothing —
 * no use as a statement, because the first thing anybody checks is whether
 * their purchases are all there.
 *
 * So every document appears, and the balance still means exactly one thing:
 * what is owed right now. A bill is a debit for its full value and the money
 * handed over at the counter is a credit on the same day, which nets a cash
 * sale to nothing while still showing it. That is the two-line shape a bank
 * statement uses, and it is what lets the balance be read at any row rather
 * than only at the bottom.
 *
 * The one trap is a return refunded onto the account: that refund raises a
 * credit note, which is a payment entry, so counting both the goods coming back
 * and the credit note would take the balance down twice for one lot of goods.
 * The return carries the credit and the note it raised is left out —
 * `sales_returns.credit_note_id` names it, so there is nothing to guess.
 */
export async function customerAccount(
  db: SqlDriver,
  customerId: string,
  range: { from?: string; to?: string } = {},
): Promise<CustomerAccount> {
  const from = range.from ?? null
  const to = range.to ?? null

  const bills = await db.query<{
    id: string; doc_no: string; posting_date: string; kind: string
    grand_total: number; credit_total: number
  }>(
    `SELECT id, doc_no, posting_date, kind, grand_total, credit_total
       FROM bills WHERE customer_id = ? AND docstatus = 1`,
    [customerId],
  )

  const counterPaid = await db.query<{ bill_id: string; method: string; paid: number }>(
    `SELECT bp.bill_id, bp.method, SUM(bp.amount) AS paid
       FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id
      WHERE b.customer_id = ? AND b.docstatus = 1 AND bp.method <> 'credit'
      GROUP BY bp.bill_id, bp.method`,
    [customerId],
  )

  const returns = await db.query<{
    id: string; doc_no: string; posting_date: string; refund_total: number
    refund_method: string; credit_note_id: string | null
  }>(
    `SELECT r.id, r.doc_no, r.posting_date, r.refund_total, r.refund_method, r.credit_note_id
       FROM sales_returns r JOIN bills b ON b.id = r.bill_id
      WHERE b.customer_id = ? AND r.docstatus = 1`,
    [customerId],
  )

  const payments = await db.query<{
    id: string; doc_no: string; posting_date: string; amount: number
    method: string; reference: string | null; direction: string
  }>(
    `SELECT id, doc_no, posting_date, amount, method, reference, direction
       FROM payment_entries
      WHERE customer_id = ? AND party_type = 'customer' AND docstatus = 1`,
    [customerId],
  )

  const raisedByReturn = new Set(
    returns.map((r) => r.credit_note_id).filter((id): id is string => id !== null),
  )

  type Row = Omit<StatementEntry, 'balance'>
  const rows: Row[] = []

  for (const b of bills) {
    rows.push({
      kind: b.kind === 'opening' ? 'opening' : 'bill',
      id: b.id,
      docNo: b.doc_no,
      postingDate: b.posting_date,
      description: b.kind === 'opening' ? 'Balance brought forward' : 'Goods',
      debit: b.grand_total as Money,
      credit: ZERO,
    })
  }

  for (const p of counterPaid) {
    const bill = bills.find((b) => b.id === p.bill_id)
    if (!bill) continue
    rows.push({
      kind: 'counter',
      id: `${p.bill_id}-${p.method}`,
      docNo: bill.doc_no,
      postingDate: bill.posting_date,
      description: p.method === 'loyalty'
        ? 'Paid with points'
        : `Paid at the counter — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.paid as Money,
    })
  }

  for (const r of returns) {
    const onAccount = r.credit_note_id !== null
    rows.push({
      kind: 'return',
      id: r.id,
      docNo: r.doc_no,
      postingDate: r.posting_date,
      description: onAccount
        ? 'Goods returned — put on your account'
        : `Goods returned — refunded in ${titleOf(r.refund_method).toLowerCase()}`,
      debit: ZERO,
      // Money handed back leaves the account where it was: the goods went back
      // and so did the cash.
      credit: (onAccount ? r.refund_total : 0) as Money,
    })
  }

  for (const p of payments) {
    if (raisedByReturn.has(p.id)) continue

    /* Money handed back out of the drawer. A debit, because the account runs
       from the shop's side: what the customer owes goes up by exactly what they
       were given, which takes an account sitting at -490 back to zero rather
       than to -980. */
    if (p.direction === 'out') {
      rows.push({
        kind: 'refund',
        id: p.id,
        docNo: p.doc_no,
        postingDate: p.posting_date,
        description: `Credit refunded — ${titleOf(p.method)}`,
        debit: p.amount as Money,
        credit: ZERO,
      })
      continue
    }

    const written = p.method === 'adjustment' && p.reference === 'Written off'
    rows.push({
      kind: written ? 'writeoff' : 'receipt',
      id: p.id,
      docNo: p.doc_no,
      postingDate: p.posting_date,
      description: written
        ? 'Written off'
        : p.method === 'adjustment'
          ? (p.reference ?? 'Adjustment')
          : `Payment — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.amount as Money,
    })
  }

  /* Oldest first, and within a day a bill before the money paid against it. The
     total is the same either way, but a statement is read down the page and a
     receipt listed above the bill it settles looks like an error. */
  const order: Record<StatementKind, number> = {
    opening: 0, bill: 1, counter: 2, return: 3, receipt: 4, writeoff: 5,
    // Last within a day: money can only be handed back after it was handed
    // over, and a refund listed above the receipt it came out of reads as the
    // shop paying somebody who had paid nothing.
    refund: 6,
  }
  rows.sort((a, b) => (
    a.postingDate !== b.postingDate
      ? a.postingDate.localeCompare(b.postingDate)
      : order[a.kind] !== order[b.kind]
        ? order[a.kind] - order[b.kind]
        : a.docNo.localeCompare(b.docNo)
  ))

  let running = 0
  let openingBalance = 0
  const entries: StatementEntry[] = []
  let bought = 0
  let paid = 0
  let returned = 0

  for (const row of rows) {
    running += row.debit - row.credit

    /* Anything before the window is not listed; it is the figure the window
       starts from, which is what makes a dated statement add up rather than
       begin in the middle of a balance nobody can account for. */
    if (from !== null && row.postingDate < from) { openingBalance = running; continue }
    if (to !== null && row.postingDate > to) continue

    if (row.kind === 'bill' || row.kind === 'opening') bought += row.debit
    if (row.kind === 'counter' || row.kind === 'receipt') paid += row.credit
    // Counted off the goods rather than off the credit, because a refund handed
    // back in cash is still a return even though the account did not move.
    if (row.kind === 'return') {
      const r = returns.find((x) => x.id === row.id)
      returned += r?.refund_total ?? 0
    }

    entries.push({ ...row, balance: running as Money })
  }

  return {
    openingBalance: openingBalance as Money,
    entries,
    closingBalance: running as Money,
    advance: (await advanceCredit(db, customerId)).amount,
    totals: {
      bought: bought as Money,
      paid: paid as Money,
      returned: returned as Money,
    },
  }
}

function titleOf(method: string): string {
  return method === 'upi' ? 'UPI' : method.charAt(0).toUpperCase() + method.slice(1)
}
