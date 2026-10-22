import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { QTY_SCALE, type Qty } from '../quantity.js'
import { businessDate } from '../dates.js'
import {
  createStockEntry, submitStockEntry,
  type CreateStockEntryResult, type StockEntryLineInput, type SubmitStockEntryResult,
} from './stockEntry.js'
import { closedFor, type PeriodClosed } from './books.js'
import { createDocument, loadDocument, type DocumentDetail } from './documents.js'
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
      after: { converted_to: created.docNo }, actorId: input.actorId, now,
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
  | { ok: true; stockEntryId: string; docNo: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' }
  /** No line against the order had anything on it: nothing it asked for came. */
  | { ok: false; code: 'NOTHING_ENTERED' }
  /** A line naming an order line that is not open on this order. */
  | { ok: false; code: 'UNKNOWN_LINE'; itemId: string }
  | { ok: false; code: 'INVALID_QTY' | 'INVALID_COST'; itemId: string }
  /** More than the order still has open on that line, counting every line given against it. */
  | { ok: false; code: 'OVER_RECEIVED'; itemId: string; remaining: Qty }
  /** Received with a date the books are closed through. */
  | PeriodClosed
  /** The delivery itself refused, as Stock In would refuse it: a batch, a price below cost, stock. */
  | Exclude<CreateStockEntryResult, { ok: true }>
  | Exclude<SubmitStockEntryResult, { ok: true }>

/**
 * One line of a delivery.
 *
 * Against an order line (`itemId`), or not: a supplier's bill can carry goods
 * the order never asked for, and they come in on the same entry without
 * marking anything off. One order line can be given more than once -- two
 * batches of one item -- and what is marked off is their sum.
 *
 * Everything else is what a Stock In line carries. Left out on an order line,
 * the cost and the GST are the order's.
 */
export interface ReceivedLine extends Omit<StockEntryLineInput, 'productId' | 'qty' | 'unitCost'> {
  itemId?: string
  /** For a line not on the order. An order line's item is the order's. */
  productId?: string
  qty: Qty
  /** Before GST, per unit. */
  unitCost?: Money
}

/**
 * Goods arriving against a purchase order.
 *
 * This is the one conversion that moves stock, because receiving is the moment
 * the goods are actually in the shop. The ordered cost is what they come in at,
 * which is what keeps the moving average honest — a delivery valued at today's
 * list price rather than what was paid for it quietly rewrites every margin
 * report that touches the item.
 *
 * `lines` is what actually came, which a supplier does not always make the same
 * as what was ordered. An order line left out or given 0 stays open for the
 * next delivery, and more than a line has open is refused rather than taken.
 * Without `lines`, everything still open is received, as it always was.
 *
 * The stock entry it makes is the one Stock In makes -- batches, prices, the
 * supplier's bill and its rounding -- so the order can be received from that
 * screen with nothing lost, and the order is marked off in the same
 * transaction that puts the goods on the shelf.
 */
export async function receivePurchaseOrder(
  db: SqlDriver,
  input: {
    purchaseOrderId: string; actorId: string; postingDate?: string; now?: Date
    lines?: ReceivedLine[]
    supplierInvoiceNo?: string | null; supplierInvoiceDate?: string | null
    roundOff?: Money
    allowBelowCost?: boolean
  },
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
  class Refused extends Error {
    constructor(readonly result: ReceiveResult) { super('refused') }
  }
  try {
    return await db.transaction(async (tx): Promise<ReceiveResult> => {
      const open = (await loadDocument(tx, input.purchaseOrderId))?.items.filter((i) => i.remainingQty > 0) ?? []
      if (open.length === 0) return { ok: false, code: 'NOTHING_LEFT' }

      /* Checked against what is open now, inside the transaction, so two people
         receiving one order cannot both take its last ten. */
      const taking = pickReceived(open, input.lines ?? open.map((i) => ({ itemId: i.id, qty: i.remainingQty })))
      if (!Array.isArray(taking)) return taking

      const entry = await createStockEntry(tx, {
        entryType: 'purchase',
        supplierId: source.supplierId,
        supplierName: source.partyName,
        reference: source.docNo,
        supplierInvoiceNo: input.supplierInvoiceNo?.trim() || null,
        supplierInvoiceDate: input.supplierInvoiceDate || null,
        ...(input.roundOff !== undefined ? { roundOff: input.roundOff } : {}),
        lines: taking.map((t) => t.entry),
        ...(input.postingDate ? { postingDate: input.postingDate } : {}),
        ...(input.allowBelowCost ? { allowBelowCost: true } : {}),
        actorId: input.actorId,
        now,
      })
      if (!entry.ok) throw new Refused(entry)

      const submitted = await submitStockEntry(tx, {
        entryId: entry.entryId,
        actorId: input.actorId,
        now,
      })
      if (!submitted.ok) throw new Refused(submitted)

      /* One step per order line, however many batches it came in as. */
      const by = new Map<string, number>()
      for (const t of taking) if (t.itemId) by.set(t.itemId, (by.get(t.itemId) ?? 0) + t.entry.qty)
      await markFulfilled(tx, [...by].map(([id, qty]) => ({ id, by: qty as Qty })), {
        sourceId: source.id, targetKind: 'stock_entry', targetId: entry.entryId,
        after: { converted_to: submitted.docNo }, actorId: input.actorId, now,
      })

      return { ok: true, stockEntryId: entry.entryId, docNo: submitted.docNo }
    })
  } catch (err) {
    if (err instanceof Refused) return err.result
    throw err
  }
}

export type CloseShortResult =
  | { ok: true; closedLines: number }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_SUBMITTED' | 'CANCELLED' | 'WRONG_KIND' | 'NOTHING_LEFT' | 'REASON_REQUIRED' }
  /** Nothing has come against it yet: that is a cancellation, and is called one. */
  | { ok: false; code: 'NOTHING_RECEIVED' }

/**
 * What the supplier is not going to send, given up.
 *
 * Without it a short delivery leaves the order open for ever, and an open order
 * is one somebody keeps waiting on and one a later delivery can be received
 * against by mistake. Each open line is marked off by what it still had, as a
 * `closed` fulfilment (078) with nothing behind it -- no stock moves and no
 * money is posted, because nothing arrived. The reason goes on the record.
 *
 * Only once something has been received: an order nothing ever came against is
 * cancelled, which is the plain word for it and what the books already know.
 */
export async function closePurchaseOrderShort(
  db: SqlDriver,
  input: { purchaseOrderId: string; reason: string; actorId: string; now?: Date },
): Promise<CloseShortResult> {
  await requirePermission(db, input.actorId, 'document', 'cancel')
  const reason = input.reason.trim()
  if (reason === '') return { ok: false, code: 'REASON_REQUIRED' }

  const source = await loadDocument(db, input.purchaseOrderId)
  if (!source) return { ok: false, code: 'NOT_FOUND' }
  if (source.kind !== 'purchase_order') return { ok: false, code: 'WRONG_KIND' }
  if (source.docstatus === 2) return { ok: false, code: 'CANCELLED' }
  if (source.docstatus !== 1) return { ok: false, code: 'NOT_SUBMITTED' }

  const now = input.now ?? new Date()
  return db.transaction(async (tx): Promise<CloseShortResult> => {
    const items = (await loadDocument(tx, input.purchaseOrderId))?.items ?? []
    const open = items.filter((i) => i.remainingQty > 0)
    if (open.length === 0) return { ok: false, code: 'NOTHING_LEFT' }
    if (!items.some((i) => i.fulfilledQty > 0)) return { ok: false, code: 'NOTHING_RECEIVED' }

    await markFulfilled(tx, open.map((i) => ({ id: i.id, by: i.remainingQty })), {
      sourceId: source.id, targetKind: 'closed', targetId: null,
      after: { closed_short: reason }, actorId: input.actorId, now,
    })
    return { ok: true, closedLines: open.length }
  })
}

/* ------------------------------------------------------------ private --- */

type OrderLine = DocumentDetail['items'][number]

/**
 * The lines of a delivery, checked against what the order has open, and made
 * into the stock entry's lines.
 *
 * A refusal names the line, so the screen can point at the row that is wrong
 * rather than at the whole delivery.
 */
function pickReceived(
  open: OrderLine[],
  lines: ReceivedLine[],
): { itemId: string | null; entry: StockEntryLineInput }[] | ReceiveResult {
  const taking: { itemId: string | null; entry: StockEntryLineInput }[] = []
  const claimed = new Map<string, number>()
  for (const given of lines) {
    const { itemId, productId, qty, unitCost, ...rest } = given
    const line = itemId === undefined ? null : open.find((i) => i.id === itemId)
    if (itemId !== undefined && !line) return { ok: false, code: 'UNKNOWN_LINE', itemId }
    const named = itemId ?? productId ?? ''
    if (!Number.isInteger(qty) || qty < 0) return { ok: false, code: 'INVALID_QTY', itemId: named }
    if (unitCost !== undefined && (!Number.isInteger(unitCost) || unitCost < 0)) {
      return { ok: false, code: 'INVALID_COST', itemId: named }
    }
    if (line) {
      const total = (claimed.get(line.id) ?? 0) + qty
      if (total > line.remainingQty) {
        return { ok: false, code: 'OVER_RECEIVED', itemId: line.id, remaining: line.remainingQty }
      }
      claimed.set(line.id, total)
    }
    if (qty === 0) continue
    taking.push({
      itemId: line?.id ?? null,
      entry: line
        ? {
            taxRateBp: line.taxRateBp, cessRateBp: line.cessRateBp,
            ...rest,
            productId: line.productId, qty, unitCost: unitCost ?? receivedCost(line),
          }
        : { ...rest, productId: productId ?? '', qty, ...(unitCost !== undefined ? { unitCost } : {}) },
    })
  }
  if (!taking.some((t) => t.itemId !== null)) return { ok: false, code: 'NOTHING_ENTERED' }
  return taking
}

/**
 * What one unit of an order line goes into stock at: the price before tax.
 *
 * A rate typed before GST is that price already, and goes in as it always
 * has. A rate typed with the GST in it does not -- the tax is the supplier's,
 * claimed back, and never part of what the goods are worth -- so the line's
 * own taxable value is spread over its quantity instead: the figure the order
 * worked out when it was saved, not one worked out again here.
 */
export function receivedCost(line: { rate: Money; rateIncludesTax: boolean; taxableValue: Money; qty: Qty }): Money {
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
    sourceId: string; targetKind: 'document' | 'stock_entry' | 'closed'; targetId: string | null
    after: Record<string, string>; actorId: string; now: Date
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
    after: meta.after,
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
