import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { QTY_SCALE } from '../quantity.js'
import { addTax } from '../domain/tax.js'

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
  /**
   * The GST and cess paid on one unit at that cost: off the supplier's bill
   * for a delivery, nothing for opening stock, and the item's own rates on its
   * cost price. Only a shop that cannot claim input tax counts it as cost
   * (`domain/costFloor.ts`).
   */
  taxPerUnit: Money
}

const HINT_SLICE = 400

/** The cost to suggest for each of these items, where there is one. An item with neither is left out. */
export async function costHints(db: SqlDriver, productIds: readonly string[]): Promise<Map<string, CostHint>> {
  const hints = new Map<string, CostHint>()
  if (productIds.length === 0) return hints
  const ids = [...new Set(productIds)]
  // Every id is bound twice: in slices, so a whole catalogue stays under SQLite's 999.
  if (ids.length > HINT_SLICE) {
    for (let i = 0; i < ids.length; i += HINT_SLICE) {
      for (const [id, hint] of await costHints(db, ids.slice(i, i + HINT_SLICE))) hints.set(id, hint)
    }
    return hints
  }
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
    tax_rate_bp: number; cess_rate_bp: number; line_tax: number | null; line_qty: number | null
  }>(
    `SELECT p.id AS product_id, p.cost_price, p.cost_price_at, p.tax_rate_bp, p.cess_rate_bp,
            last_buy.line_tax, last_buy.qty AS line_qty,
            last_buy.unit_cost, last_buy.posting_date, last_buy.entry_type, last_buy.supplier_name,
            last_buy.created_at AS entered_at
       FROM products p
       LEFT JOIN (
         SELECT sei.product_id, sei.unit_cost, se.posting_date, se.entry_type, se.supplier_name, se.created_at,
                sei.qty, sei.cgst_amount + sei.sgst_amount + sei.igst_amount + sei.cess_amount AS line_tax,
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
        taxPerUnit: (r.line_qty && r.line_tax ? Math.round((r.line_tax * QTY_SCALE) / r.line_qty) : 0) as Money,
      })
    } else if (r.cost_price !== null) {
      hints.set(r.product_id, {
        productId: r.product_id, unitCost: r.cost_price as Money, source: 'item', postedOn: null, supplierName: null,
        taxPerUnit: addTax(r.cost_price as Money, r.tax_rate_bp, 'intra_state', r.cess_rate_bp).taxTotal,
      })
    }
  }
  return hints
}

/** The same, for one item. */
export async function costHint(db: SqlDriver, productId: string): Promise<CostHint | null> {
  return (await costHints(db, [productId])).get(productId) ?? null
}
