import { eq, and } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { DRAFT } from '../../integrity/docstatus.js'
import { writeAudit } from '../../integrity/audit.js'
import { requirePermission } from '../../integrity/permissions.js'
import type { Money } from '../../money.js'
import { priceDocument, partyColumns, totalsColumns, writeDocumentLines } from './create.js'
import type { CreateDocumentInput, CreateDocumentResult } from './types.js'

/**
 * A draft quotation, sales order or purchase order, changed before it is
 * issued: its party, its lines, its validity and its notes.
 *
 * Only a draft. Issuing is what makes a document something the shop has said,
 * so an issued one is changed the way a bill is -- cancelled, and a new one
 * made. The number stays: a draft keeps the number it was given, as the paper
 * the customer may already have been shown says.
 *
 * Priced exactly as a new document is (`priceDocument`), so an edited draft
 * comes to what the same lines would come to typed in fresh today. Lines are
 * rewritten wholesale, as `saveDraft` does for a bill: a draft has no effect
 * on the books or the shelf for a diff to protect. They sync inside their
 * document, which carries them whole.
 */
export type EditDraftInput = Omit<CreateDocumentInput, 'kind' | 'registerId' | 'convertedFrom' | 'postingDate'> & {
  documentId: string
}

export type EditDraftResult =
  | { ok: true; documentId: string; docNo: string; grandTotal: Money }
  | Extract<CreateDocumentResult, { ok: false }>
  | { ok: false; code: 'NOT_A_DRAFT' | 'UNKNOWN_DOCUMENT'; productId?: undefined }

export async function editDraftDocument(db: SqlDriver, input: EditDraftInput): Promise<EditDraftResult> {
  await requirePermission(db, input.actorId, 'document', 'create')
  const [held] = await q(db)
    .select({ kind: schema.documents.kind, docstatus: schema.documents.docstatus, docNo: schema.documents.docNo })
    .from(schema.documents)
    .where(eq(schema.documents.id, input.documentId))
  if (!held) return { ok: false, code: 'UNKNOWN_DOCUMENT' }
  if (held.docstatus !== DRAFT) return { ok: false, code: 'NOT_A_DRAFT' }

  const now = input.now ?? new Date()
  const kind = held.kind as CreateDocumentInput['kind']
  const p = await priceDocument(db, { ...input, kind }, now)
  if (!p.ok) return p
  const { priced, totals, party, forSupplier } = p

  let stillDraft = true
  await db.transaction(async (tx) => {
    /* Asked again inside: a draft issued on the other till since the read
       above is the issued document now, and is not rewritten. */
    const [current] = await q(tx)
      .select({ docstatus: schema.documents.docstatus })
      .from(schema.documents)
      .where(eq(schema.documents.id, input.documentId))
    if (current?.docstatus !== DRAFT) { stillDraft = false; return }

    await q(tx).delete(schema.documentItems).where(eq(schema.documentItems.documentId, input.documentId))
    await writeDocumentLines(tx, input.documentId, priced, totals)
    await q(tx).update(schema.documents)
      .set({
        ...partyColumns(forSupplier, input, party),
        validUntil: input.validUntil ?? null,
        ...totalsColumns(totals),
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        updatedAt: now.toISOString(),
      })
      .where(and(eq(schema.documents.id, input.documentId), eq(schema.documents.docstatus, DRAFT)))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'document',
      entityId: input.documentId,
      action: 'update',
      after: { doc_no: held.docNo, lines: priced.length, grand_total: totals.grandTotal },
    })
  })
  if (!stillDraft) return { ok: false, code: 'NOT_A_DRAFT' }

  return { ok: true, documentId: input.documentId, docNo: held.docNo, grandTotal: totals.grandTotal }
}
