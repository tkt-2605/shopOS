import { eq, and, inArray, isNull, isNotNull, desc, count, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Money, paise } from '../money.js'
import { type Qty, subQty } from '../quantity.js'
import { businessDate } from '../dates.js'
import { DRAFT, SUBMITTED, CANCELLED, assertCanApply, parseDocStatus } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { nextDocNo, seriesPrefix } from './numbering.js'
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
  const existing = await openSheet(db)
  if (existing) return { ok: false, code: 'ALREADY_OPEN', countId: existing.id, docNo: existing.docNo }

  const now = input.now ?? new Date()

  /* The scope used to be built as a string of SQL with a matching array of
     arguments kept in step by hand. `and()` takes the same shape without the
     two lists being able to disagree, and `inArray` writes its own placeholders
     -- which is where a hand-built `IN` list goes wrong. */
  const onHand = sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`
  const scoped = []
  if (input.scope.kind === 'category') {
    scoped.push(eq(schema.products.categoryId, input.scope.categoryId))
  } else if (input.scope.kind === 'chosen') {
    if (input.scope.productIds.length === 0) return { ok: false, code: 'NOTHING_TO_COUNT' }
    scoped.push(inArray(schema.products.id, input.scope.productIds))
  }
  if (!input.includeEmpty && input.scope.kind !== 'chosen') {
    scoped.push(sql`${onHand} <> 0`)
  }

  const rows = await q(db)
    .select({
      id: schema.products.id,
      qtyOnHand: onHand,
      stockValue: sql<Money>`COALESCE(${schema.productStock.stockValue}, 0)`,
    })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(and(
      isNull(schema.products.deletedAt),
      eq(schema.products.isActive, 1),
      eq(schema.products.isStockTracked, 1),
      ...scoped,
    ))
    .orderBy(schema.products.name)
  if (rows.length === 0) return { ok: false, code: 'NOTHING_TO_COUNT' }

  const countId = newId()
  const nowIso = now.toISOString()
  let docNo = ''

  await db.transaction(async (tx) => {
    docNo = await nextDocNo(tx, 'stock_count', await seriesPrefix(tx, 'MR'), now)

    await q(tx).insert(schema.stockCounts).values({
      id: countId,
      docNo,
      docstatus: DRAFT,
      scope: input.scope.kind,
      categoryId: input.scope.kind === 'category' ? input.scope.categoryId : null,
      note: input.note?.trim() || null,
      openedAt: nowIso,
      postingDate: businessDate(now),
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    for (const row of rows) {
      await q(tx).insert(schema.stockCountItems).values({
        id: newId(),
        countId,
        productId: row.id,
        expectedQty: row.qtyOnHand,
        countedQty: null,
        unitCost: unitCostOf(row.qtyOnHand, row.stockValue),
      })
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
function unitCostOf(quantity: Qty, value: Money): Money | null {
  if (quantity <= 0 || value <= 0) return null
  return paise(Math.round((value * 10_000) / quantity))
}

export async function loadCount(db: SqlDriver, countId: string): Promise<CountSheet | null> {
  const [head] = await q(db)
    .select({
      id: schema.stockCounts.id,
      docNo: schema.stockCounts.docNo,
      docstatus: schema.stockCounts.docstatus,
      scope: schema.stockCounts.scope,
      categoryId: schema.stockCounts.categoryId,
      note: schema.stockCounts.note,
      openedAt: schema.stockCounts.openedAt,
      postingDate: schema.stockCounts.postingDate,
      entryId: schema.stockCounts.entryId,
      createdBy: schema.stockCounts.createdBy,
    })
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.id, countId), isNull(schema.stockCounts.deletedAt)))
  if (!head) return null

  /* The quantities and the cost arrive branded now -- `expected_qty` is a `Qty`
     and `unit_cost` a `Money` because that is what the column says they are, so
     the re-wrapping this used to do on every row is gone. */
  const lines = await q(db)
    .select({
      id: schema.stockCountItems.id,
      productId: schema.stockCountItems.productId,
      productName: schema.products.name,
      code: schema.products.code,
      barcode: schema.products.barcode,
      categoryName: schema.categories.name,
      baseUnit: schema.products.baseUnit,
      expectedQty: schema.stockCountItems.expectedQty,
      countedQty: schema.stockCountItems.countedQty,
      unitCost: schema.stockCountItems.unitCost,
    })
    .from(schema.stockCountItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.stockCountItems.productId))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(eq(schema.stockCountItems.countId, countId))
    .orderBy(schema.categories.name, schema.products.name)

  return { ...head, lines }
}

export async function openSheet(db: SqlDriver): Promise<{ id: string; docNo: string } | null> {
  const [row] = await q(db)
    .select({ id: schema.stockCounts.id, docNo: schema.stockCounts.docNo })
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.docstatus, DRAFT), isNull(schema.stockCounts.deletedAt)))
    .orderBy(schema.stockCounts.createdAt)
    .limit(1)
  return row ?? null
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
  const counted = schema.stockCountItems.countedQty
  const expected = schema.stockCountItems.expectedQty

  const rows = await q(db)
    .select({
      id: schema.stockCounts.id,
      docNo: schema.stockCounts.docNo,
      docstatus: schema.stockCounts.docstatus,
      postingDate: schema.stockCounts.postingDate,
      openedAt: schema.stockCounts.openedAt,
      note: schema.stockCounts.note,
      lineCount: count(schema.stockCountItems.id),
      countedCount: sql<number>`SUM(CASE WHEN ${counted} IS NOT NULL THEN 1 ELSE 0 END)`,
      /* A line put back to uncounted is not a difference, which is why the
         `IS NOT NULL` is repeated here rather than left to the comparison:
         `NULL <> expected` is NULL, and would be counted by neither branch. */
      differenceCount: sql<number>`SUM(CASE WHEN ${counted} IS NOT NULL AND ${counted} <> ${expected} THEN 1 ELSE 0 END)`,
    })
    .from(schema.stockCounts)
    .leftJoin(schema.stockCountItems, eq(schema.stockCountItems.countId, schema.stockCounts.id))
    .where(isNull(schema.stockCounts.deletedAt))
    .groupBy(schema.stockCounts.id)
    .orderBy(desc(schema.stockCounts.createdAt))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    countedCount: r.countedCount ?? 0,
    differenceCount: r.differenceCount ?? 0,
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
  const [head] = await q(db)
    .select({ docstatus: schema.stockCounts.docstatus })
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.id, input.countId), isNull(schema.stockCounts.deletedAt)))
  if (!head) throw new Error('no such count')
  if (head.docstatus !== DRAFT) throw new Error('that count sheet has already been submitted')
  if (input.countedQty !== null && input.countedQty < 0) {
    throw new RangeError('a shelf cannot hold less than nothing')
  }

  await q(db).update(schema.stockCountItems)
    .set({ countedQty: input.countedQty })
    .where(and(
      eq(schema.stockCountItems.countId, input.countId),
      eq(schema.stockCountItems.productId, input.productId),
    ))
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
/** A refusal from inside the transaction, thrown so that everything before it rolls back. */
class Refused {
  constructor(readonly result: Extract<SubmitCountResult, { ok: false }>) {}
}

/**
 * One transaction for the whole of it: the adjustment entry, its submission and
 * the sheet's own status. Three used to follow one another, so a refusal at the
 * second left a draft entry behind on every attempt, and a till that stopped
 * between the second and the third had moved the stock with the sheet still
 * open -- submitting it again moved the stock again.
 */
export async function submitCount(
  db: SqlDriver,
  input: { countId: string; actorId: string; now?: Date },
): Promise<SubmitCountResult> {
  try {
    return await db.transaction((tx) => submitCountIn(tx, input))
  } catch (err) {
    if (err instanceof Refused) return err.result
    throw err
  }
}

async function submitCountIn(
  db: SqlDriver,
  input: { countId: string; actorId: string; now?: Date },
): Promise<SubmitCountResult> {
  const now = input.now ?? new Date()
  const [head] = await q(db)
    .select({
      id: schema.stockCounts.id,
      docNo: schema.stockCounts.docNo,
      docstatus: schema.stockCounts.docstatus,
      postingDate: schema.stockCounts.postingDate,
    })
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.id, input.countId), isNull(schema.stockCounts.deletedAt)))
  if (!head) throw new Error('no such count')
  assertCanApply('stock count', parseDocStatus(head.docstatus), 'submit')

  const lines = await q(db)
    .select({
      productId: schema.stockCountItems.productId,
      productName: schema.products.name,
      expectedQty: schema.stockCountItems.expectedQty,
      countedQty: schema.stockCountItems.countedQty,
      unitCost: schema.stockCountItems.unitCost,
      onHand: sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
    })
    .from(schema.stockCountItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.stockCountItems.productId))
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.stockCountItems.productId))
    .where(and(
      eq(schema.stockCountItems.countId, input.countId),
      isNotNull(schema.stockCountItems.countedQty),
    ))
  if (lines.length === 0) return { ok: false, code: 'NOTHING_COUNTED' }

  // What the shop sold or received while the shelf was being counted. Reported,
  // never corrected: those movements are real and the count did not see them.
  const moved: MovedLine[] = lines
    .filter((l) => l.onHand !== l.expectedQty)
    .map((l) => ({
      productId: l.productId,
      productName: l.productName,
      expectedQty: l.expectedQty,
      currentQty: l.onHand,
    }))

  /* `counted_qty` is not null on any of these -- the query asked for that -- but
     the column is nullable and the type says so, so it is narrowed rather than
     asserted. */
  const differences = lines
    .map((l) => ({ ...l, change: subQty(l.countedQty ?? l.expectedQty, l.expectedQty) }))
    .filter((l) => l.change !== 0)

  const nowIso = now.toISOString()

  if (differences.length === 0) {
    await db.transaction(async (tx) => {
      await q(tx).update(schema.stockCounts)
        .set({ docstatus: SUBMITTED, updatedAt: nowIso, rev: sql`${schema.stockCounts.rev} + 1` })
        .where(eq(schema.stockCounts.id, input.countId))
      await writeAudit(tx, { actorId: input.actorId }, {
        entity: 'stock_counts', entityId: input.countId, action: 'submit',
        docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
        after: { counted: lines.length, adjusted: 0 },
      })
    })
    return {
      ok: true, countId: input.countId, docNo: head.docNo,
      entryId: null, entryDocNo: null, adjusted: 0, shortages: 0, surpluses: 0, moved,
    }
  }

  // Through the ordinary adjustment entry, so the ledger, the valuation and the
  // ability to cancel are the ones already built and tested.
  const entry = await createStockEntry(db, {
    entryType: 'adjustment',
    postingDate: head.postingDate,
    reference: head.docNo,
    notes: `Physical count ${head.docNo}`,
    actorId: input.actorId,
    now,
    lines: differences.map((l) => ({
      productId: l.productId,
      qty: l.change,
      // Goods found come back at what the shelf was worth when the sheet opened.
      // A count corrects a quantity; it is not a purchase and must not move the
      // average. Goods short are valued by the ledger itself on the way out.
      ...(l.change > 0 && l.unitCost ? { unitCost: l.unitCost } : {}),
    })),
  })
  if (!entry.ok) throw new Error(`the count could not be posted: ${entry.code}`)

  const submitted = await submitStockEntry(db, { entryId: entry.entryId, actorId: input.actorId, now })
  if (!submitted.ok) {
    // Thrown, not returned: the draft entry made above goes with it.
    throw new Refused({
      ok: false, code: 'WOULD_GO_NEGATIVE',
      productId: submitted.productId, available: submitted.available, change: submitted.change,
    })
  }

  await db.transaction(async (tx) => {
    await q(tx).update(schema.stockCounts)
      .set({
        docstatus: SUBMITTED,
        entryId: entry.entryId,
        updatedAt: nowIso,
        rev: sql`${schema.stockCounts.rev} + 1`,
      })
      .where(eq(schema.stockCounts.id, input.countId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: input.countId, action: 'submit',
      docstatusFrom: DRAFT, docstatusTo: SUBMITTED,
      after: { counted: lines.length, adjusted: differences.length, entry: submitted.docNo },
    })
  })

  return {
    ok: true,
    countId: input.countId,
    docNo: head.docNo,
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
  // As one, for the reason `submitCount` is: the entry's reversal and the
  // sheet's status must not be able to come apart.
  return db.transaction((tx) => cancelCountIn(tx, input))
}

async function cancelCountIn(
  db: SqlDriver,
  input: { countId: string; reason?: string; actorId: string; now?: Date },
): Promise<{ ok: true }> {
  const now = input.now ?? new Date()
  const [head] = await q(db)
    .select({ docstatus: schema.stockCounts.docstatus, entryId: schema.stockCounts.entryId })
    .from(schema.stockCounts)
    .where(and(eq(schema.stockCounts.id, input.countId), isNull(schema.stockCounts.deletedAt)))
  if (!head) throw new Error('no such count')

  const from = parseDocStatus(head.docstatus)
  if (from === SUBMITTED && head.entryId) {
    await cancelStockEntry(db, { entryId: head.entryId, actorId: input.actorId, now })
  }

  const nowIso = now.toISOString()
  await db.transaction(async (tx) => {
    if (from === DRAFT) {
      // A sheet nobody submitted is not history worth keeping.
      await q(tx).update(schema.stockCounts)
        .set({ deletedAt: nowIso, updatedAt: nowIso })
        .where(eq(schema.stockCounts.id, input.countId))
    } else {
      assertCanApply('stock count', from, 'cancel')
      await q(tx).update(schema.stockCounts)
        .set({ docstatus: CANCELLED, updatedAt: nowIso, rev: sql`${schema.stockCounts.rev} + 1` })
        .where(eq(schema.stockCounts.id, input.countId))
    }
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: input.countId, action: from === DRAFT ? 'delete' : 'cancel',
      docstatusFrom: from, docstatusTo: from === DRAFT ? DRAFT : CANCELLED,
      after: input.reason ? { reason: input.reason } : null,
    })
  })

  return { ok: true }
}
