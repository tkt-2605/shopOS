import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import { type Qty, qty, subQty } from '../quantity.js'
import { businessDate } from '../dates.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { nextDocNo } from './numbering.js'
import { createStockEntry, submitStockEntry, cancelStockEntry } from './stockEntry.js'

/**
 * The physical count.
 *
 * A sheet is opened against a moment: every line records what the system
 * believed then. The shop goes on selling while the counting happens, which is
 * the whole difficulty — a count that writes the number it was given would erase
 * every sale rung up in between, and one that refuses to submit because stock
 * moved would never submit in a working shop.
 *
 * So the sheet posts the *difference* it found, not the total it counted, and
 * says which lines moved underneath it. Twelve on the shelf against a system
 * fourteen is a shortage of two, and it stays a shortage of two even if three
 * were sold while the counter was at the back of the shop.
 *
 * What it produces is an ordinary adjustment stock entry. There is one path into
 * the ledger and the valuation, and it is the one that was already tested.
 */

export type CountScope =
  | { kind: 'all' }
  | { kind: 'category'; categoryId: string }
  | { kind: 'chosen'; productIds: string[] }

export interface OpenCountInput {
  scope: CountScope
  note?: string
  actorId: string
  now?: Date
  /** Include items the system thinks are at zero. Off by default: a shop
   *  counting its shelves is not looking for what it does not have. */
  includeEmpty?: boolean
}

export type OpenCountResult =
  | { ok: true; countId: string; docNo: string; lineCount: number }
  | { ok: false; code: 'NOTHING_TO_COUNT' }
  | { ok: false; code: 'ALREADY_OPEN'; countId: string; docNo: string }

export interface CountLine {
  id: string
  productId: string
  productName: string
  code: string | null
  barcode: string | null
  categoryName: string | null
  baseUnit: string
  expectedQty: Qty
  countedQty: Qty | null
  unitCost: Money | null
}

export interface CountSheet {
  id: string
  docNo: string
  docstatus: number
  scope: string
  categoryId: string | null
  note: string | null
  openedAt: string
  postingDate: string
  entryId: string | null
  createdBy: string
  lines: CountLine[]
}

/**
 * Opens a sheet, freezing what the system believes right now.
 *
 * One open sheet at a time, because two counts of the same shelf both posting
 * their difference would apply the same correction twice.
 */
