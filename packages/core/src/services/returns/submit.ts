import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { ZERO } from '../../money.js'
import { qty, subQty } from '../../quantity.js'
import { splitRefund } from '../../domain/returns.js'
import { DRAFT, SUBMITTED, assertCanApply, parseDocStatus } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { nextDocNo, seriesPrefix } from '../numbering.js'
import { loadReturn } from './read.js'
import { clawBackPoints, outstandingFor, payRefund, refundBasis, restorePoints } from './refund.js'
import type { SubmitReturnResult } from './types.js'
import { restock } from './restock.js'
import { requirePermission } from '../../integrity/permissions.js'
import { postVoucherGl } from '../ledger.js'

export async function submitReturn(
  db: SqlDriver,
  input: { returnId: string; actorId: string; now?: Date },
): Promise<SubmitReturnResult> {
  await requirePermission(db, input.actorId, 'sales_return', 'submit')
  const now = input.now ?? new Date()
  const ret = await loadReturn(db, input.returnId)
  assertCanApply('return', parseDocStatus(ret.docstatus), 'submit')

  const [bill] = await q(db)
    .select({
      docstatus: schema.bills.docstatus,
      registerId: schema.bills.registerId,
      customerId: schema.bills.customerId,
      grandTotal: schema.bills.grandTotal,
      postingDate: schema.bills.postingDate,
      docNo: schema.bills.docNo,
    })
    .from(schema.bills)
    .where(eq(schema.bills.id, ret.billId))
  if (!bill || bill.docstatus !== SUBMITTED) return { ok: false, code: 'BILL_CANCELLED' }

  const split = splitRefund(ret.refundTotal, await refundBasis(db, ret.billId))

  // A refund onto the account can only take off what is owed. This product has
  // no store-credit wallet, and inventing one here would leave money sitting
  // somewhere no screen adds up. Cash, or a smaller return.
  if (ret.refundMethod === 'credit' && split.cash > 0) {
    if (!bill.customerId) return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding: ZERO }
    const outstanding = await outstandingFor(db, bill.customerId)
    if (outstanding < split.cash) {
      return { ok: false, code: 'NOTHING_TO_CREDIT', refund: split.cash, outstanding }
    }
  }

  const lines = await q(db)
    .select({
      billItemId: schema.salesReturnItems.billItemId,
      productId: schema.salesReturnItems.productId,
      qty: schema.salesReturnItems.qty,
      baseQty: schema.salesReturnItems.baseQty,
    })
    .from(schema.salesReturnItems)
    .where(eq(schema.salesReturnItems.returnId, input.returnId))

  const [register] = await q(db)
    .select({ prefix: schema.registers.prefix })
    .from(schema.registers)
    .where(eq(schema.registers.id, bill.registerId))
  const nowIso = now.toISOString()
  let docNo = ''
  let creditNoteDocNo: string | null = null

  const refused = await db.transaction(async (tx): Promise<SubmitReturnResult | null> => {
    await recheckDocStatus(tx, 'sales_returns', input.returnId, 'return', 'submit')

    /* Checked again here, where it cannot change underneath: the draft was
       measured against `returned_qty` as it stood when it was made, and another
       return against the same line may have been submitted since. */
    for (const line of lines) {
      const [item] = await q(tx)
        .select({ qty: schema.billItems.qty, returnedQty: schema.billItems.returnedQty })
        .from(schema.billItems)
        .where(eq(schema.billItems.id, line.billItemId))
      const returnable = item ? subQty(item.qty, item.returnedQty) : qty(0)
      if (line.qty > returnable) {
        return { ok: false, code: 'EXCEEDS_RETURNABLE', billItemId: line.billItemId, requested: line.qty, returnable }
      }
    }

    /* This till's series, not the bill's. A return is minted wherever the
       customer walks back in, and two tills refunding against one bill while
       apart both drew from the bill's counter's series -- both minted the same
       credit note number, and after sync each till quarantined the other's
       return, so a refund taken on one never reached the other. The bill's
       prefix is only the fallback for a till with no counter of its own. */
    docNo = await nextDocNo(tx, 'return', await seriesPrefix(tx, register?.prefix ?? 'XX'), now)

    await restock(tx, {
      returnId: input.returnId,
      billId: ret.billId,
      postingDate: ret.postingDate,
      actorId: input.actorId,
      lines,
    })

    for (const line of lines) {
      /* Read-modify-write in one statement rather than two: the figure this
         adds to is the one the other till may be adding to at the same moment. */
      await q(tx).update(schema.billItems)
        .set({ returnedQty: sql`${schema.billItems.returnedQty} + ${line.qty}` })
        .where(eq(schema.billItems.id, line.billItemId))
    }

    creditNoteDocNo = await payRefund(tx, {
      returnId: input.returnId,
      method: ret.refundMethod,
      amount: split.cash,
      customerId: bill.customerId,
      reference: `${docNo} against ${bill.docNo}`,
      reason: ret.reason,
      registerId: bill.registerId,
      registerPrefix: register?.prefix ?? null,
      actorId: input.actorId,
      now,
    })

    if (split.pointsRestored > 0) await restorePoints(tx, ret.billId, split.pointsRestored)
    if (split.pointsRemoved > 0) await clawBackPoints(tx, ret.billId, split.pointsRemoved, nowIso)

    await q(tx).update(schema.salesReturns)
      .set({
        docstatus: SUBMITTED,
        docNo,
        refundCash: split.cash,
        pointsRestored: split.pointsRestored,
        pointsRemoved: split.pointsRemoved,
        updatedAt: nowIso,
      })
      .where(eq(schema.salesReturns.id, input.returnId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: input.returnId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: ret.docNo },
      after: {
        doc_no: docNo,
        refund_cash: split.cash,
        points_restored: split.pointsRestored,
        points_removed: split.pointsRemoved,
      },
    })
    await postVoucherGl(tx, 'sales_return', input.returnId)
    return null
  })
  if (refused) return refused

  return {
    ok: true,
    returnId: input.returnId,
    docNo,
    refundTotal: ret.refundTotal,
    refundCash: split.cash,
    pointsRestored: split.pointsRestored,
    pointsClawedBack: split.pointsRemoved,
    creditNoteDocNo,
  }
}
