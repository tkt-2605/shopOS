import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Money, ZERO } from '../money.js'
import type { Qty } from '../quantity.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { postMovement, reverseVoucher, currentStock } from './stock.js'
import { nextDocNo, seriesPrefix } from './numbering.js'

export type StockEntryType = 'purchase' | 'adjustment' | 'opening' | 'wastage'

export interface StockEntryLineInput {
  productId: string
  /**
   * Base units, signed for an adjustment and signed *for you* for wastage.
   *
   * A purchase and an opening stock must be positive and are refused
   * otherwise. An adjustment is a correction and genuinely goes either way.
   * Wastage only ever goes one way — see `directionOf` — so whatever sign
   * arrives here, what is stored is a loss.
   */
  qty: Qty
  unitCost?: Money
}

export interface CreateStockEntryInput {
  entryType: StockEntryType
  lines: StockEntryLineInput[]
  supplierId?: string | null
  supplierName?: string | null
  reference?: string
  notes?: string
  postingDate?: string
  actorId: string
  now?: Date
}

export type CreateStockEntryResult =
  | { ok: true; entryId: string; lineCount: number }
  | { ok: false; code: 'NO_LINES' }
  | { ok: false; code: 'ZERO_QTY'; productId: string }
  | { ok: false; code: 'UNKNOWN_PRODUCT'; productId: string }
  | { ok: false; code: 'INFLOW_NEEDS_POSITIVE_QTY'; productId: string }

export type SubmitStockEntryResult =
  | { ok: true; entryId: string; docNo: string }
  | { ok: false; code: 'WOULD_GO_NEGATIVE'; productId: string; available: Qty; change: Qty }

/**
 * Which way a kind of entry moves the shelf.
 *
 * Wastage is the one with no second direction. Damaged or expired goods are a
 * loss; there is no such thing as negative wastage, and a shop that types 5
 * into a wastage entry means five gone, not five more.
 *
 * It used to mean five more. The screen carried the rule -- it took the
 * absolute value for a purchase and passed everything else through as typed --
 * and the quantity box starts at 1, so choosing Wastage and pressing save
 * added one to the shelf. The note beside it read “Damaged or expired.
 * Negative.”, which asked a shopkeeper to encode a direction they had already
 * chosen from a list, in a box with no sign in it.
 *
 * So the rule lives here rather than on the screen. It is a fact about what
 * wastage *is*, and a second screen, an import or a supplier integration
 * would otherwise each have to remember it — which is how one of them does
 * not.
 */
export function directionOf(entryType: StockEntryType): 'in' | 'out' | 'either' {
  switch (entryType) {
    case 'purchase': return 'in'
    case 'opening': return 'in'
    case 'wastage': return 'out'
    case 'adjustment': return 'either'
  }
}

/** The quantity as it will be stored, once the kind of entry has had its say. */
export function signedQty(entryType: StockEntryType, qty: Qty): Qty {
  switch (directionOf(entryType)) {
    case 'in': return Math.abs(qty) as Qty
    case 'out': return -Math.abs(qty) as Qty
    case 'either': return qty
  }
}

export async function createStockEntry(
  db: SqlDriver,
  input: CreateStockEntryInput,
): Promise<CreateStockEntryResult> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  const now = input.now ?? new Date()
  const inflowOnly = input.entryType === 'purchase' || input.entryType === 'opening'

  for (const line of input.lines) {
    if (line.qty === 0) return { ok: false, code: 'ZERO_QTY', productId: line.productId }
    /* A purchase is still *refused* rather than silently flipped. Somebody
       entering -10 against a delivery has made a mistake worth stopping on,
       where somebody entering 5 against wastage has not. */
    if (inflowOnly && line.qty < 0) {
      return { ok: false, code: 'INFLOW_NEEDS_POSITIVE_QTY', productId: line.productId }
    }
    const [exists] = await q(db)
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
    if (!exists) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }
  }

  const entryId = newId()
  const nowIso = now.toISOString()
  const postingDate = input.postingDate ?? nowIso.slice(0, 10)

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.stockEntries).values({
      id: entryId,
      docNo: `DRAFT-${entryId}`,
      docstatus: DRAFT,
      entryType: input.entryType,
      postingDate,
      supplierId: input.supplierId ?? null,
      supplierName: input.supplierName ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const line of input.lines) {
      await q(tx).insert(schema.stockEntryItems).values({
        id: newId(),
        entryId,
        productId: line.productId,
        qty: signedQty(input.entryType, line.qty),
        unitCost: line.unitCost ?? ZERO,
      })
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_entries', entityId: entryId, action: 'create', docstatusTo: DRAFT,
      after: { entry_type: input.entryType, lines: input.lines.length },
    })
  })

  return { ok: true, entryId, lineCount: input.lines.length }
}

