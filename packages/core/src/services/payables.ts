import { eq, sql, desc, and } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import { businessDate } from '../dates.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import { nextDocNo, seriesPrefix } from './numbering.js'
import { openSessionFor, postCashMovement } from './cash.js'
import { postVoucherGl } from './ledger.js'

/*
 * What the shop owes its suppliers, and paying them (065).
 *
 * Owed is worked out, never kept: the balance carried over from before (050),
 * plus every supplier's bill posted, less every payment made to them. The
 * supplier list sorts by it and the books carry the same figure in the
 * suppliers account, party by party.
 */

/**
 * What the shop owes a supplier, as SQL over `suppliers` -- for the list,
 * which sorts by it, so it is worked out in the query and not on the screen.
 *
 * raw: two correlated sums against the supplier row; a join would multiply one
 * by the other.
 */
export const OWED = sql<Money>`(
  (CASE WHEN ${schema.suppliers.openingAsOf} IS NULL THEN 0 ELSE ${schema.suppliers.openingBalance} END)
  + COALESCE((SELECT SUM(e.invoice_total) FROM stock_entries e
               WHERE e.supplier_id = suppliers.id AND e.docstatus = 1 AND e.entry_type = 'purchase'), 0)
  - COALESCE((SELECT SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE -p.amount END) FROM payment_entries p
               WHERE p.supplier_id = suppliers.id AND p.party_type = 'supplier' AND p.docstatus = 1), 0))`

/** How a supplier is paid. UPI covers a bank transfer; the account is "UPI and bank transfers". */
export type SupplierPaymentMethod = 'cash' | 'upi' | 'card'

export type PaySupplierResult =
  | { ok: true; paymentId: string; docNo: string }
  | { ok: false; code: 'INVALID_AMOUNT' }
  | { ok: false; code: 'NO_SUPPLIER' }

/**
 * A payment to a supplier: what the shop owes them goes down by it.
 *
 * Cash comes out of the drawer open at this counter, when one is, the way a
 * refund does; a transfer moves no drawer. Cancelled with `cancelPayment`,
 * like any other payment.
 */
export async function paySupplier(
  db: SqlDriver,
  input: {
    supplierId: string
    amount: Money
    method: SupplierPaymentMethod
    reference?: string | null
    notes?: string | null
    registerId?: string | null
    actorId: string
    now?: Date
  },
): Promise<PaySupplierResult> {
  await requirePermission(db, input.actorId, 'payment', 'create')
  if (!Number.isInteger(input.amount) || input.amount <= 0) return { ok: false, code: 'INVALID_AMOUNT' }
  const [supplier] = await q(db)
    .select({ id: schema.suppliers.id })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, input.supplierId))
  if (!supplier) return { ok: false, code: 'NO_SUPPLIER' }

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const paymentId = newId()

  const docNo = await db.transaction(async (tx) => {
    const no = await nextDocNo(tx, 'payment', await seriesPrefix(tx, 'MR'), now)
    await q(tx).insert(schema.paymentEntries).values({
      id: paymentId,
      docNo: no,
      docstatus: SUBMITTED,
      partyType: 'supplier',
      supplierId: input.supplierId,
      postingDate: businessDate(now),
      method: input.method,
      amount: input.amount,
      direction: 'out',
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    if (input.method === 'cash' && input.registerId) {
      const session = await openSessionFor(tx, input.registerId)
      if (session) {
        await postCashMovement(tx, {
          sessionId: session, direction: 'out', amount: input.amount, method: 'cash',
          sourceType: 'supplier_payment', sourceId: paymentId,
          reference: input.reference ?? null, userId: input.actorId, now,
        })
      }
    }

    await postVoucherGl(tx, 'payment', paymentId)
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'payment_entries', entityId: paymentId, action: 'submit', docstatusTo: SUBMITTED,
      after: { supplier_id: input.supplierId, amount: input.amount, method: input.method },
    })
    return no
  })

  return { ok: true, paymentId, docNo }
}

/** What the shop owes one supplier now. Negative: the supplier holds the shop's money. */
export async function supplierOwed(db: SqlDriver, supplierId: string): Promise<Money> {
  const [row] = await q(db)
    .select({ owed: OWED })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, supplierId))
  return (row?.owed ?? 0) as Money
}

export interface SupplierPayment {
  paymentId: string
  docNo: string
  postingDate: string
  method: string
  amount: Money
  reference: string | null
  cancelled: boolean
}

/** Payments made to a supplier, newest first, cancelled ones marked. */
export async function supplierPayments(db: SqlDriver, supplierId: string): Promise<SupplierPayment[]> {
  const rows = await q(db)
    .select({
      paymentId: schema.paymentEntries.id,
      docNo: schema.paymentEntries.docNo,
      postingDate: schema.paymentEntries.postingDate,
      method: schema.paymentEntries.method,
      amount: schema.paymentEntries.amount,
      reference: schema.paymentEntries.reference,
      docstatus: schema.paymentEntries.docstatus,
    })
    .from(schema.paymentEntries)
    .where(and(
      eq(schema.paymentEntries.supplierId, supplierId),
      eq(schema.paymentEntries.partyType, 'supplier'),
    ))
    .orderBy(desc(schema.paymentEntries.postingDate), desc(schema.paymentEntries.createdAt))
  return rows.map(({ docstatus, ...r }) => ({ ...r, cancelled: docstatus === 2 }))
}
