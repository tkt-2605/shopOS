import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'

/**
 * What an item costs the shop, for somebody about to type a cost: on Stock In,
 * on a purchase order, on the item itself.
 *
 * Two candidates, and the more recent wins: the last price actually paid,
 * from the most recent submitted purchase or opening-stock entry, and the cost
 * price typed on the item (074), by when it was set (075). A cost price typed
 * after the last delivery is what the owner now means; a delivery after it is
 * newer news. A cost price of unknown age loses to any price paid. Both are
 * per base unit and before tax, which is how a supplier quotes and how
 * `stock_entry_items.unit_cost` is kept.
 *
 * A suggestion for a person and never a valuation: stock is valued from what
 * each movement carried (`domain/valuation.ts`), and nothing that posts reads
 * this. That is the line the cost price must not cross.
 */
export interface CostHint {
  productId: string
  unitCost: Money
  /** Where the figure came from: a delivery, opening stock, or the item's own cost price. */
  source: 'purchase' | 'opening' | 'item'
  /** The entry's date, for a delivery or opening stock. Null for the item's own cost price. */
  postedOn: string | null
  /** Who supplied it, when a delivery recorded a supplier. */
  supplierName: string | null
}

/** The cost to suggest for each of these items, where there is one. An item with neither is left out. */
export async function costHints(db: SqlDriver, productIds: readonly string[]): Promise<Map<string, CostHint>> {
  const hints = new Map<string, CostHint>()
  if (productIds.length === 0) return hints
  const ids = [...new Set(productIds)]
  const marks = ids.map(() => '?').join(', ')

  /* raw: a window function in a derived table, the last purchase of each item
     in one pass -- the same shape `reorder.ts` uses, and written out for the
     same reason: a builder has no words for `ROW_NUMBER() OVER`. Opening stock
     counts as bought: it is what the owner said the goods cost. A line posted
     with no cost (a zero) is passed over rather than suggested. */
  const rows = await db.query<{
    // Null across the board for an item never bought in: the join found nothing.
    product_id: string; unit_cost: number | null; posting_date: string | null
    entry_type: 'purchase' | 'opening' | null; supplier_name: string | null; entered_at: string | null
    cost_price: number | null; cost_price_at: string | null
  }>(
    `SELECT p.id AS product_id, p.cost_price, p.cost_price_at,
            last_buy.unit_cost, last_buy.posting_date, last_buy.entry_type, last_buy.supplier_name,
            last_buy.created_at AS entered_at
       FROM products p
       LEFT JOIN (
         SELECT sei.product_id, sei.unit_cost, se.posting_date, se.entry_type, se.supplier_name, se.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY sei.product_id ORDER BY se.posting_date DESC, se.created_at DESC
                ) AS rn
           FROM stock_entry_items sei
           JOIN stock_entries se ON se.id = sei.entry_id
          WHERE se.entry_type IN ('purchase', 'opening') AND se.docstatus = 1
            AND sei.qty > 0 AND sei.unit_cost > 0
            AND sei.product_id IN (${marks})
       ) last_buy ON last_buy.product_id = p.id AND last_buy.rn = 1
      WHERE p.id IN (${marks})`,
    [...ids, ...ids],
  )

  for (const r of rows) {
    const paid = r.unit_cost !== null && r.posting_date !== null && r.entry_type !== null
    /* Instants, both ISO and both UTC, so they compare as strings. When the
       delivery was entered, not its posting date: a bill typed in today for
       last week is still the newest thing anyone has said about the cost. */
    const typedSince = r.cost_price !== null && r.cost_price_at !== null
      && (r.entered_at === null || r.cost_price_at > r.entered_at)
    if (paid && !typedSince) {
      hints.set(r.product_id, {
        productId: r.product_id,
        unitCost: r.unit_cost as Money,
        source: r.entry_type as 'purchase' | 'opening',
        postedOn: r.posting_date,
        supplierName: r.supplier_name,
      })
    } else if (r.cost_price !== null) {
      hints.set(r.product_id, {
        productId: r.product_id, unitCost: r.cost_price as Money, source: 'item', postedOn: null, supplierName: null,
      })
    }
  }
  return hints
}

/** The same, for one item. */
export async function costHint(db: SqlDriver, productId: string): Promise<CostHint | null> {
  return (await costHints(db, [productId])).get(productId) ?? null
}
