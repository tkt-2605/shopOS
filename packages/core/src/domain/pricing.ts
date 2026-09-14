import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'

/**
 * Price resolution, in strict order:
 *
 *   1. a rate negotiated with this customer for this product, which is itself
 *      a quantity ladder — the whole reason a shop negotiates with a regular
 *      is how much they take
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
  /**
   * The rate a quotation or a sales order promised.
   *
   * Never returned by the resolver — it is carried onto the bill by the
   * conversion, and it outranks everything the resolver would say. A quotation
   * is a promise the shop made, and honouring it is the entire point of having
   * quoted. `price_source_id` holds the document it came from.
   */
  | 'order_rate'

export interface PriceTier {
  id: string
  minQty: Qty
  rate: Money
  validFrom?: string | null
  validTo?: string | null
}

export interface PriceCandidates {
  /** Rates for this customer and this item alone. */
  customerTiers?: PriceTier[] | undefined
  customerListTiers?: PriceTier[] | undefined
  defaultListTiers?: PriceTier[] | undefined
  baseRate: Money
  /**
   * Whether the shop uses quantity breaks at all. Defaults to true, which is
   * what every caller meant before the switch existed.
   *
   * Off, a ladder does not merely stop being editable — it stops charging, or a
   * shop would turn quantity breaks off and go on being billed by them. The
   * rungs stay in the database untouched, and the first one is the price at any
   * quantity: what a shop with no breaks has said about this item on this list.
   */
  quantityBreaks?: boolean | undefined
}

export interface ResolvedPrice {
  rate: Money
  source: PriceSource
  sourceId: string | null
}

export function resolvePrice(candidates: PriceCandidates, quantity: Qty, on: Date = new Date()): ResolvedPrice {
  const asOf = on.toISOString()
  const breaks = candidates.quantityBreaks !== false
  const bestTier = breaks ? tierForQty : firstTier

  const forCustomer = bestTier(candidates.customerTiers, quantity, asOf)
  if (forCustomer) {
    return { rate: forCustomer.rate, source: 'customer_override', sourceId: forCustomer.id }
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
function tierForQty(tiers: PriceTier[] | undefined, quantity: Qty, asOf: string): PriceTier | null {
  if (!tiers || tiers.length === 0) return null

  let best: PriceTier | null = null
  for (const tier of tiers) {
    if (tier.minQty > quantity) continue
    if (!isValid(tier.validFrom, tier.validTo, asOf)) continue
    if (best === null || tier.minQty > best.minQty) best = tier
  }
  return best
}

/**
 * The lowest rung, whatever the quantity — the shop's ordinary price for this
 * item on this list, with the breaks above it ignored rather than deleted.
 */
function firstTier(tiers: PriceTier[] | undefined, _quantity: Qty, asOf: string): PriceTier | null {
  if (!tiers || tiers.length === 0) return null

  let first: PriceTier | null = null
  for (const tier of tiers) {
    if (!isValid(tier.validFrom, tier.validTo, asOf)) continue
    if (first === null || tier.minQty < first.minQty) first = tier
  }
  return first
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
    case 'order_rate':
      return 'Rate promised on the order'
  }
}
