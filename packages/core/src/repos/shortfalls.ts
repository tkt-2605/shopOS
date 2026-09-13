import type { SqlDriver } from '../db/driver.js'
import { type Qty, qty } from '../quantity.js'

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
  const rows = await db.query<{
    id: string; name: string; code: string | null; base_unit: string
    on_hand: number
    short_since: string | null
    sold_short: number | null
    last_counted: string | null
    last_received: string | null
  }>(
    /* `balance_qty` is stamped on every ledger row as it is written, so the day
       the count first went under is a lookup rather than a replay. */
    `SELECT p.id, p.name, p.code, p.base_unit,
            s.qty_on_hand AS on_hand,
            (SELECT MIN(sl.posting_date) FROM stock_ledger sl
              WHERE sl.product_id = p.id AND sl.balance_qty < 0)         AS short_since,
            (SELECT COALESCE(SUM(-sl.qty_change), 0) FROM stock_ledger sl
              WHERE sl.product_id = p.id AND sl.qty_change < 0 AND sl.balance_qty < 0) AS sold_short,
            (SELECT MAX(c.posting_date) FROM stock_count_items ci
               JOIN stock_counts c ON c.id = ci.count_id
              WHERE ci.product_id = p.id AND ci.counted_qty IS NOT NULL
                AND c.docstatus = 1)                                     AS last_counted,
            (SELECT MAX(sl.posting_date) FROM stock_ledger sl
              WHERE sl.product_id = p.id AND sl.qty_change > 0)          AS last_received
       FROM products p
       JOIN product_stock s ON s.product_id = p.id
      WHERE s.qty_on_hand < 0 AND p.is_stock_tracked = 1 AND p.deleted_at IS NULL
      ORDER BY s.qty_on_hand ASC`,
  )

  return {
    rows: rows.map((r) => ({
      productId: r.id,
      name: r.name,
      code: r.code,
      baseUnit: r.base_unit,
      onHand: qty(r.on_hand),
      shortSince: r.short_since,
      soldShort: qty(r.sold_short ?? 0),
      lastCountedOn: r.last_counted,
      lastReceivedOn: r.last_received,
    })),
    count: rows.length,
  }
}

/** Just the number, for a badge. One query rather than the whole list. */
export async function countShortfalls(db: SqlDriver): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM product_stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.qty_on_hand < 0 AND p.is_stock_tracked = 1 AND p.deleted_at IS NULL`,
  )
  return row?.n ?? 0
}