export async function openCount(db: SqlDriver, input: OpenCountInput): Promise<OpenCountResult> {
  const existing = await db.get<{ id: string; doc_no: string }>(
    `SELECT id, doc_no FROM stock_counts WHERE docstatus = 0 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  )
  if (existing) return { ok: false, code: 'ALREADY_OPEN', countId: existing.id, docNo: existing.doc_no }

  const now = input.now ?? new Date()
  const where: string[] = ['p.deleted_at IS NULL', 'p.is_active = 1', 'p.is_stock_tracked = 1']
  const args: (string | number)[] = []

  if (input.scope.kind === 'category') {
    where.push('p.category_id = ?')
    args.push(input.scope.categoryId)
  } else if (input.scope.kind === 'chosen') {
    if (input.scope.productIds.length === 0) return { ok: false, code: 'NOTHING_TO_COUNT' }
    where.push(`p.id IN (${input.scope.productIds.map(() => '?').join(', ')})`)
    args.push(...input.scope.productIds)
  }
  if (!input.includeEmpty && input.scope.kind !== 'chosen') {
    where.push('COALESCE(s.qty_on_hand, 0) <> 0')
  }

  const rows = await db.query<{ id: string; qty_on_hand: number; stock_value: number }>(
    `SELECT p.id, COALESCE(s.qty_on_hand, 0) AS qty_on_hand, COALESCE(s.stock_value, 0) AS stock_value
       FROM products p
       LEFT JOIN product_stock s ON s.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name`,
    args,
  )
  if (rows.length === 0) return { ok: false, code: 'NOTHING_TO_COUNT' }

  const countId = newId()
  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'stock_count', 'MR', now)

    await tx.execute(
      `INSERT INTO stock_counts
         (id, doc_no, docstatus, scope, category_id, note, opened_at, posting_date,
          created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        countId, docNo, input.scope.kind,
        input.scope.kind === 'category' ? input.scope.categoryId : null,
        input.note?.trim() || null, nowIso, businessDate(now),
        input.actorId, nowIso, nowIso,
      ],
    )

    for (const row of rows) {
      await tx.execute(
        `INSERT INTO stock_count_items (id, count_id, product_id, expected_qty, counted_qty, unit_cost)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        [newId(), countId, row.id, row.qty_on_hand, unitCostOf(row.qty_on_hand, row.stock_value)],
      )
    }

    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: countId, action: 'create', docstatusTo: DRAFT,
      after: { doc_no: docNo, scope: input.scope.kind, lines: rows.length },
    })
  })

  return { ok: true, countId, docNo, lineCount: rows.length }
}

/** Moving average at the moment the sheet opened. Null when there is nothing to
 *  average — found goods then come in at no value rather than a guessed one. */
function unitCostOf(quantity: number, value: number): number | null {
  if (quantity <= 0 || value <= 0) return null
  return Math.round((value * 10_000) / quantity)
}

export async function loadCount(db: SqlDriver, countId: string): Promise<CountSheet | null> {
  const head = await db.get<{
    id: string; doc_no: string; docstatus: number; scope: string; category_id: string | null
    note: string | null; opened_at: string; posting_date: string; entry_id: string | null
    created_by: string
  }>(
    `SELECT id, doc_no, docstatus, scope, category_id, note, opened_at, posting_date, entry_id, created_by
       FROM stock_counts WHERE id = ? AND deleted_at IS NULL`,
    [countId],
  )
  if (!head) return null

  const lines = await db.query<{
    id: string; product_id: string; product_name: string; code: string | null
    barcode: string | null; category_name: string | null; base_unit: string
    expected_qty: number; counted_qty: number | null; unit_cost: number | null
  }>(
    `SELECT i.id, i.product_id, p.name AS product_name, p.code, p.barcode,
            c.name AS category_name, p.base_unit,
            i.expected_qty, i.counted_qty, i.unit_cost
       FROM stock_count_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE i.count_id = ?
      ORDER BY c.name, p.name`,
    [countId],
  )

  return {
    id: head.id,
    docNo: head.doc_no,
    docstatus: head.docstatus,
    scope: head.scope,
    categoryId: head.category_id,
    note: head.note,
    openedAt: head.opened_at,
    postingDate: head.posting_date,
    entryId: head.entry_id,
    createdBy: head.created_by,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      productName: l.product_name,
      code: l.code,
      barcode: l.barcode,
      categoryName: l.category_name,
      baseUnit: l.base_unit,
      expectedQty: qty(l.expected_qty),
      countedQty: l.counted_qty === null ? null : qty(l.counted_qty),
      unitCost: l.unit_cost === null ? null : (l.unit_cost as Money),
    })),
  }
}

export async function openSheet(db: SqlDriver): Promise<{ id: string; docNo: string } | null> {
  const row = await db.get<{ id: string; doc_no: string }>(
    `SELECT id, doc_no FROM stock_counts WHERE docstatus = 0 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  )
  return row ? { id: row.id, docNo: row.doc_no } : null
}

export interface CountSummary {
  id: string
  docNo: string
  docstatus: number
  postingDate: string
  openedAt: string
  note: string | null
  lineCount: number
  countedCount: number
  differenceCount: number
}

export async function listCounts(db: SqlDriver, limit = 50): Promise<CountSummary[]> {
  const rows = await db.query<{
    id: string; doc_no: string; docstatus: number; posting_date: string; opened_at: string
    note: string | null; lines: number; counted: number; differing: number
  }>(
    `SELECT c.id, c.doc_no, c.docstatus, c.posting_date, c.opened_at, c.note,
            COUNT(i.id) AS lines,
            SUM(CASE WHEN i.counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted,
            SUM(CASE WHEN i.counted_qty IS NOT NULL AND i.counted_qty <> i.expected_qty THEN 1 ELSE 0 END) AS differing
       FROM stock_counts c
       LEFT JOIN stock_count_items i ON i.count_id = c.id
      WHERE c.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ?`,
    [limit],
  )
  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    docstatus: r.docstatus,
    postingDate: r.posting_date,
    openedAt: r.opened_at,
    note: r.note,
    lineCount: r.lines,
    countedCount: r.counted ?? 0,
    differenceCount: r.differing ?? 0,
  }))
}

