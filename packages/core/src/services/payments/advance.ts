import { eq, and, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { businessDate } from '../../dates.js'
import { newId } from '../../ids.js'
import { type Money, sub } from '../../money.js'
import type { PaymentAllocation } from '../../domain/credit.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { nextDocNo, seriesPrefix } from '../numbering.js'
import { openSessionFor, postCashMovement } from '../cash.js'
import { loadOpenBills } from './outstanding.js'
import type { ReceiptMethod } from './receipts.js'
import { requirePermission } from '../../integrity/permissions.js'
import { postVoucherGl } from '../ledger.js'

/*
 * Advance credit: money the shop is holding for a customer, taken before
 * anything was billed or left over after everything was settled.
 */

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
  await requirePermission(db, input.actorId, 'payment', 'create')
  /* The whole of it in one transaction. What the customer holds and what they
     owe are read and spent together; read first and spent after, two presses
     in a row measured the same advance and spent it twice. */
  return db.transaction((tx) => applyAdvanceIn(tx, input))
}

async function applyAdvanceIn(
  db: SqlDriver,
  input: { customerId: string; actorId: string; billId?: string },
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
export interface RefundAdvanceInput {
  customerId: string
  amount: Money
  method: ReceiptMethod
  reference?: string
  notes?: string
  registerPrefix?: string
  registerId?: string
  actorId: string
  now?: Date
}

export async function refundAdvance(
  db: SqlDriver,
  input: RefundAdvanceInput,
): Promise<RefundAdvanceResult> {
  await requirePermission(db, input.actorId, 'payment', 'create')
  if (input.amount <= 0) return { ok: false, code: 'INVALID_AMOUNT' }
  // What is held is read inside the transaction that pays it out, or two
  // refunds in a row could each be measured against the same balance.
  return db.transaction((tx) => refundAdvanceIn(tx, input))
}

async function refundAdvanceIn(
  db: SqlDriver,
  input: RefundAdvanceInput,
): Promise<RefundAdvanceResult> {

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
    await postVoucherGl(tx, 'payment', paymentId)

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
