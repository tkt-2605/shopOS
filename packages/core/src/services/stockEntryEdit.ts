import { eq, and, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'
import { DRAFT, SUBMITTED } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import type { PeriodClosed } from './books.js'
import { currentStock } from './stock.js'
import { findBatch } from './batches.js'
import {
  createStockEntry, submitStockEntry, cancelStockEntry,
  type CreateStockEntryInput, type CreateStockEntryResult, type SubmitStockEntryResult, type StockEntryType,
} from './stockEntry.js'

/*
 * A stock entry kept to finish later, and a posted one corrected.
 *
 * A draft moves nothing -- no stock, no ledger, no number -- so it is saved by
 * writing it again whole, the way a draft bill is. A posted entry is never
 * changed: it moved the shelf and the books, and other tills have it. It is
 * corrected the way a bill is, by cancelling it and posting a new one that
 * names it (`amended_from`), all in one transaction.
 */

/** What the Stock In form needs to show an entry again, to finish or to correct. */
export interface EntryToEdit {
  id: string
  docNo: string
  docstatus: number
  entryType: StockEntryType
  postingDate: string
  supplierId: string | null
  reference: string | null
  notes: string | null
  supplierInvoiceNo: string | null
  supplierInvoiceDate: string | null
  roundOff: Money
  lines: {
    productId: string
    /** Signed as stored: goods going out are below zero. */
    qty: Qty
    unitCost: Money
    taxRateBp: number
    cessRateBp: number
    batchNo: string | null
    expiryDate: string | null
    /** The batch's own MRP and price, where these goods were kept apart at one. */
    mrp: Money | null
    saleRate: Money | null
  }[]
  /** Why this one cannot be corrected from Stock In, or null when it can. */
  locked: 'FROM_AN_ORDER' | 'FROM_A_COUNT' | null
}

export async function loadEntryToEdit(db: SqlDriver, entryId: string): Promise<EntryToEdit | null> {
  const [head] = await q(db).select({
    id: schema.stockEntries.id,
    docNo: schema.stockEntries.docNo,
    docstatus: schema.stockEntries.docstatus,
    entryType: schema.stockEntries.entryType,
    postingDate: schema.stockEntries.postingDate,
    supplierId: schema.stockEntries.supplierId,
    reference: schema.stockEntries.reference,
    notes: schema.stockEntries.notes,
    supplierInvoiceNo: schema.stockEntries.supplierInvoiceNo,
    supplierInvoiceDate: schema.stockEntries.supplierInvoiceDate,
    roundOff: schema.stockEntries.roundOff,
  }).from(schema.stockEntries).where(eq(schema.stockEntries.id, entryId))
  if (!head) return null

  const lines = await q(db).select({
    productId: schema.stockEntryItems.productId,
    qty: schema.stockEntryItems.qty,
    unitCost: schema.stockEntryItems.unitCost,
    taxRateBp: schema.stockEntryItems.taxRateBp,
    cessRateBp: schema.stockEntryItems.cessRateBp,
    batchNo: schema.batches.batchNo,
    expiryDate: schema.batches.expiryDate,
    mrp: schema.batches.mrp,
    saleRate: schema.batches.rate,
  })
    .from(schema.stockEntryItems)
    .leftJoin(schema.stockEntryBatches, eq(schema.stockEntryBatches.itemId, schema.stockEntryItems.id))
    .leftJoin(schema.batches, eq(schema.batches.id, schema.stockEntryBatches.batchId))
    .where(eq(schema.stockEntryItems.entryId, entryId))
    // raw: the order the lines were typed in, which only the rowid keeps.
    .orderBy(sql`stock_entry_items.rowid`)

  return {
    ...head,
    entryType: head.entryType as StockEntryType,
    lines: lines.map((l) => ({
      ...l, batchNo: l.batchNo ?? null, expiryDate: l.expiryDate ?? null, mrp: l.mrp ?? null, saleRate: l.saleRate ?? null,
    })),
    locked: await lockedBy(db, entryId),
  }
}

/** An entry another screen made and still answers for: an order's delivery, or a count's adjustment. */
async function lockedBy(db: SqlDriver, entryId: string): Promise<EntryToEdit['locked']> {
  const [received] = await q(db).select({ id: schema.documentFulfilments.id }).from(schema.documentFulfilments)
    .where(and(eq(schema.documentFulfilments.targetKind, 'stock_entry'), eq(schema.documentFulfilments.targetId, entryId)))
    .limit(1)
  if (received) return 'FROM_AN_ORDER'
  const [counted] = await q(db).select({ id: schema.stockCounts.id }).from(schema.stockCounts)
    .where(eq(schema.stockCounts.entryId, entryId)).limit(1)
  return counted ? 'FROM_A_COUNT' : null
}

/** A refusal from inside a transaction, thrown so everything before it rolls back. */
class Refused<R> {
  constructor(readonly result: R) {}
}

async function inOne<R>(db: SqlDriver, fn: (tx: SqlDriver) => Promise<R>): Promise<R> {
  try {
    return await db.transaction(fn)
  } catch (err) {
    if (err instanceof Refused) return err.result as R
    throw err
  }
}

/** The draft as it is again: an earlier save of it, when `draftId` names one, is replaced. */
export type SaveDraftEntryInput = CreateStockEntryInput & { draftId?: string | null }
export type SaveDraftEntryResult = CreateStockEntryResult | { ok: false; code: 'NOT_A_DRAFT' }

export async function saveStockEntryDraft(db: SqlDriver, input: SaveDraftEntryInput): Promise<SaveDraftEntryResult> {
  const { draftId, ...entry } = input
  return inOne<SaveDraftEntryResult>(db, async (tx) => {
    if (draftId) {
      if (!await dropDraft(tx, draftId)) throw new Refused<SaveDraftEntryResult>({ ok: false, code: 'NOT_A_DRAFT' })
    }
    const made = await createStockEntry(tx, entry)
    if (!made.ok) throw new Refused<SaveDraftEntryResult>(made)
    return made
  })
}

export async function discardStockEntryDraft(
  db: SqlDriver, input: { entryId: string; actorId: string },
): Promise<{ ok: true } | { ok: false; code: 'NOT_A_DRAFT' }> {
  return inOne(db, async (tx) => {
    if (!await dropDraft(tx, input.entryId)) return { ok: false as const, code: 'NOT_A_DRAFT' as const }
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_entries', entityId: input.entryId, action: 'delete', docstatusFrom: DRAFT,
    })
    return { ok: true as const }
  })
}

