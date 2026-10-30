import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Money, paise } from '../money.js'
import type { Qty } from '../quantity.js'
import { DRAFT } from '../integrity/docstatus.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'

/**
 * An item put on a sheet that is already open: one added to the catalogue
 * after the counting began, or one the sheet left off. It comes in at what the
 * system believes now, which is the moment it joined the sheet -- the same
 * freezing `openCount` does for every other line, only later.
 */

export type AddToCountResult =
  | { ok: true; productId: string; expectedQty: Qty }
  | { ok: false; code: 'NO_SUCH_COUNT' | 'NOT_OPEN' | 'UNKNOWN_PRODUCT' | 'NOT_COUNTABLE' | 'ALREADY_ON_SHEET' }

export async function addToCount(
  db: SqlDriver,
  input: { countId: string; productId: string; actorId: string },
): Promise<AddToCountResult> {
  await requirePermission(db, input.actorId, 'stock_entry', 'submit')

  return db.transaction(async (tx) => {
    const [head] = await q(tx)
      .select({ docstatus: schema.stockCounts.docstatus })
      .from(schema.stockCounts)
      .where(and(eq(schema.stockCounts.id, input.countId), isNull(schema.stockCounts.deletedAt)))
    if (!head) return { ok: false, code: 'NO_SUCH_COUNT' }
    if (head.docstatus !== DRAFT) return { ok: false, code: 'NOT_OPEN' }

    const [item] = await q(tx)
      .select({
        isActive: schema.products.isActive,
        isStockTracked: schema.products.isStockTracked,
        qtyOnHand: sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
        stockValue: sql<Money>`COALESCE(${schema.productStock.stockValue}, 0)`,
      })
      .from(schema.products)
      .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
      .where(and(eq(schema.products.id, input.productId), isNull(schema.products.deletedAt)))
    if (!item) return { ok: false, code: 'UNKNOWN_PRODUCT' }
    // The same items `openCount` would have put on: a retired item or a service has no shelf.
    if (item.isActive !== 1 || item.isStockTracked !== 1) return { ok: false, code: 'NOT_COUNTABLE' }

    const [there] = await q(tx)
      .select({ id: schema.stockCountItems.id })
      .from(schema.stockCountItems)
      .where(and(
        eq(schema.stockCountItems.countId, input.countId),
        eq(schema.stockCountItems.productId, input.productId),
      ))
    if (there) return { ok: false, code: 'ALREADY_ON_SHEET' }

    await q(tx).insert(schema.stockCountItems).values({
      id: newId(),
      countId: input.countId,
      productId: input.productId,
      expectedQty: item.qtyOnHand,
      countedQty: null,
      unitCost: item.qtyOnHand > 0 && item.stockValue > 0
        ? paise(Math.round((item.stockValue * 10_000) / item.qtyOnHand))
        : null,
    })
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'stock_counts', entityId: input.countId, action: 'update',
      after: { added: input.productId, expected_qty: item.qtyOnHand },
    })
    return { ok: true, productId: input.productId, expectedQty: item.qtyOnHand }
  })
}
