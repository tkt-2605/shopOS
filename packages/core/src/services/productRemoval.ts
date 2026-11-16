import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'

/**
 * Getting rid of several items at once.
 *
 * A shop that made its colours as separate items before variants existed, and
 * has now made them again as a family, has a page of items that should not be
 * there. One at a time is an afternoon.
 *
 * ── Deleted where nothing points at it, retired where something does ────
 *
 * An item that has been on a bill, a quotation, a return, a stock entry or a
 * count is in the shop's history, and the stock ledger, the margin report and
 * the return path all join to it (`products.ts` says why at length). Those
 * cannot be deleted. They are taken out of use instead -- off the counter and
 * the reorder list, still on every old bill -- which is the most a shop can
 * honestly do to them, and is said on the screen before anything happens.
 *
 * An item with none of that never existed as far as the books know. It is
 * deleted (`deleted_at`): gone from the list, the search, the scanner, the
 * export and the storefront, and its barcodes are free for another item. Its
 * own rows -- barcodes, units, prices -- go with it. They sync like any edit.
 *
 * ── Families ─────────────────────────────────────────────────────────────
 *
 * A variant points at its family. A family is deleted only if every variant it
 * has goes in the same step; if they are all going but some only to retired,
 * the family is retired with them. A family keeping a variant the person did
 * not choose stays as it is, and the plan says so -- deleting it would leave
 * variants pointing at nothing.
 */

/** What would happen to one chosen item. */
export type RemovalAction = 'delete' | 'retire' | 'keep'

export type RemovalReason =
  /** On a bill, document, return, stock entry, count or batch: it is history. */
  | 'HAS_HISTORY'
  /** A family with variants that were not chosen. */
  | 'HAS_VARIANTS'
  /** Already out of use, and with history: there is nothing more to do. */
  | 'ALREADY_RETIRED'

export interface RemovalRow {
  productId: string
  name: string
  action: RemovalAction
  reason: RemovalReason | null
}

export interface RemovalPlan {
  rows: RemovalRow[]
  delete: number
  retire: number
  keep: number
}

/* Every table that records something having happened to an item. The rest
   that point at a product -- barcodes, units, prices, photos, the stock
   cache -- belong to it and go with it. `productRemoval.test.ts` holds this
   list to the schema, so a new table that names a product has to be sorted
   into one or the other. */
export const HISTORY_TABLES = [
  'bill_items', 'document_items', 'sales_return_items', 'stock_entry_items',
  'stock_ledger', 'stock_count_items', 'batches', 'batch_movements',
] as const
export const OWNED_TABLES = [
  'product_barcodes', 'product_units', 'item_prices', 'customer_item_prices', 'product_photos', 'product_stock',
] as const

/** Which of `ids` appear in any history table. */
async function withHistory(db: SqlDriver, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const marks = ids.map(() => '?').join(', ')
  // raw: one UNION over eight tables, named from a list, which the builder cannot spell as one statement
  const rows = await db.query<{ productId: string }>(
    HISTORY_TABLES.map((t) => `SELECT DISTINCT product_id AS productId FROM ${t} WHERE product_id IN (${marks})`).join(' UNION '),
    HISTORY_TABLES.flatMap(() => ids),
  )
  return new Set(rows.map((r) => r.productId))
}

/**
 * What removing `productIds` would do, item by item. Writes nothing: the
 * screen shows this, and the person decides.
 */