/** Deletes a draft and its lines. False when the entry is not a draft -- posted on another till since, say. */
async function dropDraft(tx: SqlDriver, entryId: string): Promise<boolean> {
  const [held] = await q(tx).select({ docstatus: schema.stockEntries.docstatus })
    .from(schema.stockEntries).where(eq(schema.stockEntries.id, entryId))
  if (held?.docstatus !== DRAFT) return false
  await q(tx).delete(schema.stockEntryBatches).where(eq(schema.stockEntryBatches.entryId, entryId))
  await q(tx).delete(schema.stockEntryItems).where(eq(schema.stockEntryItems.entryId, entryId))
  await q(tx).delete(schema.stockEntries).where(eq(schema.stockEntries.id, entryId))
  return true
}

export type AmendEntryInput = Omit<CreateStockEntryInput, 'amendedFrom'> & { entryId: string }
export type AmendEntryResult =
  | { ok: true; entryId: string; docNo: string; replaced: string }
  | Extract<CreateStockEntryResult, { ok: false }>
  | Extract<SubmitStockEntryResult, { ok: false }>
  | PeriodClosed
  | { ok: false; code: 'UNKNOWN_ENTRY' | 'NOT_POSTED' | 'FROM_AN_ORDER' | 'FROM_A_COUNT' }

/**
 * A posted entry corrected: cancelled, and the corrected one posted in its place.
 *
 * Its stock was put on the shelf and may have been sold since, so the end is
 * checked rather than the steps: a rate fixed on goods half sold is fine,
 * while a quantity cut below what has already gone out would leave the shelf
 * short, and rolls the whole correction back. Only a fall below zero that the
 * correction itself caused counts -- a shelf already short stays as it was.
 */
export async function amendStockEntry(db: SqlDriver, input: AmendEntryInput): Promise<AmendEntryResult> {
  await requirePermission(db, input.actorId, 'stock_entry', 'submit')
  const { entryId, ...entry } = input
  return inOne<AmendEntryResult>(db, async (tx) => {
    const refuse = (r: AmendEntryResult): never => { throw new Refused<AmendEntryResult>(r) }
    const old = await loadEntryToEdit(tx, entryId) ?? refuse({ ok: false, code: 'UNKNOWN_ENTRY' })
    if (old.docstatus !== SUBMITTED) refuse({ ok: false, code: 'NOT_POSTED' })
    if (old.locked) refuse({ ok: false, code: old.locked })

    const products = [...new Set([...old.lines, ...entry.lines].map((l) => l.productId))]
    const batches = old.lines.filter((l) => l.batchNo !== null).map((l) => ({ productId: l.productId, batchNo: l.batchNo! }))
    const before = await shelf(tx, products, batches)

    const cancelled = await cancelStockEntry(tx, { entryId, reason: 'Corrected', actorId: input.actorId, ...(input.now ? { now: input.now } : {}) })
    if (!cancelled.ok) return refuse(cancelled)
    const made = await createStockEntry(tx, { ...entry, amendedFrom: entryId })
    if (!made.ok) return refuse(made)
    const posted = await submitStockEntry(tx, { entryId: made.entryId, actorId: input.actorId, ...(input.now ? { now: input.now } : {}) })
    if (!posted.ok) return refuse(posted)

    const after = await shelf(tx, products, batches)
    for (const [key, was] of before) {
      const now = after.get(key)!
      if (now.qty < 0 && now.qty < was.qty) {
        refuse({ ok: false, code: 'WOULD_GO_NEGATIVE', productId: now.productId, available: was.qty, change: (now.qty - was.qty) as Qty })
      }
    }
    return { ok: true, entryId: made.entryId, docNo: posted.docNo, replaced: old.docNo }
  })
}

/** What the shelf holds of each product, and of each batch, keyed so the two can be compared. */
async function shelf(
  tx: SqlDriver, products: string[], batches: { productId: string; batchNo: string }[],
): Promise<Map<string, { productId: string; qty: Qty }>> {
  const held = new Map<string, { productId: string; qty: Qty }>()
  for (const id of products) held.set(id, { productId: id, qty: await currentStock(tx, id) })
  for (const b of batches) {
    const row = await findBatch(tx, b.productId, b.batchNo)
    held.set(`${b.productId}|${b.batchNo}`, { productId: b.productId, qty: (row?.balance ?? 0) as Qty })
  }
  return held
}