/**
 * Records what was on the shelf. `null` puts a line back to uncounted, which is
 * not the same as counting zero.
 */
export async function setCounted(
  db: SqlDriver,
  input: { countId: string; productId: string; countedQty: Qty | null },
): Promise<void> {
  const head = await db.get<{ docstatus: number }>(
    `SELECT docstatus FROM stock_counts WHERE id = ? AND deleted_at IS NULL`,
    [input.countId],
  )
  if (!head) throw new Error('no such count')
  if (head.docstatus !== DRAFT) throw new Error('that count sheet has already been submitted')
  if (input.countedQty !== null && input.countedQty < 0) {
    throw new RangeError('a shelf cannot hold less than nothing')
  }

  await db.execute(
    `UPDATE stock_count_items SET counted_qty = ? WHERE count_id = ? AND product_id = ?`,
    [input.countedQty, input.countId, input.productId],
  )
}

/** A line whose stock moved between the sheet opening and it being submitted. */
export interface MovedLine {
  productId: string
  productName: string
  expectedQty: Qty
  currentQty: Qty
}

export type SubmitCountResult =
  | {
      ok: true
      countId: string
      docNo: string
      /** The adjustment produced, or null when every counted line agreed. */
      entryId: string | null
      entryDocNo: string | null
      adjusted: number
      shortages: number
      surpluses: number
      /** Lines that were sold or received while the counting was happening. */
      moved: MovedLine[]
    }
  | { ok: false; code: 'NOTHING_COUNTED' }
  | { ok: false; code: 'WOULD_GO_NEGATIVE'; productId: string; available: Qty; change: Qty }

/**
 * Posts what the count found.
 *
 * Only counted lines are considered; an untouched line is not a claim that the
 * shelf is empty. Only differences are posted, so a count of two hundred items
 * that finds three wrong writes three ledger rows.
 */
