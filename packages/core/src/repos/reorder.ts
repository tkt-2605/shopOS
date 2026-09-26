import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { type Qty, qty, subQty, QTY_ZERO } from '../quantity.js'
import { addDays, businessDate } from '../dates.js'

/**
 * What to buy.
 *
 * A buying list is only useful if it is decidable at the counter: the shopkeeper
 * has the distributor on the phone and needs to know, per line, whether to order
 * and how much. So each row carries not just "below the line" but what it has
 * been selling, who it was last bought from and at what price — the three things
 * that turn a number into a decision.
 *
 * Only items with a reorder level set appear here. That is deliberate: a list
 * derived from every product a shop has ever sold is a wall of noise nobody
 * reads twice, while a list the owner built by marking their fast lines is one
 * they trust.
 */

export interface ReorderRow {
  productId: string
  name: string
  code: string | null
  baseUnit: string
  onHand: Qty
  reorderLevel: Qty
  /** What to order: the fixed quantity if one is set, else the level itself. */
  suggestedQty: Qty
  /** Units sold in the window, so a dead line is not reordered out of habit. */
  soldRecently: Qty
  /** Days of cover left at that rate of sale, or null when nothing is selling. */
  daysOfCover: number | null
  lastSupplierId: string | null
  lastSupplierName: string | null
  lastPurchaseRate: Money | null
  lastPurchasedOn: string | null
}

export interface ReorderOptions {
  /** How far back to look at sales. A month is what a weekly order is judged on. */
  windowDays?: number
  now?: Date
  /** Include items already at or below zero even without a level set: they are
   *  out of stock whatever the owner has configured. */
  includeOutOfStock?: boolean
}

export async function reorderList(db: SqlDriver, options: ReorderOptions = {}): Promise<ReorderRow[]> {
  const now = options.now ?? new Date()
  const windowDays = options.windowDays ?? 30
  const from = addDays(businessDate(now), -windowDays)

  const trigger = options.includeOutOfStock
    ? `(p.reorder_level IS NOT NULL AND COALESCE(s.qty_on_hand, 0) <= p.reorder_level
        OR COALESCE(s.qty_on_hand, 0) <= 0)`
    : `p.reorder_level IS NOT NULL AND COALESCE(s.qty_on_hand, 0) <= p.reorder_level`

  /* raw: a window function in a derived table. `ROW_NUMBER() OVER (PARTITION
     BY …)` is how the last purchase of each item is found in one pass, and it
     is the case the spec names as staying written out -- a builder has no
     words for it, and doing it another way means either a correlated subquery
     per row or reading every purchase into memory. The rest of the statement
     stays here with it: splitting the half a builder can express away from the
     half it cannot would put the two out of sight of each other. */
  const rows = await db.query<{
    id: string; name: string; code: string | null; base_unit: string
    on_hand: number; reorder_level: number | null; reorder_qty: number | null
    sold: number | null
    last_supplier_id: string | null; last_supplier_name: string | null
    last_rate: number | null; last_on: string | null
  }>(
    `SELECT p.id, p.name, p.code, p.base_unit,
            COALESCE(s.qty_on_hand, 0) AS on_hand,
            p.reorder_level, p.reorder_qty,
            -- Base units, not sale units: an item sold by the box leaves the
            -- shelf in pieces, and what came back is not a sale.
            (SELECT SUM(CAST(ROUND(bi.base_qty * (bi.qty - bi.returned_qty) * 1.0 / bi.qty) AS INTEGER))
               FROM bill_items bi
               JOIN bills b ON b.id = bi.bill_id
              WHERE bi.product_id = p.id AND b.docstatus = 1 AND b.posting_date >= ?) AS sold,
            last_buy.supplier_id   AS last_supplier_id,
            last_buy.supplier_name AS last_supplier_name,
            last_buy.unit_cost     AS last_rate,
            last_buy.posting_date  AS last_on
       FROM products p
       LEFT JOIN product_stock s ON s.product_id = p.id
       LEFT JOIN (
         SELECT sei.product_id, se.supplier_id, se.supplier_name, sei.unit_cost, se.posting_date,
                ROW_NUMBER() OVER (PARTITION BY sei.product_id ORDER BY se.posting_date DESC, se.created_at DESC) AS rn
           FROM stock_entry_items sei
           JOIN stock_entries se ON se.id = sei.entry_id
          WHERE se.entry_type = 'purchase' AND se.docstatus = 1
       ) last_buy ON last_buy.product_id = p.id AND last_buy.rn = 1
      WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.is_stock_tracked = 1
        AND (${trigger})
      ORDER BY last_buy.supplier_name, p.name`,
    [from],
  )

  return rows.map((r) => {
    const onHand = qty(r.on_hand)
    const level = qty(r.reorder_level ?? 0)
    const sold = qty(r.sold ?? 0)
    return {
      productId: r.id,
      name: r.name,
      code: r.code,
      baseUnit: r.base_unit,
      onHand,
      reorderLevel: level,
      suggestedQty: suggest(onHand, level, r.reorder_qty),
      soldRecently: sold,
      daysOfCover: coverDays(onHand, sold, windowDays),
      lastSupplierId: r.last_supplier_id,
      lastSupplierName: r.last_supplier_name,
      lastPurchaseRate: r.last_rate === null ? null : (r.last_rate as Money),
      lastPurchasedOn: r.last_on,
    }
  })
}

/**
 * The fixed order quantity when the owner has set one — a distributor sells
 * thermal rolls in tens whatever the shop would have preferred — and otherwise
 * the reorder level itself, topped up by whatever the shelf is short by if it
 * has gone negative.
 */
function suggest(onHand: Qty, level: Qty, fixed: number | null): Qty {
  if (fixed !== null && fixed > 0) return qty(fixed)
  if (onHand < 0) return subQty(level, onHand)
  return level > 0 ? level : QTY_ZERO
}

/** At the rate it has been selling, how long what is left will last. */
function coverDays(onHand: Qty, sold: Qty, windowDays: number): number | null {
  if (sold <= 0 || onHand <= 0) return null
  const perDay = sold / windowDays
  return Math.round(onHand / perDay)
}

/**
 * The same list grouped the way an order is actually placed: one call per
 * distributor, and a last line for what has never been bought from anyone.
 */
export interface SupplierGroup {
  supplierId: string | null
  supplierName: string | null
  rows: ReorderRow[]
}

export function bySupplier(rows: ReorderRow[]): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>()
  for (const row of rows) {
    const key = row.lastSupplierId ?? ''
    let group = groups.get(key)
    if (!group) {
      group = { supplierId: row.lastSupplierId, supplierName: row.lastSupplierName, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  // Named suppliers first, then the never-bought-before tail.
  return [...groups.values()].sort((a, b) => {
    if (a.supplierId === null) return 1
    if (b.supplierId === null) return -1
    return (a.supplierName ?? '').localeCompare(b.supplierName ?? '')
  })
}
