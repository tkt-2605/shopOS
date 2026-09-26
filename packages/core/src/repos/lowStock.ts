import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Qty } from '../quantity.js'

export interface LowStockItem {
  name: string
  qty: Qty
  unit: string
}

/**
 * The items nearly gone from the shelf, fewest first.
 *
 * A glance, not a buying list: a fixed line in base units rather than each
 * item's own reorder level, which is `reorderList`'s job. Items the shop does
 * not count, archived ones and ones switched off are left out -- none of them
 * is something to go and look for on a shelf.
 *
 * An item with no stock row has never moved and reads as none on hand.
 */
export async function lowStock(
  db: SqlDriver,
  options: { below: Qty; limit?: number },
): Promise<LowStockItem[]> {
  const onHand = sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`
  return q(db)
    .select({ name: schema.products.name, qty: onHand, unit: schema.products.baseUnit })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(and(
      eq(schema.products.isActive, 1),
      isNull(schema.products.deletedAt),
      eq(schema.products.isStockTracked, 1),
      sql`${onHand} < ${options.below}`,
    ))
    .orderBy(onHand)
    .limit(options.limit ?? 12)
}
