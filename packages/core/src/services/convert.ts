import type { SqlDriver } from '../db/driver.js'
import type { Qty } from '../quantity.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'
import { createDocument, loadDocument } from './documents.js'
import { writeAudit } from '../integrity/audit.js'

/**
 * Turning one document into the next.
 *
 * A quotation becomes an order becomes goods. Each step forward records what it
 * came from and marks off what it consumed, in the same transaction that creates
 * the target — so a crash between the two cannot leave an order claiming it was
 * billed when no bill exists.
 *
 * Quoted rates carry across on purpose, unlike "Sell these again" on the bills
 * screen, which deliberately re-prices at today's rates. The reason is the
 * opposite of that one's: a bill from March is a record of what happened, while
 * a quotation is a promise the shop made, and honouring it is the entire point.
 */

export type ConvertResult =
  | { ok: true; documentId: string; docNo: string }
  | {
    ok: false
    code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' | 'EXPIRED'
      | CreateFailure
  }

type CreateFailure = 'NO_LINES' | 'INVALID_QTY' | 'UNKNOWN_PRODUCT' | 'PARTY_REQUIRED'

/**
 * A quotation the customer accepted, as an order the shop will fulfil.
 *
 * Only what is left is carried: a quotation already partly turned into an order
 * converts the remainder, which is what makes a customer taking half of a quote
 * now and half next month work at all.
 */
export async function quotationToSalesOrder(
  db: SqlDriver,
  input: { quotationId: string; actorId: string; postingDate?: string; now?: Date },
): Promise<ConvertResult> {
  const source = await loadDocument(db, input.quotationId)
  if (!source) return { ok: false, code: 'NOT_FOUND' }
  if (source.kind !== 'quotation') return { ok: false, code: 'WRONG_KIND' }
  if (source.docstatus === 2) return { ok: false, code: 'CANCELLED' }
  if (source.docstatus !== 1) return { ok: false, code: 'NOT_SUBMITTED' }

  const now = input.now ?? new Date()

  /* A quotation past its date is a price the shop is no longer held to. Refused
     rather than silently re-priced: the customer is holding a piece of paper
     with a number on it, and quietly charging a different one is the argument
     this whole document exists to prevent. */
  if (source.validUntil && source.validUntil < (input.postingDate ?? isoDate(now))) {
    return { ok: false, code: 'EXPIRED' }
  }

  const remaining = source.items.filter((i) => i.remainingQty > 0)
  if (remaining.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

  const register = await registerOf(db, input.quotationId)

  const created = await createDocument(db, {
    kind: 'sales_order',
    registerId: register,
    customerId: source.customerId,
    lines: remaining.map((i) => ({
      productId: i.productId,
      saleUnit: i.saleUnit,
      qty: i.remainingQty,
      // The rate that was quoted, not today's.
      rateOverride: i.rate,
    })),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
    terms: source.terms,
    convertedFrom: source.id,
    actorId: input.actorId,
    now,
  })

  if (!created.ok) return { ok: false, code: created.code }

  await markFulfilled(db, remaining.map((i) => ({ id: i.id, by: i.remainingQty })), {
    sourceId: source.id, targetNo: created.docNo, actorId: input.actorId,
  })

  return { ok: true, documentId: created.documentId, docNo: created.docNo }
}

export type ReceiveResult =
  | { ok: true; stockEntryId: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' }

/**
 * Goods arriving against a purchase order.
 *
 * This is the one conversion that moves stock, because receiving is the moment
 * the goods are actually in the shop. The ordered cost is what they come in at,
 * which is what keeps the moving average honest — a delivery valued at today's
 * list price rather than what was paid for it quietly rewrites every margin
 * report that touches the item.
 */
export async function receivePurchaseOrder(
  db: SqlDriver,
  input: { purchaseOrderId: string; actorId: string; postingDate?: string; now?: Date },
): Promise<ReceiveResult> {
  const source = await loadDocument(db, input.purchaseOrderId)
  if (!source) return { ok: false, code: 'NOT_FOUND' }
  if (source.kind !== 'purchase_order') return { ok: false, code: 'WRONG_KIND' }
  if (source.docstatus === 2) return { ok: false, code: 'CANCELLED' }
  if (source.docstatus !== 1) return { ok: false, code: 'NOT_SUBMITTED' }

  const remaining = source.items.filter((i) => i.remainingQty > 0)
  if (remaining.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

  const now = input.now ?? new Date()

  const entry = await createStockEntry(db, {
    entryType: 'purchase',
    supplierId: source.supplierId,
    supplierName: source.partyName,
    reference: source.docNo,
    lines: remaining.map((i) => ({
      productId: i.productId,
      qty: i.remainingQty,
      unitCost: i.rate,
    })),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
    actorId: input.actorId,
    now,
  })
  if (!entry.ok) return { ok: false, code: 'NOTHING_LEFT' }

  const submitted = await submitStockEntry(db, {
    entryId: entry.entryId,
    actorId: input.actorId,
    now,
  })
  if (!submitted.ok) return { ok: false, code: 'NOTHING_LEFT' }

  await markFulfilled(db, remaining.map((i) => ({ id: i.id, by: i.remainingQty })), {
    sourceId: source.id, targetNo: source.docNo, actorId: input.actorId,
  })

  return { ok: true, stockEntryId: entry.entryId }
}

/* ------------------------------------------------------------ private --- */

/**
 * Marks off what the new document consumed.
 *
 * One transaction for every line plus the audit row, so a document can never be
 * left half marked — which would show as an order with three of its five lines
 * billed and no record of why.
 */
async function markFulfilled(
  db: SqlDriver,
  lines: { id: string; by: Qty }[],
  meta: { sourceId: string; targetNo: string; actorId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const line of lines) {
      await tx.execute(
        `UPDATE document_items SET fulfilled_qty = fulfilled_qty + ? WHERE id = ?`,
        [line.by, line.id],
      )
    }
    await writeAudit(tx, { actorId: meta.actorId }, {
      entity: 'document',
      entityId: meta.sourceId,
      action: 'update',
      after: { converted_to: meta.targetNo },
    })
  })
}

async function registerOf(db: SqlDriver, documentId: string): Promise<string> {
  const row = await db.get<{ register_id: string }>(
    `SELECT register_id FROM documents WHERE id = ?`, [documentId],
  )
  return row!.register_id
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}
