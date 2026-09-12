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
  /** The discount actually applied, which is never more than the subtotal. */
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
    return { gross, lineTotal: sub(gross, line.discount ?? ZERO) }
  })

  const subtotal = add(...lineTotals.map((l) => l.lineTotal))

  // Clamped rather than rejected, because this function is also what the screen
  // renders while the cashier is still typing a discount.
  const discount = paise(Math.min(Math.max(0, billDiscount), subtotal))

  // Spread across lines so tax is charged on what was actually paid, and so the
  // per-line figures still sum to the invoice total.
  const shares = discount > 0
    ? allocate(discount, lineTotals.map((l) => l.lineTotal))
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

  return { lines: detailed, subtotal, discount, taxableTotal, taxTotal, grandTotal }
}
