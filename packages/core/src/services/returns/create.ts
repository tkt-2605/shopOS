import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { businessDate } from '../../dates.js'
import { newId } from '../../ids.js'
import { DRAFT } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { computeLines } from './compute.js'
import type { CreateReturnInput, CreateReturnResult } from './types.js'
import { requirePermission } from '../../integrity/permissions.js'
import { requireMayTakeMoney } from '../extraCounters.js'

/*
 * A return raised as a draft: the lines checked against what the bill sold and
 * what has already come back, priced at what was paid.
 */

export async function createReturn(db: SqlDriver, input: CreateReturnInput): Promise<CreateReturnResult> {
  await requirePermission(db, input.actorId, 'sales_return', 'create')
  await requireMayTakeMoney(db)
  const computed = await computeLines(db, input.billId, input.lines)
  if (!computed.ok) return computed

  const now = input.now ?? new Date()
  const returnId = newId()
  const nowIso = now.toISOString()
  const postingDate = businessDate(now)

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.salesReturns).values({
      id: returnId,
      docNo: `DRAFT-${returnId}`,
      docstatus: DRAFT,
      billId: input.billId,
      postingDate,
      refundTotal: computed.refundTotal,
      taxReversed: computed.taxReversed,
      refundMethod: input.refundMethod,
      reason: input.reason ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const line of computed.lines) {
      await q(tx).insert(schema.salesReturnItems).values({
        id: newId(),
        returnId,
        billItemId: line.billItemId,
        productId: line.productId,
        qty: line.qty,
        baseQty: line.baseQty,
        refundAmount: line.refund,
        taxableValue: line.taxableValue,
        cgstAmount: line.cgst,
        sgstAmount: line.sgst,
        igstAmount: line.igst,
        cessAmount: line.cess,
        hsnCode: line.hsnCode,
        taxRateBp: line.taxRateBp,
      })
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'sales_returns', entityId: returnId, action: 'create', docstatusTo: DRAFT,
    })
  })

  return {
    ok: true,
    returnId,
    refundTotal: computed.refundTotal,
    taxReversed: computed.taxReversed,
    lineCount: computed.lines.length,
  }
}
