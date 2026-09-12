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
