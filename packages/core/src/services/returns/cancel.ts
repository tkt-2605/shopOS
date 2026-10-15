import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { reverseVoucher } from '../stock.js'
import { reverseBatches } from '../batches.js'
import { closedFor, type PeriodClosed } from '../books.js'
import { loadReturn } from './read.js'
import { regrantPoints, unrestorePoints } from './refund.js'
import { requirePermission } from '../../integrity/permissions.js'
import { reverseVoucherGl } from '../ledger.js'

export async function cancelReturn(
  db: SqlDriver,
  input: { returnId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true; returnId: string } | PeriodClosed> {
  await requirePermission(db, input.actorId, 'sales_return', 'cancel')
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'cancel')
  const closed = await closedFor(db, ret.postingDate)
  if (closed) return closed

  const lines = await q(db)
    .select({ billItemId: schema.salesReturnItems.billItemId, qty: schema.salesReturnItems.qty })
    .from(schema.salesReturnItems)
    .where(eq(schema.salesReturnItems.returnId, input.returnId))
  const nowIso = now.toISOString()

  await db.transaction(async (tx) => {
    await recheckDocStatus(tx, 'sales_returns', input.returnId, 'return', 'cancel')
    await reverseVoucher(tx, 'sales_return', input.returnId, ret.postingDate, input.actorId)
    await reverseBatches(tx, 'sales_return', input.returnId, ret.postingDate, input.actorId)
    await reverseVoucherGl(tx, 'sales_return', input.returnId)

    /* Taken off, but never below what the returns still standing add up to.
       The figure is held to the line's quantity, so a line refunded twice on two
       counters -- one sold, two back -- stores one; taking this return's one off
       that read nought while the other return still stood, and this till parted
       from every till that heard of the cancellation by merge, which recounts
       (`reconcileReturnedQty`). */
    for (const line of lines) {
      await q(tx).update(schema.billItems)
        .set({
          returnedQty: sql`MAX(${schema.billItems.returnedQty} - ${line.qty}, MIN(${schema.billItems.qty}, COALESCE((
            SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
             WHERE ri.bill_item_id = ${schema.billItems.id} AND r.docstatus = 1 AND r.id <> ${input.returnId}), 0)))`,
        })
        .where(eq(schema.billItems.id, line.billItemId))
    }

    // Everything the return handed back is taken back, in the same currencies.
    if (ret.creditNoteId) {
      await q(tx).update(schema.paymentEntries)
        .set({ docstatus: CANCELLED, updatedAt: nowIso })
        .where(eq(schema.paymentEntries.id, ret.creditNoteId))
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'payment_entries', entityId: ret.creditNoteId, action: 'cancel',
        docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
        after: { cancel_reason: `${ret.docNo} cancelled` },
      })
    }
    if (ret.pointsRestored > 0) await unrestorePoints(tx, ret.billId, ret.pointsRestored)
    if (ret.pointsRemoved > 0) await regrantPoints(tx, ret.billId, ret.pointsRemoved)

    await q(tx).update(schema.salesReturns)
      .set({ docstatus: CANCELLED, updatedAt: nowIso })
      .where(eq(schema.salesReturns.id, input.returnId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, returnId: input.returnId }
}
