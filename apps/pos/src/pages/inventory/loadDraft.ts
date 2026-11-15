import {
  Money, Quantity, Tax, listBarcodes, listUnits, costHint, unitPrices,
  type CostHint, type Ladder, type ProductListItem, type SqlDriver,
} from '@shopos/core'
import { breakRows } from './breaks'
import { unitDrafts } from './unitPrices'
import type { Draft } from './draft'

/**
 * An item as its page edits it: the row it was listed as, with its barcodes,
 * units, box prices and quantity breaks read alongside. Moved out of the
 * Inventory page unchanged when the item became a page of its own.
 */
export async function loadDraft(
  db: SqlDriver, p: ProductListItem, ladder: readonly Ladder.Rung[],
): Promise<{ draft: Draft; lastCost: CostHint | null }> {
  const [codes, units, cost, priced] = await Promise.all([
    listBarcodes(db, p.id), listUnits(db, p.id), costHint(db, p.id), unitPrices(db, p.id),
  ])
  return {
    // Only a price actually paid: the item's own cost price is already in the box.
    lastCost: cost !== null && cost.source !== 'item' ? cost : null,
    draft: {
      id: p.id, name: p.name, brand: p.brand ?? '',
      barcodes: codes.length > 0
        ? codes.map((c) => ({ barcode: c.barcode, label: c.label ?? '' }))
        : [{ barcode: '', label: '' }],
      units: unitDrafts(units, priced),
      ladder: breakRows([...ladder]),
      categoryId: p.categoryId ?? '',
      parentProductId: p.parentProductId ?? '',
      variantLabel: p.variantLabel ?? '',
      hsnCode: p.hsnCode ?? '', taxPercent: String(Tax.bpToPercent(p.taxRateBp)),
      cessPercent: p.cessRateBp === 0 ? '' : String(Tax.bpToPercent(p.cessRateBp)),
      noGst: p.taxRateBp === 0 && p.cessRateBp === 0,
      baseRate: Money.format(p.baseRate), rateSide: 'with', mrp: p.mrp === null ? '' : Money.format(p.mrp),
      costPrice: p.costPrice === null ? '' : Money.format(p.costPrice), costSide: 'before',
      baseUnit: p.baseUnit,
      discountBlocked: p.discountBlocked, loyaltyBlocked: p.loyaltyBlocked,
      returnBlocked: p.returnBlocked, stockTracked: p.isStockTracked, openPrice: p.openPrice,
      reorderLevel: p.reorderLevel === null ? '' : Quantity.formatQty(p.reorderLevel),
      reorderQty: p.reorderQty === null ? '' : Quantity.formatQty(p.reorderQty),
    },
  }
}
