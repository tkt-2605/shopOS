import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { requirePermission } from '../../integrity/permissions.js'
import type { Money } from '../../money.js'
import { createDocument } from './create.js'
import { cancelDocument, submitDocument, type CancelDocumentResult } from './lifecycle.js'
import type { CreateDocumentInput, CreateDocumentResult } from './types.js'

/**
 * An issued quotation, sales order or purchase order, corrected.
 *
 * Issued is something the shop has said, so it is never rewritten: the one
 * issued is cancelled and a new one issued with the change in it, naming the
 * one it corrects (`amended_from`, 086). One transaction for all three steps,
 * so a refusal at any of them leaves the original issued and nothing new --
 * never the original cancelled with no correction to take its place.
 *
 * The correction takes a number of its own from this counter's series, as a
 * corrected bill does (`amendBill`): two tills correcting one document while
 * apart would otherwise both mint the same "-1" after it, and one of the two
 * would never reach the shop.
 *
 * Refused for a document something has been made from -- a sales order billed
 * or a purchase order received, even in part -- which `cancelDocument` refuses
 * already, and for one an online order points at, whose customer is reading it.
 */
export type AmendDocumentInput = Omit<CreateDocumentInput, 'kind' | 'convertedFrom' | 'amendedFrom' | 'postingDate'> & {
  documentId: string
}

export type AmendDocumentResult =
  | { ok: true; documentId: string; docNo: string; grandTotal: Money; replaced: string }
  | Extract<CreateDocumentResult, { ok: false }>
  | Exclude<Extract<CancelDocumentResult, { ok: false }>, { code: 'NOT_FOUND' }>
  | { ok: false; code: 'UNKNOWN_DOCUMENT' | 'NOT_ISSUED' | 'FROM_ONLINE_ORDER'; productId?: undefined }

/** A refusal from inside the transaction, thrown so everything before it rolls back. */
class Refused {
  constructor(readonly result: Extract<AmendDocumentResult, { ok: false }>) {}
}

export async function amendDocument(db: SqlDriver, input: AmendDocumentInput): Promise<AmendDocumentResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  await requirePermission(db, input.actorId, 'document', 'cancel')
  const { documentId, ...fields } = input
  try {
    return await db.transaction(async (tx) => {
      const [held] = await q(tx)
        .select({
          kind: schema.documents.kind, docstatus: schema.documents.docstatus, docNo: schema.documents.docNo,
          convertedFrom: schema.documents.convertedFrom,
        })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId))
      if (!held) throw new Refused({ ok: false, code: 'UNKNOWN_DOCUMENT' })
      if (held.docstatus !== SUBMITTED) throw new Refused({ ok: false, code: 'NOT_ISSUED' })
      const [online] = await q(tx).select({ id: schema.webOrders.id }).from(schema.webOrders)
        .where(eq(schema.webOrders.documentId, documentId)).limit(1)
      if (online) throw new Refused({ ok: false, code: 'FROM_ONLINE_ORDER' })

      const cancelled = await cancelDocument(tx, {
        documentId, reason: 'Corrected', actorId: input.actorId, ...(input.now ? { now: input.now } : {}),
      })
      if (!cancelled.ok) {
        throw new Refused(cancelled.code === 'NOT_FOUND' ? { ok: false, code: 'UNKNOWN_DOCUMENT' } : cancelled)
      }
      const made = await createDocument(tx, {
        ...fields,
        kind: held.kind as CreateDocumentInput['kind'],
        // A sales order made from a quotation is still made from it once corrected.
        convertedFrom: held.convertedFrom,
        amendedFrom: documentId,
      })
      if (!made.ok) throw new Refused(made)
      const issued = await submitDocument(tx, {
        documentId: made.documentId, actorId: input.actorId, ...(input.now ? { now: input.now } : {}),
      })
      if (!issued.ok) throw new Error(`the correction could not be issued: ${issued.code}`)
      return { ok: true as const, documentId: made.documentId, docNo: made.docNo, grandTotal: made.grandTotal, replaced: held.docNo }
    })
  } catch (err) {
    if (err instanceof Refused) return err.result
    throw err
  }
}
