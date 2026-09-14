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
  /** What the lines add up to, before the rupee is tidied. */
  payable: Money
  /**
   * The paise added or dropped to reach a round figure. Signed: positive means
   * the customer pays it, negative means the shop gives it up.
   */
  roundOff: Money
  /** What is actually asked for, and what has to be paid to the paisa. */
  grandTotal: Money
}

/**
 * What happens to the last few paise.
 *
 * A percentage tax on a rate that is itself round almost never lands on a whole
 * rupee, so a bill of ₹99.60 is the normal case rather than the odd one. There
 * is no 60-paise coin, so a counter settles it one of three ways and the shop
 * should say which — silently keeping the 40 paise, or silently giving them
 * away, is the same decision made by nobody.
 *
 * `none` is the default and the honest one for a shop that takes card or UPI,
 * where the paise can actually be collected.
 *
 * Applied to the total and nowhere else. It does not touch a line, a taxable
 * value or a tax amount — an invoice whose tax figures moved to make the total
 * round would not reconcile against a return filed on those same figures, and
 * the round-off is shown as its own line for exactly that reason.
 */
export type Rounding = 'none' | 'nearest' | 'up' | 'down'

/** A rupee, in paise. What every rule here rounds to. */
const RUPEE = 100

/** The adjustment `rule` would make to `payable` — zero when it makes none. */
export function roundOffFor(payable: Money, rule: Rounding): Money {
  const rupees = payable / RUPEE
  switch (rule) {
    case 'none': return ZERO
    case 'nearest': return paise(Math.round(rupees) * RUPEE - payable)
    case 'up': return paise(Math.ceil(rupees) * RUPEE - payable)
    case 'down': return paise(Math.floor(rupees) * RUPEE - payable)
  }
}

export function grossOf(rate: Money, quantity: Qty): Money {
  return paise(Math.round((rate * quantity) / QTY_SCALE))
}

export function computeTotals(
  lines: TotalsLine[],
  billDiscount: Money = ZERO,
  supply: SupplyType = 'intra_state',
  rounding: Rounding = 'none',
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
  let payable: Money = ZERO

  const detailed = lineTotals.map((l, i): LineTotals => {
    const share = shares[i] ?? ZERO
    const net = sub(l.lineTotal, share)
    const tax = splitTax(net, lines[i]!.taxRateBp, supply)

    taxableTotal = add(taxableTotal, tax.taxableValue)
    taxTotal = add(taxTotal, tax.taxTotal)
    payable = add(payable, net)

    return { gross: l.gross, lineTotal: l.lineTotal, billDiscountShare: share, net, tax }
  })

  /* Last, on the total the lines add up to. The per-line figures are left
     exactly as they were, so `taxable + tax + round-off` is the total and the
     line rows still reconcile to the taxable value the return is filed on. */
  const roundOff = roundOffFor(payable, rounding)

  return {
    lines: detailed,
    subtotal, discountableSubtotal, discount, taxableTotal, taxTotal,
    payable, roundOff, grandTotal: add(payable, roundOff),
  }
}
