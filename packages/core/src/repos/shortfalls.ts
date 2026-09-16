import { eq, and, lt, asc, isNull, count, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { type Qty, qty, QTY_ZERO } from '../quantity.js'

/**
 * Counts that need fixing.
 *
 * A shop that can sell below its count will, and the only thing that makes that
 * safe is being able to find the items again afterwards. Without this screen the
 * quantity goes negative, nobody looks, and the number stays wrong for ever —
 * which is worse than the refusal it replaced, because at least a refusal was
 * noticed.
 *
 * Negative stock is not by itself a theft or a mistake. It is one of three
 * things, and the shop is the only one that can say which: the opening count was
 * wrong, a delivery was never entered, or goods really have walked. The page
 * shows what is needed to tell them apart — how far below zero, when it went
 * there, and what has happened to the item since — and does not guess.
 */

export interface Shortfall {
  productId: string
  name: string
  code: string | null
  baseUnit: string
  /** Below zero, so always negative. */
  onHand: Qty
  /** When the count first went below zero, as far as the ledger shows. */
  shortSince: string | null
  /** Sales made against nothing, which is the size of the question. */
  soldShort: Qty
  lastCountedOn: string | null
  lastReceivedOn: string | null
}

export interface ShortfallSummary {
  rows: Shortfall[]
  /** How many items are below zero, for a badge on the nav. */
  count: number
}

export async function listShortfalls(db: SqlDriver): Promise<ShortfallSummary> {
  /* The five dates and totals are correlated subqueries against the ledger,
     marked raw and written with `products.id` in full: a bare `id` inside them
     would bind to `stock_ledger`. They stay subqueries rather than becoming
     five more joins, which would multiply the rows against each other and give
     the wrong sum for `sold_short`.

     `balance_qty` is stamped on every ledger row as it is written, so the day
     the count first went under is a lookup rather than a replay. */
  const rows = await q(db)
    .select({
      id: schema.products.id,
      name: schema.products.name,
      code: schema.products.code,
      baseUnit: schema.products.baseUnit,
      onHand: schema.productStock.qtyOnHand,
      shortSince: sql<string | null>`(SELECT MIN(sl.posting_date) FROM stock_ledger sl
        WHERE sl.product_id = products.id AND sl.balance_qty < 0)`,
      soldShort: sql<Qty>`(SELECT COALESCE(SUM(-sl.qty_change), 0) FROM stock_ledger sl
        WHERE sl.product_id = products.id AND sl.qty_change < 0 AND sl.balance_qty < 0)`,
      lastSold: sql<string | null>`(SELECT MAX(sl.posting_date) FROM stock_ledger sl
        WHERE sl.product_id = products.id AND sl.qty_change < 0)`,
      lastCounted: sql<string | null>`(SELECT MAX(c.posting_date) FROM stock_count_items ci
        JOIN stock_counts c ON c.id = ci.count_id
        WHERE ci.product_id = products.id AND ci.counted_qty IS NOT NULL AND c.docstatus = 1)`,
      lastReceived: sql<string | null>`(SELECT MAX(sl.posting_date) FROM stock_ledger sl
        WHERE sl.product_id = products.id AND sl.qty_change > 0)`,
    })
    .from(schema.products)
    .innerJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(and(
      lt(schema.productStock.qtyOnHand, QTY_ZERO),
      eq(schema.products.isStockTracked, 1),
      isNull(schema.products.deletedAt),
    ))
    .orderBy(asc(schema.productStock.qtyOnHand))

  return {
    rows: rows.map((r) => ({
      productId: r.id,
      name: r.name,
      code: r.code,
      baseUnit: r.baseUnit,
      onHand: r.onHand,
      /* `balance_qty` is each till's own running total at the moment it wrote
         the row, and two tills that have merged never shared one. Two counters
         each holding the last unit and each selling it are both at zero and
         neither is wrong on its own — the shop is one short only once the
         ledgers are put together, and no single row ever recorded going under.

         So when the stamped balances say nothing and the shelf is nevertheless
         below zero, the shortfall itself is what was sold short, and the day it
         happened is the day of the last sale. Both are inferred rather than
         read, and saying nothing at all would be worse: this is precisely the
         case a second till creates, and it is the one a shop most needs named. */
      shortSince: r.shortSince ?? r.lastSold,
      soldShort: qty(r.soldShort === null || r.soldShort === 0
        ? -r.onHand
        : r.soldShort),
      lastCountedOn: r.lastCounted,
      lastReceivedOn: r.lastReceived,
    })),
    count: rows.length,
  }
}

/** Just the number, for a badge. One query rather than the whole list. */
export async function countShortfalls(db: SqlDriver): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.productStock)
    .innerJoin(schema.products, eq(schema.products.id, schema.productStock.productId))
    .where(and(
      lt(schema.productStock.qtyOnHand, QTY_ZERO),
      eq(schema.products.isStockTracked, 1),
      isNull(schema.products.deletedAt),
    ))
  return row?.n ?? 0
}
