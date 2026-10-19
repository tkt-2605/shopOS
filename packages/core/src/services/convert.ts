import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { QTY_SCALE, type Qty } from '../quantity.js'
import { businessDate } from '../dates.js'
import { createStockEntry, submitStockEntry } from './stockEntry.js'
import { closedFor, type PeriodClosed } from './books.js'
import { createDocument, loadDocument } from './documents.js'
import { writeAudit } from '../integrity/audit.js'
import { newId } from '../ids.js'
import { requirePermission } from '../integrity/permissions.js'

/**
 * Turning one document into the next.
 *
 * A quotation becomes an order becomes goods. Each step forward records what it
 * came from and marks off what it consumed, in the same transaction that creates
 * the target -- so a crash between the two cannot leave a source claiming it
 * was converted into something that does not exist, or a target whose source
 * still shows the quantity open. What is left to convert is read inside that
 * transaction as well, so two conversions of one document cannot both take it.
 * Each line marked off leaves a `document_fulfilments` row (054), which is what
 * `reconcileFulfilledQty` puts `fulfilled_qty` back to after a merge.
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
  await requirePermission(db, input.actorId, 'document', 'create')
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

  const register = await registerOf(db, input.quotationId)

  return db.transaction(async (tx): Promise<ConvertResult> => {
    const remaining = (await loadDocument(tx, input.quotationId))?.items.filter((i) => i.remainingQty > 0) ?? []
    if (remaining.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

    const created = await createDocument(tx, {
      kind: 'sales_order',
      registerId: register,
      customerId: source.customerId,
      lines: remaining.map((i) => ({
        productId: i.productId,
        saleUnit: i.saleUnit,
        qty: i.remainingQty,
        // The rate that was quoted, not today's, read the way it was quoted.
        rateOverride: i.rate,
        rateIncludesTax: i.rateIncludesTax,
      })),
      ...(input.postingDate ? { postingDate: input.postingDate } : {}),
      terms: source.terms,
      convertedFrom: source.id,
      actorId: input.actorId,
      now,
    })

    if (!created.ok) return { ok: false, code: created.code }

    await markFulfilled(tx, remaining.map((i) => ({ id: i.id, by: i.remainingQty })), {
      sourceId: source.id, targetKind: 'document', targetId: created.documentId,
      targetNo: created.docNo, actorId: input.actorId, now,
    })

    return { ok: true, documentId: created.documentId, docNo: created.docNo }
  })
}

export interface OrderCartLine {
  productId: string
  saleUnit: string
  /** What is still to be billed, in the order's own sale unit. */
  qty: Qty
  /** The rate the shop promised, to be kept rather than resolved again. */
  rate: Money
  /** Whether that rate has the tax in it -- as the order quoted it. */
  includesTax: boolean
}

export type ToCartResult =
  | { ok: true; documentId: string; docNo: string; customerId: string | null; lines: OrderCartLine[] }
  | {
    ok: false
    code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' | 'EXPIRED'
  }

/**
 * An order, as a cart to be rung up.
 *
 * The one conversion that does not create anything. It hands the counter what
 * is still owed on the order and the rates that were promised, and then stops —
 * the bill is made by the counter, out of a draft that can be edited, split,
 * held overnight or abandoned like any other.
 *
 * Which is why nothing is marked off here. The draft carries the order's id
 * (`bills.converted_from`) from the moment it is loaded, and `submitBill` marks
 * the order off when the money is taken. A cart loaded and walked away from
 * leaves the order exactly as open as it was.
 */
