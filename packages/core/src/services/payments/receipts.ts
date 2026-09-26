import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { businessDate } from '../../dates.js'
import { newId } from '../../ids.js'
import { type Money, ZERO, add, sub } from '../../money.js'
import { planAllocation, type PaymentAllocation } from '../../domain/credit.js'
import { SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { nextDocNo, seriesPrefix } from '../numbering.js'
import { openSessionFor, postCashMovement } from '../cash.js'
import { loadOpenBills } from './outstanding.js'

/*
 * Taking a payment, posting a return's credit against what is owed, and
 * cancelling a receipt taken by mistake.
 */

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

  /* A share of nothing or less is not a share. A negative one also lowered the
     total the check below compares against the payment, so ₹150 to one bill
     and −₹50 to another passed as a ₹100 receipt. */
  if (input.allocations?.some((a) => a.amount <= 0)) return { ok: false, code: 'INVALID_AMOUNT' }

  const now = input.now ?? new Date()
  const paymentId = newId()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)
  let docNo = ''
  let allocations: PaymentAllocation[] = []
  let unallocated: Money = ZERO

  /* Planned inside the transaction, against what is owed as of the write. Read
     before it, two receipts taken one after the other could both be measured
     against the same balance and together settle more than was due. */
  const refused = await db.transaction(async (tx): Promise<RecordPaymentResult | null> => {
    const openBills = await loadOpenBills(tx, input.customerId)

    if (input.allocations) {
      // One share per bill: the same bill named twice passed the due check once per entry.
      const byBill = new Map<string, Money>()
      for (const alloc of input.allocations) {
        byBill.set(alloc.billId, add(byBill.get(alloc.billId) ?? ZERO, alloc.amount))
      }
      const requested = add(...byBill.values())
      if (requested > input.amount) {
        return { ok: false, code: 'ALLOCATION_EXCEEDS_PAYMENT', payment: input.amount, allocated: requested }
      }
      for (const [billId, amount] of byBill) {
        const bill = openBills.find((b) => b.id === billId)
        const due = bill ? sub(bill.creditTotal, bill.allocated) : ZERO
        if (amount > due) {
          return { ok: false, code: 'OVER_ALLOCATED', billId, requested: amount, due }
        }
      }
      allocations = [...byBill].map(([billId, amount]) => ({ billId, amount }))
      unallocated = sub(input.amount, requested)
    } else {
      const plan = planAllocation(input.amount, openBills)
      allocations = plan.allocations
      unallocated = plan.unallocated
    }

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
    return null
  })
  if (refused) return refused

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
    await recheckDocStatus(tx, 'payment_entries', input.paymentId, 'payment', 'cancel')
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