export async function planRemoval(db: SqlDriver, productIds: readonly string[]): Promise<RemovalPlan> {
  const chosen = [...new Set(productIds)]
  if (chosen.length === 0) return { rows: [], delete: 0, retire: 0, keep: 0 }

  const items = await q(db)
    .select({
      id: schema.products.id, name: schema.products.name,
      isActive: schema.products.isActive, parentProductId: schema.products.parentProductId,
    })
    .from(schema.products)
    .where(and(inArray(schema.products.id, chosen), isNull(schema.products.deletedAt)))
  const ids = items.map((p) => p.id)

  // Every live variant of any chosen item, chosen or not: a family is judged by all of them.
  const variants = ids.length === 0 ? [] : await q(db)
    .select({ id: schema.products.id, parentProductId: schema.products.parentProductId })
    .from(schema.products)
    .where(and(inArray(schema.products.parentProductId, ids), isNull(schema.products.deletedAt)))

  const history = await withHistory(db, ids)
  const picked = new Set(ids)
  const action = new Map<string, { action: RemovalAction; reason: RemovalReason | null }>()

  const own = (p: (typeof items)[number]) => history.has(p.id)
    ? (p.isActive === 1 ? { action: 'retire' as const, reason: 'HAS_HISTORY' as const } : { action: 'keep' as const, reason: 'ALREADY_RETIRED' as const })
    : { action: 'delete' as const, reason: null }

  // Variants and plain items first: a family's fate follows its variants'.
  for (const p of items) if (!variants.some((v) => v.parentProductId === p.id)) action.set(p.id, own(p))

  for (const p of items) {
    const mine = variants.filter((v) => v.parentProductId === p.id)
    if (mine.length === 0) continue
    if (mine.some((v) => !picked.has(v.id))) { action.set(p.id, { action: 'keep', reason: 'HAS_VARIANTS' }); continue }
    const allDeleted = mine.every((v) => action.get(v.id)?.action === 'delete')
    const self = own(p)
    action.set(p.id, allDeleted ? self : self.action === 'delete'
      // Its variants stay as history, so the family stays too, out of use with them.
      ? (p.isActive === 1 ? { action: 'retire', reason: 'HAS_HISTORY' } : { action: 'keep', reason: 'ALREADY_RETIRED' })
      : self)
  }

  const rows = items.map((p) => ({ productId: p.id, name: p.name, ...action.get(p.id)! }))
  return {
    rows,
    delete: rows.filter((r) => r.action === 'delete').length,
    retire: rows.filter((r) => r.action === 'retire').length,
    keep: rows.filter((r) => r.action === 'keep').length,
  }
}

export interface ProductRemovalResult { deleted: number; retired: number; kept: number }

/**
 * Carries out `planRemoval` for the same items, in one transaction. The plan
 * is made again inside it, so a bill rung on another till between the screen
 * and the click turns that item's delete into a retire rather than a hole.
 */
export async function removeProducts(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productIds: readonly string[],
): Promise<ProductRemovalResult> {
  await requirePermission(db, ctx.actorId, 'product', 'delete')
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    const plan = await planRemoval(tx, productIds)
    const gone = plan.rows.filter((r) => r.action === 'delete').map((r) => r.productId)
    const retired = plan.rows.filter((r) => r.action === 'retire')

    if (gone.length > 0) {
      // `rev` on products is the trigger's (019), as for any edit of an item.
      await q(tx).update(schema.products)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(schema.products.id, gone))
      /* Its codes, free for another item: a scan must not find a deleted one.
         Taken off as an edit, the way `setBarcodes` takes one off (056). */
      await q(tx).update(schema.productBarcodes)
        .set({ deletedAt: now })
        .where(and(inArray(schema.productBarcodes.productId, gone), isNull(schema.productBarcodes.deletedAt)))
      await q(tx).update(schema.productUnits)
        .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.productUnits.rev} + 1` })
        .where(and(inArray(schema.productUnits.productId, gone), isNull(schema.productUnits.deletedAt)))
      await q(tx).update(schema.itemPrices)
        .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.itemPrices.rev} + 1` })
        .where(and(inArray(schema.itemPrices.productId, gone), isNull(schema.itemPrices.deletedAt)))
      await q(tx).update(schema.customerItemPrices)
        .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.customerItemPrices.rev} + 1` })
        .where(and(inArray(schema.customerItemPrices.productId, gone), isNull(schema.customerItemPrices.deletedAt)))
      for (const row of plan.rows.filter((r) => r.action === 'delete')) {
        await writeAudit(tx, ctx, { entity: 'products', entityId: row.productId, action: 'delete', before: { name: row.name } })
      }
    }

    for (const row of retired) {
      await q(tx).update(schema.products)
        .set({ isActive: 0, updatedAt: now })
        .where(eq(schema.products.id, row.productId))
      await writeAudit(tx, ctx, {
        entity: 'products', entityId: row.productId, action: 'update',
        before: { 'Sold here': 'yes' }, after: { 'Sold here': 'retired' },
      })
    }

    return { deleted: gone.length, retired: retired.length, kept: plan.keep }
  })
}
