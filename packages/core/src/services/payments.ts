import { eq, and, ne, gt, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { businessDate } from '../dates.js'
import { newId } from '../ids.js'
import { type Money, ZERO, add, sub } from '../money.js'
import { planAllocation, totalOutstanding, type OpenBill, type PaymentAllocation } from '../domain/credit.js'
import { SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { nextDocNo, seriesPrefix } from './numbering.js'
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
    docNo = await nextDocNo(
      tx, 'payment', input.registerPrefix ?? await seriesPrefix(tx, 'MR'), now,
    )

    await q(tx).insert(schema.paymentEntries).values({
      id: paymentId,
      docNo,
      docstatus: SUBMITTED,
      partyType: 'customer',
      customerId: input.customerId,
      postingDate,
      method: input.method,
      amount: input.amount,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const alloc of allocations) {
      await q(tx).insert(schema.paymentAllocations).values({
        id: newId(),
        paymentId,
        billId: alloc.billId,
        amount: alloc.amount,
      })
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
  const docNo = await nextDocNo(
    tx, 'payment', input.registerPrefix ?? await seriesPrefix(tx, 'MR'), input.now,
  )

  await q(tx).insert(schema.paymentEntries).values({
    id: paymentId,
    docNo,
    docstatus: SUBMITTED,
    partyType: 'customer',
    customerId: input.customerId,
    postingDate: businessDate(input.now),
    method: 'adjustment',
    amount: input.amount,
    reference: input.reference,
    notes: input.notes ?? null,
    createdBy: input.actorId,
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  for (const alloc of plan.allocations) {
    await q(tx).insert(schema.paymentAllocations).values({
      id: newId(),
      paymentId,
      billId: alloc.billId,
      amount: alloc.amount,
    })
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
  const [row] = await q(db)
    .select({ docstatus: schema.paymentEntries.docstatus })
    .from(schema.paymentEntries)
    .where(eq(schema.paymentEntries.id, input.paymentId))
  if (!row) throw new Error(`unknown payment: ${input.paymentId}`)
  assertCanApply('payment', parseDocStatus(row.docstatus), 'cancel')

  await db.transaction(async (tx) => {
    await q(tx).update(schema.paymentEntries)
      .set({ docstatus: CANCELLED, updatedAt: now.toISOString() })
      .where(eq(schema.paymentEntries.id, input.paymentId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: input.paymentId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, paymentId: input.paymentId }
}

export async function loadOpenBills(db: SqlDriver, customerId: string): Promise<OpenBill[]> {
  /* raw: a correlated subquery, which the query builder has no shape for.
     Joining to the allocations instead would repeat the bill row once per
     payment against it, so a bill settled in instalments would count its own
     credit total once per instalment. `bills.id` is written out rather than
     interpolated because Drizzle renders a column reference unqualified inside
     a subquery, where a bare `id` binds to the allocation tables first. */
  const allocated = sql<Money>`COALESCE((
    SELECT SUM(pa.amount) FROM payment_allocations pa
      JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = ${SUBMITTED}
     WHERE pa.bill_id = bills.id), 0)`

  return q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      creditTotal: schema.bills.creditTotal,
      allocated,
    })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      gt(schema.bills.creditTotal, ZERO),
    ))
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
  /* raw: three common table expressions feeding six scalar sub-selects, and
     the one place in this file that still goes through the driver directly.

     The query builder has no shape for a WITH, and taking it through Drizzle as
     a raw fragment does not work either: the proxy hands raw rows back
     positionally, because a string of SQL tells it no column names. Reading
     `row.total` off that gives `undefined` -- which arithmetic turns into
     `NaN`, and a headline of NaN on the Credit page is a worse failure than the
     one this function was written to fix. So it stays as it is, named.

     Six separate round trips would read `bills` and `payment_allocations` six
     times to answer one screen.

     `balances` is every customer who has ever been billed on credit, with
       what they owe now. Starting from `billed` rather than from `customers`
       is deliberate: somebody who has never taken credit cannot owe anything,
       and on a shop with thousands of walk-in accounts that is most of the
       table.

       The two "worst" columns sort identically, name included, so a tie
       between two customers owing the same amount cannot return one person's
       name beside another person's figure. */
  const row = await db.get<{
    total: number; customers: number; over_limit: number
    worst_id: string | null; worst_name: string | null; worst_owed: number | null
  }>(
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
  /* raw: a correlated subquery, as in `loadOpenBills`. What is left in a
     receipt is what nothing points at, and a join to the allocations would
     repeat the receipt once per bill it has been spread across. */
  const left = sql<Money>`${schema.paymentEntries.amount} - COALESCE((
    SELECT SUM(pa.amount) FROM payment_allocations pa
     WHERE pa.payment_id = payment_entries.id), 0)`

  const receipts = await q(db)
    .select({
      id: schema.paymentEntries.id,
      docNo: schema.paymentEntries.docNo,
      postingDate: schema.paymentEntries.postingDate,
      left,
    })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.customerId, customerId),
      eq(schema.paymentEntries.partyType, 'customer'),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
      eq(schema.paymentEntries.direction, 'in'),
    ))
    .orderBy(schema.paymentEntries.postingDate, schema.paymentEntries.docNo)

  const [handedBack] = await q(db)
    .select({ total: sql<Money>`COALESCE(SUM(${schema.paymentEntries.amount}), 0)` })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.customerId, customerId),
      eq(schema.paymentEntries.partyType, 'customer'),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
      eq(schema.paymentEntries.direction, 'out'),
    ))

  const over = receipts.filter((r) => r.left > 0)
  const total = over.reduce<number>((sum, r) => sum + r.left, 0) - (handedBack?.total ?? 0)

  return {
    amount: paiseOrZero(total),
    receipts: over.map((r) => ({
      paymentId: r.id,
      docNo: r.docNo,
      postingDate: r.postingDate,
      left: r.left,
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
      await q(tx).insert(schema.paymentAllocations)
        .values({
          id: newId(),
          paymentId: row.paymentId,
          billId: row.billId,
          amount: row.amount as Money,
        })
        .onConflictDoUpdate({
          target: [schema.paymentAllocations.paymentId, schema.paymentAllocations.billId],
          set: { amount: sql`amount + excluded.amount` },
        })
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
    docNo = await nextDocNo(
      tx, 'payment', input.registerPrefix ?? await seriesPrefix(tx, 'MR'), now,
    )

    await q(tx).insert(schema.paymentEntries).values({
      id: paymentId,
      docNo,
      docstatus: SUBMITTED,
      partyType: 'customer',
      customerId: input.customerId,
      postingDate,
      method: input.method,
      amount: input.amount,
      direction: 'out',
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

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
    docNo = await nextDocNo(tx, 'bill', input.registerPrefix ?? `OB${at?.prefix ?? ''}`, now)
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

  const bills = await q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      kind: schema.bills.kind,
      grandTotal: schema.bills.grandTotal,
      creditTotal: schema.bills.creditTotal,
    })
    .from(schema.bills)
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
    ))

  const counterPaid = await q(db)
    .select({
      billId: schema.billPayments.billId,
      method: schema.billPayments.method,
      paid: sql<Money>`SUM(${schema.billPayments.amount})`,
    })
    .from(schema.billPayments)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billPayments.billId))
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.bills.docstatus, SUBMITTED),
      ne(schema.billPayments.method, 'credit'),
    ))
    .groupBy(schema.billPayments.billId, schema.billPayments.method)

  const returns = await q(db)
    .select({
      id: schema.salesReturns.id,
      docNo: schema.salesReturns.docNo,
      postingDate: schema.salesReturns.postingDate,
      refundTotal: schema.salesReturns.refundTotal,
      refundMethod: schema.salesReturns.refundMethod,
      creditNoteId: schema.salesReturns.creditNoteId,
    })
    .from(schema.salesReturns)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(
      eq(schema.bills.customerId, customerId),
      eq(schema.salesReturns.docstatus, SUBMITTED),
    ))

  const payments = await q(db)
    .select({
      id: schema.paymentEntries.id,
      docNo: schema.paymentEntries.docNo,
      postingDate: schema.paymentEntries.postingDate,
      amount: schema.paymentEntries.amount,
      method: schema.paymentEntries.method,
      reference: schema.paymentEntries.reference,
      direction: schema.paymentEntries.direction,
    })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.customerId, customerId),
      eq(schema.paymentEntries.partyType, 'customer'),
      eq(schema.paymentEntries.docstatus, SUBMITTED),
    ))

  const raisedByReturn = new Set(
    returns.map((r) => r.creditNoteId).filter((id): id is string => id !== null),
  )

  type Row = Omit<StatementEntry, 'balance'>
  const rows: Row[] = []

  for (const b of bills) {
    rows.push({
      kind: b.kind === 'opening' ? 'opening' : 'bill',
      id: b.id,
      docNo: b.docNo,
      postingDate: b.postingDate,
      description: b.kind === 'opening' ? 'Balance brought forward' : 'Goods',
      debit: b.grandTotal,
      credit: ZERO,
    })
  }

  for (const p of counterPaid) {
    const bill = bills.find((b) => b.id === p.billId)
    if (!bill) continue
    rows.push({
      kind: 'counter',
      id: `${p.billId}-${p.method}`,
      docNo: bill.docNo,
      postingDate: bill.postingDate,
      description: p.method === 'loyalty'
        ? 'Paid with points'
        : `Paid at the counter — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.paid,
    })
  }

  for (const r of returns) {
    const onAccount = r.creditNoteId !== null
    rows.push({
      kind: 'return',
      id: r.id,
      docNo: r.docNo,
      postingDate: r.postingDate,
      description: onAccount
        ? 'Goods returned — put on your account'
        : `Goods returned — refunded in ${titleOf(r.refundMethod).toLowerCase()}`,
      debit: ZERO,
      // Money handed back leaves the account where it was: the goods went back
      // and so did the cash.
      credit: onAccount ? r.refundTotal : ZERO,
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
        docNo: p.docNo,
        postingDate: p.postingDate,
        description: `Credit refunded — ${titleOf(p.method)}`,
        debit: p.amount,
        credit: ZERO,
      })
      continue
    }

    const written = p.method === 'adjustment' && p.reference === 'Written off'
    rows.push({
      kind: written ? 'writeoff' : 'receipt',
      id: p.id,
      docNo: p.docNo,
      postingDate: p.postingDate,
      description: written
        ? 'Written off'
        : p.method === 'adjustment'
          ? (p.reference ?? 'Adjustment')
          : `Payment — ${titleOf(p.method)}`,
      debit: ZERO,
      credit: p.amount,
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
      returned += r?.refundTotal ?? 0
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
