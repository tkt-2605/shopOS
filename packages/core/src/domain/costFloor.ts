import { type Money, paise } from '../money.js'
import { QTY_SCALE, type Qty } from '../quantity.js'
import { splitTax } from './tax.js'

/*
 * Whether a price is below what the goods cost, as two numbers that can be
 * compared: both per base unit, both on the same side of GST.
 *
 * The shop sells at a price that may have GST in it and buys at a cost quoted
 * before GST. A shop that claims its input tax back pays the cost before GST
 * and keeps the GST it charges for the government, so the two to compare are
 * the price without its GST and the cost before GST. A shop that cannot claim
 * (composition, unregistered) charges no GST and pays the supplier's: its
 * price is all its own, and its cost has the supplier's GST in it.
 *
 * Pure: the figures come from the caller (`services/belowCost.ts`).
 */

/**
 * What a price comes to per base unit, without the GST it carries.
 *
 * `rate` is for one `saleUnit` holding `baseUnits` (a box of 12 is 12 ×
 * QTY_SCALE). `charges` is whether this shop puts GST on what it sells at all.
 */
export function netPerBase(input: {
  rate: Money
  includesTax: boolean
  taxRateBp: number
  cessRateBp: number
  baseUnits: Qty
  charges: boolean
}): Money {
  const net = input.includesTax && input.charges
    ? splitTax(input.rate, input.taxRateBp, 'intra_state', input.cessRateBp).taxableValue
    : input.rate
  return input.baseUnits > 0 ? paise(Math.round((net * QTY_SCALE) / input.baseUnits)) : net
}

/** What a line actually sold for per base unit: its taxable value, after every discount, over what left the shelf. */
export function soldPerBase(taxableValue: Money, baseQty: Qty): Money | null {
  return baseQty > 0 ? paise(Math.round((taxableValue * QTY_SCALE) / baseQty)) : null
}

/**
 * The least one base unit may sell for: its cost before GST, and the GST paid
 * on it too where the shop cannot claim that back.
 */
export function floorOf(unitCost: Money, taxPerUnit: Money, claimable: boolean): Money {
  return claimable ? unitCost : paise(unitCost + taxPerUnit)
}
