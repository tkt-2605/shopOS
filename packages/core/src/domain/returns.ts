import { type Money, ZERO, paise, sub, min as minMoney } from '../money.js'

/**
 * What a shop actually hands back.
 *
 * A return is not one number. The goods have a value — that is what the credit
 * note reverses for GST, and it is fixed by what was charged. But a bill is not
 * always settled in one currency, and the shop owes back what it took, in the
 * proportions it took it.
 *
 * A customer settles ₹1,000 with ₹900 in cash and 100 points' worth of points,
 * and brings back half the goods. Refunding ₹500 in cash would hand them ₹50
 * they never paid. Refunding ₹500 in cash *and* returning the points would hand
 * them ₹100 they never paid. So the refund is split the way the bill was:
 * ₹450 and 50 points' worth of points.
 *
 * Two rules keep successive partial returns honest, both by working in
 * cumulative terms and subtracting what has already been given back:
 *
 *   - the last return on a bill hands back exactly the remainder, so a rounded
 *     half never leaves a rupee stranded;
 *   - nothing can be given back twice.
 */

export interface RefundBasis {
  /** What the bill came to. */
  billTotal: Money
  /** The money the bill's points covered. Zero when none were spent. */
  pointsValue: Money
  /** The points that covered it. */
  pointsRedeemed: number
  /** Points the bill earned, as they stand now. */
  pointsEarned: number
  /** Of those, how many the customer has since spent. Those are gone. */
  pointsEarnedSpent: number
  /** Goods value already returned on this bill, before this return. */
  alreadyRefunded: Money
  /** Of that, how much was given back as points rather than money. */
  alreadyRestoredValue: Money
  /** Earned points already taken back by earlier returns. */
  alreadyRemovedPoints: number
}

export interface RefundSplit {
  /** The value of the goods. Unchanged by how it is paid back. */
  refundTotal: Money
  /** What leaves the drawer, or goes onto the khata. */
  cash: Money
  /** Points handed back because the customer paid with them. */
  pointsRestored: number
  /** What those points are worth, at the rate the original bill used. */
  restoredValue: Money
  /** Points taken off because the sale that earned them is undone. */
  pointsRemoved: number
}

export function splitRefund(refundTotal: Money, basis: RefundBasis): RefundSplit {
  const nothing: RefundSplit = {
    refundTotal, cash: refundTotal, pointsRestored: 0, restoredValue: ZERO, pointsRemoved: 0,
  }
  if (basis.billTotal <= 0 || refundTotal <= 0) return { ...nothing, cash: paise(Math.max(0, refundTotal)) }

  const cumulative = paise(Math.min(basis.alreadyRefunded + refundTotal, basis.billTotal))

  // The share of the whole bill that points covered, applied to everything
  // returned so far, less what has already gone back that way.
  const restoredValue = basis.pointsValue > 0
    ? paise(Math.max(0, share(basis.pointsValue, cumulative, basis.billTotal) - basis.alreadyRestoredValue))
    : ZERO

  const cash = minMoney(sub(refundTotal, restoredValue), refundTotal)

  // Points follow their own value, at the rate this bill used them at, so the
  // last return gives back the last point rather than losing it to rounding.
  const pointsRestored = basis.pointsValue > 0
    ? Math.max(0, Math.min(
        basis.pointsRedeemed,
        Math.round((basis.pointsRedeemed * (basis.alreadyRestoredValue + restoredValue)) / basis.pointsValue),
      ) - Math.round((basis.pointsRedeemed * basis.alreadyRestoredValue) / basis.pointsValue))
    : 0

  // Points the sale earned come back off, but never below what the customer has
  // already spent — those are gone, and a negative balance is worse than a shop
  // absorbing the difference.
  const removable = Math.max(0, basis.pointsEarned - basis.pointsEarnedSpent)
  const cumulativeRemoved = Math.min(
    removable + basis.alreadyRemovedPoints,
    Math.round((basis.pointsEarned + basis.alreadyRemovedPoints) * ratio(cumulative, basis.billTotal)),
  )
  const pointsRemoved = Math.max(0, Math.min(removable, cumulativeRemoved - basis.alreadyRemovedPoints))

  return { refundTotal, cash: paise(Math.max(0, cash)), pointsRestored, restoredValue, pointsRemoved }
}

function share(amount: Money, part: Money, whole: Money): Money {
  return paise(Math.round((amount * part) / whole))
}

function ratio(part: Money, whole: Money): number {
  return whole <= 0 ? 0 : part / whole
}

/** One line for a person: what they get, in the currencies they get it in. */
export function describeRefund(split: RefundSplit, rupees: (m: Money) => string): string {
  const parts: string[] = []
  if (split.cash > 0) parts.push(rupees(split.cash))
  if (split.pointsRestored > 0) parts.push(`${split.pointsRestored} points`)
  return parts.length === 0 ? 'nothing' : parts.join(' and ')
}
