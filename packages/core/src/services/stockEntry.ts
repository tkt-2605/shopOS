import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import { type Qty, qty } from '../quantity.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { postMovement, reverseVoucher, currentStock } from './stock.js'
import { nextDocNo } from './numbering.js'

export type StockEntryType = 'purchase' | 'adjustment' | 'opening' | 'wastage'

export interface StockEntryLineInput {
  productId: string
  /** Base units. Negative is legitimate for adjustment and wastage. */
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

export async function createStockEntry(
  db: SqlDriver,
  input: CreateStockEntryInput,
): Promise<CreateStockEntryResult> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  const now = input.now ?? new Date()
  const inflowOnly = input.entryType === 'purchase' || input.entryType === 'opening'

  for (const line of input.lines) {
    if (line.qty === 0) return { ok: false, code: 'ZERO_QTY', productId: line.productId }
    if (inflowOnly && line.qty < 0) {
      return { ok: false, code: 'INFLOW_NEEDS_POSITIVE_QTY', productId: line.productId }
    }
    const exists = await db.get<{ id: string }>(
      `SELECT id FROM products WHERE id = ? AND deleted_at IS NULL`,
      [line.productId],
    )
    if (!exists) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }
  }

  const entryId = newId()
  const nowIso = now.toISOString()
  const postingDate = input.postingDate ?? nowIso.slice(0, 10)

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO stock_entries
         (id, doc_no, docstatus, entry_type, posting_date, supplier_id, supplier_name, reference, notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId, `DRAFT-${entryId}`, input.entryType, postingDate,
        input.supplierId ?? null, input.supplierName ?? null,
        input.reference ?? null, input.notes ?? null, input.actorId, nowIso, nowIso,
      ],
    )

    for (const line of input.lines) {
      await tx.execute(
        `INSERT INTO stock_entry_items (id, entry_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?, ?)`,
        [newId(), entryId, line.productId, line.qty, line.unitCost ?? 0],
      )
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

  const lines = await db.query<{ product_id: string; qty: number; unit_cost: number }>(
    `SELECT product_id, qty, unit_cost FROM stock_entry_items WHERE entry_id = ?`,
    [input.entryId],
  )

  for (const line of lines) {
    if (line.qty >= 0) continue
    const available = await currentStock(db, line.product_id)
    if (available + line.qty < 0) {
      return { ok: false, code: 'WOULD_GO_NEGATIVE', productId: line.product_id, available, change: qty(line.qty) }
    }
  }

  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'stock_entry', 'MR', now)

    for (const line of lines) {
      await postMovement(tx, {
        productId: line.product_id,
        qtyChange: qty(line.qty),
        unitCost: (line.unit_cost || null) as Money | null,
        voucherType: 'stock_entry',
        voucherId: input.entryId,
        postingDate: entry.postingDate,
        userId: input.actorId,
      })
    }

    await tx.execute(
      `UPDATE stock_entries SET docstatus = 1, doc_no = ?, updated_at = ? WHERE id = ?`,
      [docNo, nowIso, input.entryId],
    )

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

  await db.transaction(async (tx) => {
    await reverseVoucher(tx, 'stock_entry', input.entryId, entry.postingDate, input.actorId)
    await tx.execute(
      `UPDATE stock_entries SET docstatus = 2, updated_at = ? WHERE id = ?`,
      [now.toISOString(), input.entryId],
    )
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
  const row = await db.get<{ id: string; doc_no: string; docstatus: number; entry_type: string; posting_date: string }>(
    `SELECT id, doc_no, docstatus, entry_type, posting_date FROM stock_entries WHERE id = ?`,
    [entryId],
  )
  if (!row) throw new Error(`unknown stock entry: ${entryId}`)
  return {
    id: row.id,
    docNo: row.doc_no,
    docstatus: row.docstatus,
    entryType: row.entry_type as StockEntryType,
    postingDate: row.posting_date,
  }
}
