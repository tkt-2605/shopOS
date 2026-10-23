import { CostFloor, Quantity, Totals, type UnderCost } from '@shopos/core'
import type { CartLine } from '../../core/useBillTabs'

/*
 * What the counter works out from the cart before anything is saved: the lines
 * as the totals engine wants them, and which of them the shelf cannot cover.
 */

/** The one mapping from cart lines to what the totals engine wants. */
/**
 * The cart as the totals see it.
 *
 * `taxed` is whether this shop charges tax at all. A composition or an
 * unregistered shop charges none, which the service applies by zeroing the
 * rates; the screen has to do the same, or a rate quoted before tax would show
 * a total with tax added that the bill will not carry.
 */
export function totalsLinesOf(lines: CartLine[], taxed = true): Totals.TotalsLine[] {
  return lines.map((l) => ({
    qty: Quantity.fromUnits(l.qty),
    rate: l.rate as never,
    taxRateBp: taxed ? l.product.taxRateBp : 0,
    cessRateBp: taxed ? l.product.cessRateBp : 0,
    rateIncludesTax: l.includesTax !== false,
    discountBlocked: l.product.discountBlocked,
  }))
}

/** An item the cart wants more of than the shelf holds, in base units. */
export interface ShortLine {
  name: string
  unit: string
  want: number
  have: number
}

/**
 * Lines being sold off a shelf that does not have them.
 *
 * Read off the snapshot the search returned rather than asked of the database
 * on every keystroke: this is a warning, and the authoritative check still
 * happens inside `submitBill` where it belongs. Several lines of the same item
 * are added together, because two lines of three pens is six pens.
 */
export function shortOf(lines: CartLine[]): Map<string, ShortLine> {
  const wanted = new Map<string, ShortLine>()
  for (const line of lines) {
    if (!line.product.isStockTracked) continue
    const factor = line.units.find((u) => u.saleUnit === line.saleUnit)?.baseUnits
    const base = line.qty * Quantity.toUnits(factor ?? Quantity.fromUnits(1))
    const at = wanted.get(line.product.id)
    if (at) at.want += base
    else {
      wanted.set(line.product.id, {
        name: line.product.name,
        unit: line.product.baseUnit,
        want: base,
        have: Quantity.toUnits(line.product.qtyOnHand),
      })
    }
  }
  for (const [id, w] of wanted) if (w.want <= w.have) wanted.delete(id)
  return wanted
}

/**
 * Lines that would sell below cost as the bill stands now, after their share
 * of the discount: said while the discount is being typed, so it is not first
 * heard about at Pay. A warning; `submitBill` refuses for real, and asks the
 * one person who may go ahead (`services/belowCost.ts`).
 *
 * `taxable` is each line's value before GST from the screen's own totals, in
 * line order; `floors` the cost per base unit, from `costFloors`.
 */
export function underCostOf(
  lines: CartLine[], taxable: readonly number[], floors: ReadonlyMap<string, number>,
): UnderCost[] {
  const under: UnderCost[] = []
  lines.forEach((line, i) => {
    const cost = floors.get(line.product.id)
    const factor = line.units.find((u) => u.saleUnit === line.saleUnit)?.baseUnits ?? Quantity.fromUnits(1)
    const baseQty = Math.round(Quantity.fromUnits(line.qty) * factor / Quantity.QTY_SCALE)
    const sellsAt = CostFloor.soldPerBase((taxable[i] ?? 0) as never, baseQty as never)
    if (cost === undefined || sellsAt === null || sellsAt <= 0 || sellsAt >= cost) return
    under.push({ productId: line.product.id, name: line.product.name, sellsAt, cost: cost as never })
  })
  return under
}

/** Each line's picked batch, by position as the bill stores it: the first line is 1. */
export function picksOf(lines: CartLine[]): Record<number, string> {
  const picks: Record<number, string> = {}
  lines.forEach((l, i) => { if (l.batchPick) picks[i + 1] = l.batchPick })
  return picks
}

/**
 * The MRP for one of the line's sale units: the box's own when it is printed
 * on it and the shop uses box prices (`saleUnitsFor` only carries it then),
 * else the batch's the cashier chose or the item's, per base unit -- so a box
 * of 12 shows twelve times the piece's. Null where the packet has none.
 */
export function mrpOf(line: CartLine): number | null {
  const unit = line.units.find((u) => u.saleUnit === line.saleUnit)
  if (unit?.mrp != null) return unit.mrp
  const perBase = line.batchMrp ?? line.product.mrp
  if (perBase == null) return null
  const factor = unit?.baseUnits ?? Quantity.fromUnits(1)
  return Math.round((perBase * factor) / Quantity.QTY_SCALE)
}

/** Whether the line is charged more than its MRP, which the law does not allow. A before-tax rate is not compared. */
export function aboveMrp(line: CartLine): boolean {
  const mrp = mrpOf(line)
  return mrp !== null && line.includesTax !== false && line.rate > mrp
}
