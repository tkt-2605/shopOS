import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { SUBMITTED, CANCELLED } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { recheckDocStatus } from '../../integrity/transition.js'
import { FINISHED, STARTED } from './read.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * A document submitted, and a submitted one cancelled.
 */

export type SubmitDocumentResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_SUBMITTED' | 'CANCELLED' }

/**
 * Committing to the document.
 *
 * Submitting moves no stock and no money. What it changes is that the document
 * can no longer be edited, and that it becomes something another document can be
 * made from — which is the whole of what `docstatus = 1` means here.
 */
export async function submitDocument(
  db: SqlDriver,
  input: { documentId: string; actorId: string; now?: Date },
): Promise<SubmitDocumentResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  const [doc] = await q(db)
    .select({ docstatus: schema.documents.docstatus })
    .from(schema.documents)
    .where(eq(schema.documents.id, input.documentId))
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === SUBMITTED) return { ok: false, code: 'ALREADY_SUBMITTED' }
  if (doc.docstatus === CANCELLED) return { ok: false, code: 'CANCELLED' }
  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await recheckDocStatus(tx, 'documents', input.documentId, 'document', 'submit')
    await q(tx).update(schema.documents)
      .set({ docstatus: SUBMITTED, updatedAt: nowIso })
      .where(eq(schema.documents.id, input.documentId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: input.documentId,
      action: 'submit',
      docstatusFrom: 0,
      docstatusTo: 1,
    })
  })

  return { ok: true }
}

export type CancelDocumentResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_CANCELLED' }
  /**
   * Some of it has been acted on, but not all.
   *
   * Separate from `FULLY_FULFILLED` because the two need different sentences
   * and a different way out. Part-done has a remainder somebody may still want,
   * so the answer is a fresh document for what is left; all-done has no
   * remainder and nothing to raise.
   */
  | { ok: false; code: 'PARTLY_FULFILLED'; fulfilled: number; lines: number }
  | { ok: false; code: 'FULLY_FULFILLED'; lines: number }

export async function cancelDocument(
  db: SqlDriver,
  input: { documentId: string; reason: string; actorId: string; now?: Date },
): Promise<CancelDocumentResult> {
  await requirePermission(db, input.actorId, 'document', 'cancel')
  const [doc] = await q(db)
    .select({ docstatus: schema.documents.docstatus })
    .from(schema.documents)
    .where(eq(schema.documents.id, input.documentId))
  if (!doc) return { ok: false, code: 'NOT_FOUND' }
  if (doc.docstatus === CANCELLED) return { ok: false, code: 'ALREADY_CANCELLED' }

  /* An order that has already been billed cannot be cancelled: the bill exists
     and the goods are gone. Cancelling the order it came from would leave the
     bill pointing at a document that says it never happened.

     Counted two ways so the refusal can say which it is. A quotation every line
     of which has been billed is not "partly" anything -- it is finished, and
     telling a shopkeeper that part of it has been delivered when all of it has
     sends them looking for the missing part. */
  const [done] = await q(db)
    .select({
      lines: sql<number>`COUNT(*)`,
      started: STARTED,
      finished: FINISHED,
    })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, input.documentId))
  const lines = done?.lines ?? 0
  const started = done?.started ?? 0
  if (lines > 0 && (done?.finished ?? 0) === lines) {
    return { ok: false, code: 'FULLY_FULFILLED', lines }
  }
  if (started > 0) return { ok: false, code: 'PARTLY_FULFILLED', fulfilled: started, lines }

  const nowIso = (input.now ?? new Date()).toISOString()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.documents)
      .set({
        docstatus: CANCELLED,
        cancelledBy: input.actorId,
        cancelledAt: nowIso,
        cancelReason: input.reason,
        updatedAt: nowIso,
      })
      .where(eq(schema.documents.id, input.documentId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: input.documentId,
      action: 'cancel',
      after: { cancel_reason: input.reason },
      docstatusFrom: doc.docstatus as 0 | 1,
      docstatusTo: 2,
    })
  })

  return { ok: true }
}

/* ------------------------------------------------------------ reading --- */