export async function submitCount(
  db: SqlDriver,
  input: { countId: string; actorId: string; now?: Date },
): Promise<SubmitCountResult> {
  const now = input.now ?? new Date()
  const head = await db.get<{ id: string; doc_no: string; docstatus: number; posting_date: string }>(
    `SELECT id, doc_no, docstatus, posting_date FROM stock_counts WHERE id = ? AND deleted_at IS NULL`,
    [input.countId],
  )
  if (!head) throw new Error('no such count')
  assertCanApply('stock count', parseDocStatus(head.docstatus), 'submit')

  const lines = await db.query<{
    product_id: string; product_name: string; expected_qty: number
    counted_qty: number; unit_cost: number | null; on_hand: number
  }>(
    `SELECT i.product_id, p.name AS product_name, i.expected_qty, i.counted_qty, i.unit_cost,
            COALESCE(s.qty_on_hand, 0) AS on_hand
       FROM stock_count_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_stock s ON s.product_id = i.product_id
      WHERE i.count_id = ? AND i.counted_qty IS NOT NULL`,
    [input.countId],
  )
  if (lines.length === 0) return { ok: false, code: 'NOTHING_COUNTED' }

  // What the shop sold or received while the shelf was being counted. Reported,
  // never corrected: those movements are real and the count did not see them.
  const moved: MovedLine[] = lines
    .filter((l) => l.on_hand !== l.expected_qty)
    .map((l) => ({
      productId: l.product_id,
      productName: l.product_name,
      expectedQty: qty(l.expected_qty),
      currentQty: qty(l.on_hand),
    }))

  const differences = lines
    .map((l) => ({ ...l, change: subQty(qty(l.counted_qty), qty(l.expected_qty)) }))
    .filter((l) => l.change !== 0)

  const nowIso = now.toISOString()

  if (differences.length === 0) {
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE stock_counts SET docstatus = 1, updated_at = ?, rev = rev + 1 WHERE id = ?`,
        [nowIso, input.countId],
      )
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'stock_counts', entityId: input.countId, action: 'submit',
        docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
        after: { counted: lines.length, adjusted: 0 },
      })
    })
    return {
      ok: true, countId: input.countId, docNo: head.doc_no,
      entryId: null, entryDocNo: null, adjusted: 0, shortages: 0, surpluses: 0, moved,
    }
  }

  // Through the ordinary adjustment entry, so the ledger, the valuation and the
  // ability to cancel are the ones already built and tested.
  const entry = await createStockEntry(db, {
    entryType: 'adjustment',
    postingDate: head.posting_date,
    reference: head.doc_no,
    notes: `Physical count ${head.doc_no}`,
    actorId: input.actorId,
    now,
    lines: differences.map((l) => ({
      productId: l.product_id,
      qty: l.change,
      // Goods found come back at what the shelf was worth when the sheet opened.
      // A count corrects a quantity; it is not a purchase and must not move the
      // average. Goods short are valued by the ledger itself on the way out.
      ...(l.change > 0 && l.unit_cost ? { unitCost: l.unit_cost as Money } : {}),
    })),
  })
  if (!entry.ok) throw new Error(`the count could not be posted: ${entry.code}`)

  const submitted = await submitStockEntry(db, { entryId: entry.entryId, actorId: input.actorId, now })
  if (!submitted.ok) {
    return {
      ok: false, code: 'WOULD_GO_NEGATIVE',
      productId: submitted.productId, available: submitted.available, change: submitted.change,
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE stock_counts SET docstatus = 1, entry_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [entry.entryId, nowIso, input.countId],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: input.countId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      after: { counted: lines.length, adjusted: differences.length, entry: submitted.docNo },
    })
  })

  return {
    ok: true,
    countId: input.countId,
    docNo: head.doc_no,
    entryId: entry.entryId,
    entryDocNo: submitted.docNo,
    adjusted: differences.length,
    shortages: differences.filter((l) => l.change < 0).length,
    surpluses: differences.filter((l) => l.change > 0).length,
    moved,
  }
}

/**
 * Abandons a sheet, or reverses a submitted one.
 *
 * A count that was wrong — the boy counted the wrong shelf — has to be undoable,
 * and the adjustment it produced is reversed the same way any stock entry is.
 */
export async function cancelCount(
  db: SqlDriver,
  input: { countId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true }> {
  const now = input.now ?? new Date()
  const head = await db.get<{ docstatus: number; entry_id: string | null }>(
    `SELECT docstatus, entry_id FROM stock_counts WHERE id = ? AND deleted_at IS NULL`,
    [input.countId],
  )
  if (!head) throw new Error('no such count')

  const from = parseDocStatus(head.docstatus)
  if (from === SUBMITTED && head.entry_id) {
    await cancelStockEntry(db, { entryId: head.entry_id, actorId: input.actorId, now })
  }

  const nowIso = now.toISOString()
  await db.transaction(async (tx) => {
    if (from === DRAFT) {
      // A sheet nobody submitted is not history worth keeping.
      await tx.execute(`UPDATE stock_counts SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        [nowIso, nowIso, input.countId])
    } else {
      assertCanApply('stock count', from, 'cancel')
      await tx.execute(
        `UPDATE stock_counts SET docstatus = 2, updated_at = ?, rev = rev + 1 WHERE id = ?`,
        [nowIso, input.countId],
      )
    }
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: input.countId, action: from === DRAFT ? 'delete' : 'cancel',
      docstatusFrom: from, docstatusTo: from === DRAFT ? DRAFT : CANCELLED,
      after: input.reason ? { reason: input.reason } : null,
    })
  })

  return { ok: true }
}