export async function documentToCart(
  db: SqlDriver,
  input: { documentId: string; on?: string },
): Promise<ToCartResult> {
  const source = await loadDocument(db, input.documentId)
  if (!source) return { ok: false, code: 'NOT_FOUND' }
  /* A purchase order is money the shop owes, not money it is owed. It is
     received into stock; billing one would invoice the supplier for goods the
     shop is buying. */
  if (source.kind === 'purchase_order') return { ok: false, code: 'WRONG_KIND' }
  if (source.docstatus === 2) return { ok: false, code: 'CANCELLED' }
  if (source.docstatus !== 1) return { ok: false, code: 'NOT_SUBMITTED' }

  if (source.validUntil && source.validUntil < (input.on ?? isoDate(new Date()))) {
    return { ok: false, code: 'EXPIRED' }
  }

  const remaining = source.items.filter((i) => i.remainingQty > 0)
  if (remaining.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

  return {
    ok: true,
    documentId: source.id,
    docNo: source.docNo,
    customerId: source.customerId,
    lines: remaining.map((i) => ({
      productId: i.productId,
      saleUnit: i.saleUnit,
      qty: i.remainingQty,
      rate: i.rate,
      includesTax: i.rateIncludesTax,
    })),
  }
}

export type ReceiveResult =
  | { ok: true; stockEntryId: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' }
  /** Received with a date the books are closed through. */
  | PeriodClosed

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
  await requirePermission(db, input.actorId, 'document', 'create')
  const source = await loadDocument(db, input.purchaseOrderId)
  if (!source) return { ok: false, code: 'NOT_FOUND' }
  if (source.kind !== 'purchase_order') return { ok: false, code: 'WRONG_KIND' }
  if (source.docstatus === 2) return { ok: false, code: 'CANCELLED' }
  if (source.docstatus !== 1) return { ok: false, code: 'NOT_SUBMITTED' }

  const now = input.now ?? new Date()

  /* Asked before anything is made, so a refusal is said as what it is rather
     than as the "nothing left" every other refusal part-way becomes. */
  const closed = await closedFor(db, input.postingDate ?? businessDate(now))
  if (closed) return closed

  /* One transaction for the goods in, the order marked off and the record of
     it. A refusal part-way throws, so nothing of it is kept. */
  class Refused extends Error {}
  try {
    return await db.transaction(async (tx): Promise<ReceiveResult> => {
      const remaining = (await loadDocument(tx, input.purchaseOrderId))?.items.filter((i) => i.remainingQty > 0) ?? []
      if (remaining.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

      const entry = await createStockEntry(tx, {
        entryType: 'purchase',
        supplierId: source.supplierId,
        supplierName: source.partyName,
        reference: source.docNo,
        lines: remaining.map((i) => ({
          productId: i.productId,
          qty: i.remainingQty,
          unitCost: receivedCost(i),
        })),
        ...(input.postingDate ? { postingDate: input.postingDate } : {}),
        actorId: input.actorId,
        now,
      })
      if (!entry.ok) throw new Refused()

      const submitted = await submitStockEntry(tx, {
        entryId: entry.entryId,
        actorId: input.actorId,
        now,
      })
      if (!submitted.ok) throw new Refused()

      await markFulfilled(tx, remaining.map((i) => ({ id: i.id, by: i.remainingQty })), {
        sourceId: source.id, targetKind: 'stock_entry', targetId: entry.entryId,
        targetNo: source.docNo, actorId: input.actorId, now,
      })

      return { ok: true, stockEntryId: entry.entryId }
    })
  } catch (err) {
    if (err instanceof Refused) return { ok: false, code: 'NOTHING_LEFT' }
    throw err
  }
}

/* ------------------------------------------------------------ private --- */

/**
 * What one unit of an order line goes into stock at: the price before tax.
 *
 * A rate typed before GST is that price already, and goes in as it always
 * has. A rate typed with the GST in it does not -- the tax is the supplier's,
 * claimed back, and never part of what the goods are worth -- so the line's
 * own taxable value is spread over its quantity instead: the figure the order
 * worked out when it was saved, not one worked out again here.
 */
function receivedCost(line: { rate: Money; rateIncludesTax: boolean; taxableValue: Money; qty: Qty }): Money {
  if (!line.rateIncludesTax || line.qty <= 0) return line.rate
  return Math.round((line.taxableValue * QTY_SCALE) / line.qty) as Money
}

/**
 * Marks off what the new document consumed, inside the caller's transaction.
 *
 * Every line, a `document_fulfilments` row for each, and the audit row, so a
 * document can never be left half marked -- which would show as an order with
 * three of its five lines billed and no record of why.
 */
async function markFulfilled(
  tx: SqlDriver,
  lines: { id: string; by: Qty }[],
  meta: {
    sourceId: string; targetKind: 'document' | 'stock_entry'; targetId: string
    targetNo: string; actorId: string; now: Date
  },
): Promise<void> {
  for (const line of lines) {
    await q(tx).update(schema.documentItems)
      .set({ fulfilledQty: sql`${schema.documentItems.fulfilledQty} + ${line.by}` })
      .where(eq(schema.documentItems.id, line.id))
    await q(tx).insert(schema.documentFulfilments).values({
      id: newId(),
      documentId: meta.sourceId,
      documentItemId: line.id,
      qty: line.by,
      targetKind: meta.targetKind,
      targetId: meta.targetId,
      createdAt: meta.now.toISOString(),
    })
  }
  await writeAudit(tx, { actorId: meta.actorId }, {
    entity: 'document',
    entityId: meta.sourceId,
    action: 'update',
    after: { converted_to: meta.targetNo },
  })
}

async function registerOf(db: SqlDriver, documentId: string): Promise<string> {
  const [row] = await q(db)
    .select({ registerId: schema.documents.registerId })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId))
  return row!.registerId
}

/** The shop's day, not UTC's: a quotation that ran out yesterday must not convert at 00:30. */
function isoDate(at: Date): string {
  return businessDate(at)
}