export async function submitStockEntry(
  db: SqlDriver,
  input: { entryId: string; actorId: string; now?: Date },
): Promise<SubmitStockEntryResult> {
  const now = input.now ?? new Date()
  const entry = await loadEntry(db, input.entryId)
  assertCanApply('stock entry', parseDocStatus(entry.docstatus), 'submit')

  const lines = await q(db)
    .select({
      productId: schema.stockEntryItems.productId,
      qty: schema.stockEntryItems.qty,
      unitCost: schema.stockEntryItems.unitCost,
    })
    .from(schema.stockEntryItems)
    .where(eq(schema.stockEntryItems.entryId, input.entryId))

  for (const line of lines) {
    if (line.qty >= 0) continue
    const available = await currentStock(db, line.productId)
    if (available + line.qty < 0) {
      return { ok: false, code: 'WOULD_GO_NEGATIVE', productId: line.productId, available, change: line.qty }
    }
  }

  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'stock_entry', await seriesPrefix(tx, 'MR'), now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.productId,
        qtyChange: line.qty,
        // Zero is "not recorded", not "free": the column has no null in it.
        unitCost: line.unitCost || null,
        voucherType: 'stock_entry',
        voucherId: input.entryId,
        postingDate: entry.postingDate,
        userId: input.actorId,
      })
    }

    await q(tx).update(schema.stockEntries)
      .set({ docstatus: SUBMITTED, docNo, updatedAt: nowIso })
      .where(eq(schema.stockEntries.id, input.entryId))

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_entries', entityId: input.entryId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      before: { doc_no: entry.docNo }, after: { doc_no: docNo },
    })
  })

  return { ok: true, entryId: input.entryId, docNo }
}

export async function cancelStockEntry(
  db: SqlDriver,
  input: { entryId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true; entryId: string }> {
  const now = input.now ?? new Date()
  const entry = await loadEntry(db, input.entryId)
  assertCanApply('stock entry', parseDocStatus(entry.docstatus), 'cancel')

  const nowIso = now.toISOString()

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'stock_entry', input.entryId, entry.postingDate, input.actorId)
    await q(tx).update(schema.stockEntries)
      .set({ docstatus: CANCELLED, updatedAt: nowIso })
      .where(eq(schema.stockEntries.id, input.entryId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_entries', entityId: input.entryId, action: 'cancel',
      docstatusFrom: SUBMITTED, docstatusTo: CANCELLED,
      after: { cancel_reason: input.reason ?? null },
    })
  })

  return { ok: true, entryId: input.entryId }
}

interface EntryRow {
  id: string
  docNo: string
  docstatus: number
  entryType: StockEntryType
  postingDate: string
}

async function loadEntry(db: SqlDriver, entryId: string): Promise<EntryRow> {
  const [row] = await q(db)
    .select({
      id: schema.stockEntries.id,
      doc_no: schema.stockEntries.docNo,
      docstatus: schema.stockEntries.docstatus,
      entry_type: schema.stockEntries.entryType,
      posting_date: schema.stockEntries.postingDate,
    })
    .from(schema.stockEntries)
    .where(eq(schema.stockEntries.id, entryId))
  if (!row) throw new Error(`unknown stock entry: ${entryId}`)
  return {
    id: row.id,
    docNo: row.doc_no,
    docstatus: row.docstatus,
    entryType: row.entry_type as StockEntryType,
    postingDate: row.posting_date,
  }
}
