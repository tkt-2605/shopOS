import { type Money, ZERO, paise, add, sub, allocate } from '../money.js'
import { type Qty, QTY_SCALE } from '../quantity.js'
import { splitTax, type SupplyType, type TaxBreakdown } from './tax.js'

/**
 * What a bill adds up to.
 *
 * This exists to be the only answer. The billing screen used to compute the
 * subtotal, the discount allocation and the tax itself, and the service computed
 * them again on the way to the database — two implementations of the same
 * arithmetic, of which only one was the record. When they disagreed, the customer
 * had already been shown the wrong number.
 */

export interface TotalsLine {
  qty: Qty
  rate: Money
  /** Taken off this line before any share of the bill-level discount. */
  discount?: Money
  taxRateBp: number
  /**
   * The line sells on too thin a margin to carry a discount.
   *
   * It is excluded from the bill-level discount rather than merely refused one
   * of its own — a 10% off the whole bill that quietly lands on the recharge
   * voucher is the same loss by another route.
   */
  discountBlocked?: boolean
}

export interface LineTotals {
  gross: Money
  /** Gross less this line's own discount. */
  lineTotal: Money
  /** This line's share of the bill-level discount. */
  billDiscountShare: Money
  /** What the customer actually pays for the line, tax included. */
  net: Money
  tax: TaxBreakdown
}

export interface ComputedTotals {
  lines: LineTotals[]
  subtotal: Money
  /** The part of the subtotal a bill-level discount may be spread across. */
  discountableSubtotal: Money
  /** The discount actually applied, which is never more than the discountable part. */
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  grandTotal: Money
}

export function grossOf(rate: Money, quantity: Qty): Money {
  return paise(Math.round((rate * quantity) / QTY_SCALE))
}

export function computeTotals(
  lines: TotalsLine[],
  billDiscount: Money = ZERO,
  supply: SupplyType = 'intra_state',
): ComputedTotals {
  const lineTotals = lines.map((line) => {
    const gross = grossOf(line.rate, line.qty)
    // A blocked line carries no discount of its own either. The service rejects
    // one outright; here it is dropped, because this is also what the screen
    // renders and a number shown but not charged is worse than no number.
    const own = line.discountBlocked ? ZERO : (line.discount ?? ZERO)
    return { gross, lineTotal: sub(gross, own) }
  })

  const subtotal = add(...lineTotals.map((l) => l.lineTotal))

  // What a bill-level discount is allowed to land on. A bill of nothing but
  // blocked items has none, and then no discount can be applied at all.
  const weights = lineTotals.map((l, i) => (lines[i]!.discountBlocked ? ZERO : l.lineTotal))
  const discountableSubtotal = add(...weights)

  // Clamped rather than rejected, because this function is also what the screen
  // renders while the cashier is still typing a discount.
  const discount = paise(Math.min(Math.max(0, billDiscount), discountableSubtotal))

  // Spread across the lines that may carry it, so tax is charged on what was
  // actually paid and the per-line figures still sum to the invoice total.
  const shares = discount > 0
    ? allocate(discount, weights)
    : lineTotals.map(() => ZERO)

  let taxableTotal: Money = ZERO
  let taxTotal: Money = ZERO
  let grandTotal: Money = ZERO

  const detailed = lineTotals.map((l, i): LineTotals => {
    const share = shares[i] ?? ZERO
    const net = sub(l.lineTotal, share)
    const tax = splitTax(net, lines[i]!.taxRateBp, supply)

    taxableTotal = add(taxableTotal, tax.taxableValue)
    taxTotal = add(taxTotal, tax.taxTotal)
    grandTotal = add(grandTotal, net)

    return { gross: l.gross, lineTotal: l.lineTotal, billDiscountShare: share, net, tax }
  })

  return { lines: detailed, subtotal, discountableSubtotal, discount, taxableTotal, taxTotal, grandTotal }
}
