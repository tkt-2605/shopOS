import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'

/**
 * Price resolution, in strict order:
 *
 *   1. a rate negotiated with this customer for this product
 *   2. the customer's assigned price list, best matching quantity tier
 *   3. the default price list, best matching quantity tier
 *   4. the product's own base rate
 *
 * The resolved price carries the rule that produced it. A cashier is asked "why
 * is it this price?" constantly, and the answer cannot be reconstructed after the
 * fact once tiers and lists have moved on — so it is recorded on the bill line.
 */

export type PriceSource =
  | 'customer_override'
  | 'customer_list'
  | 'default_list'
  | 'base_rate'
  /** A cashier typed the rate. Recorded so an unusual price is traceable to a person. */
  | 'manual_override'

export interface PriceTier {
  id: string
  minQty: Qty
  rate: Money
  validFrom?: string | null
  validTo?: string | null
}

export interface CustomerOverride {
  id: string
  rate: Money
  validFrom?: string | null
  validTo?: string | null
}

export interface PriceCandidates {
  customerOverride?: CustomerOverride | null | undefined
  customerListTiers?: PriceTier[] | undefined
  defaultListTiers?: PriceTier[] | undefined
  baseRate: Money
}

export interface ResolvedPrice {
  rate: Money
  source: PriceSource
  sourceId: string | null
}

export function resolvePrice(candidates: PriceCandidates, quantity: Qty, on: Date = new Date()): ResolvedPrice {
  const asOf = on.toISOString()

  const override = candidates.customerOverride
  if (override && isValid(override.validFrom, override.validTo, asOf)) {
    return { rate: override.rate, source: 'customer_override', sourceId: override.id }
  }

  const fromCustomerList = bestTier(candidates.customerListTiers, quantity, asOf)
  if (fromCustomerList) {
    return { rate: fromCustomerList.rate, source: 'customer_list', sourceId: fromCustomerList.id }
  }

  const fromDefaultList = bestTier(candidates.defaultListTiers, quantity, asOf)
  if (fromDefaultList) {
    return { rate: fromDefaultList.rate, source: 'default_list', sourceId: fromDefaultList.id }
  }

  return { rate: candidates.baseRate, source: 'base_rate', sourceId: null }
}

/**
 * Highest `minQty` the quantity reaches. Tiers are inclusive at the break point:
 * a tier at minQty 10 applies to exactly 10.
 */
function bestTier(tiers: PriceTier[] | undefined, quantity: Qty, asOf: string): PriceTier | null {
  if (!tiers || tiers.length === 0) return null

  let best: PriceTier | null = null
  for (const tier of tiers) {
    if (tier.minQty > quantity) continue
    if (!isValid(tier.validFrom, tier.validTo, asOf)) continue
    if (best === null || tier.minQty > best.minQty) best = tier
  }
  return best
}

function isValid(from: string | null | undefined, to: string | null | undefined, asOf: string): boolean {
  if (from && asOf < from) return false
  if (to && asOf > to) return false
  return true
}

export function describeSource(source: PriceSource): string {
  switch (source) {
    case 'customer_override':
      return 'Customer-specific rate'
    case 'customer_list':
      return "Customer's price list"
    case 'default_list':
      return 'Default price list'
    case 'base_rate':
      return 'Product base price'
    case 'manual_override':
      return 'Entered by cashier'
  }
}
