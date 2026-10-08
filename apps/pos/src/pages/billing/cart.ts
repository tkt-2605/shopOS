import { Quantity, Totals } from '@shopos/core'
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

/** Each line's picked batch, by position as the bill stores it: the first line is 1. */
export function picksOf(lines: CartLine[]): Record<number, string> {
  const picks: Record<number, string> = {}
  lines.forEach((l, i) => { if (l.batchPick) picks[i + 1] = l.batchPick })
  return picks
}
