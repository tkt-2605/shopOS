import {
  Batches, Money, Quantity, Pricing, Totals,
  productsByIds, saleUnitsFor, searchCustomers,
  pricingContextFor, resolveLinePrice,
  type SqlDriver, type DraftDetail, type BillLineInput,
  type ProductListItem, type CustomerListItem, type SaleUnitOption,
} from '@shopos/core'
import type { RepeatRequest } from './repeat'

/**
 * What one bill tab holds, and the three ways one comes to exist: empty, rebuilt
 * from a draft the database kept, or built from an old bill or an order.
 *
 * Apart from `useBillTabs` because none of it is React. The hook owns when a
 * cart is saved and which one is showing; this owns what a cart is.
 */

export interface CartLine {
  key: string
  product: ProductListItem
  saleUnit: string
  units: SaleUnitOption[]
  /** Display units, not scaled. */
  qty: number
  rate: number
  source: Pricing.PriceSource
  sourceId: string | null
  manual: boolean
  /**
   * Whether `rate` has the tax in it. Absent is yes, which is every cart saved
   * before 063. Taken from wherever the rate came from and kept with it -- a
   * wholesale list's rate stays a before-tax rate if the cashier retypes it.
   */
  includesTax?: boolean
  /**
   * The batch the cashier picked for this line -- from the line when batches
   * are on, or by choosing a price when the shelf holds the item at more than
   * one (070). Saved with the draft and priced from: a batch with a price of
   * its own sets the line's rate and MRP. `Batches.UNBATCHED_PICK` is the
   * stock received before the new price, at the item's own.
   */
  batchPick?: string | null
  /** The MRP of the price the cashier chose, shown on the line. */
  batchMrp?: number | null
  /**
   * The unit, quantity and customer `rate` was worked out for (`pricedForOf`).
   * A line whose rate the shop's rules set is priced again when any of the
   * three changes -- see `repriceCart`. Kept on screen only.
   */
  pricedFor?: string
}

export interface Cart {
  tabId: string
  /** The draft row. Null until the tab has its first line. */
  billId: string | null
  lines: CartLine[]
  customer: CustomerListItem | null
  /** The bill discount as typed: rupees, or a percentage when `discountPercent` (`discountAmount`). */
  discount: string
  discountPercent: boolean
  error: string | null
  /**
   * The order this cart is billing, if it came from one. Saved with the draft,
   * so a counter that lost power comes back still knowing — and marked off by
   * `submitBill` when the money is taken, never before.
   */
  fromOrder: { id: string; docNo: string } | null
  /** True while being rebuilt from a draft; autosave must not run. */
  hydrating: boolean
}

export const MAX_TABS = 6

let seq = 0
const nextTabId = () => `tab-${++seq}`

export function emptyCart(): Cart {
  return {
    tabId: nextTabId(),
    billId: null,
    lines: [],
    customer: null,
    discount: '',
    discountPercent: false,
    error: null,
    fromOrder: null,
    hydrating: false,
  }
}

/**
 * The bill discount as an amount. In rupees as typed, or a percentage of the
 * part of the bill that may be discounted -- `discountable`, the subtotal less
 * the items that take no discount -- so 10% off is 10% of what can come off,
 * not of a figure the bill can never reach. Anything that is not an amount, or
 * a percentage past 100, is nothing and all of it respectively.
 */
export function discountAmount(cart: Pick<Cart, 'discount' | 'discountPercent'>, discountable: number): number {
  const typed = cart.discount.trim()
  if (!cart.discountPercent) return Money.parseMoney(typed) ?? 0
  const percent = Number(typed)
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.round((discountable * Math.min(percent, 100)) / 100)
}

/**
 * Whether the shop's rules set this line's rate. A rate the cashier typed and
 * a rate an order promised stay as they are, whatever is done to the line.
 */
export function followsPriceRules(line: CartLine): boolean {
  return !line.manual && line.source !== 'order_rate'
}

/** What a line's rate depends on besides the item, as one comparable thing. */
export function pricedForOf(
  line: Pick<CartLine, 'saleUnit' | 'qty' | 'batchPick'>, customerId: string | null,
): string {
  return `${line.saleUnit}\u0000${line.qty}\u0000${customerId ?? ''}\u0000${line.batchPick ?? ''}`
}

/** The batch a line is priced from, as the pricing wants it: none for the stock without one. */
export function pricingBatch(line: Pick<CartLine, 'batchPick'>): string | null {
  return line.batchPick && line.batchPick !== Batches.UNBATCHED_PICK ? line.batchPick : null
}

/** Lines whose rate was worked out for a unit, quantity or customer they no longer have. */
export function linesToReprice(cart: Cart): CartLine[] {
  const customer = cart.customer?.id ?? null
  return cart.lines.filter((l) => followsPriceRules(l) && l.pricedFor !== pricedForOf(l, customer))
}

/**
 * Prices again every line that has changed under its rate, and returns the
 * change to make to the cart.
 *
 * A line was priced once, as it went in -- one of its default unit -- and kept
 * that rate whatever was done to it after. Switched to a box of fifty, it was
 * charged one piece's price for fifty; typed up to ten, it never reached the
 * ten-or-more rate; and a customer chosen after the items kept the shop's
 * prices rather than theirs. `submitBill` takes the rate on screen as already
 * resolved, so the bill charged what the screen said.
 *
 * The change applies a rate only to a line still as it was when priced, so a
 * cashier who goes on typing while this runs is never handed a rate for a
 * quantity the line no longer has; that line is priced again on the next pass.
 */
export async function repriceCart(db: SqlDriver, cart: Cart): Promise<(cart: Cart) => Cart> {
  const stale = linesToReprice(cart)
  if (stale.length === 0) return (c) => c
  const customer = cart.customer?.id ?? null
  const context = await pricingContextFor(db, customer)

  const priced = new Map<string, { as: string } & Awaited<ReturnType<typeof resolveLinePrice>>>()
  for (const line of stale) {
    const resolved = await resolveLinePrice(db, context, {
      productId: line.product.id,
      saleUnit: line.saleUnit,
      qty: Quantity.fromUnits(line.qty),
      batchId: pricingBatch(line),
    })
    priced.set(line.key, { ...resolved, as: pricedForOf(line, customer) })
  }

  return (c) => {
    if (c.tabId !== cart.tabId) return c
    const now = c.customer?.id ?? null
    let changed = false
    const lines = c.lines.map((l) => {
      const p = priced.get(l.key)
      if (!p || !followsPriceRules(l) || pricedForOf(l, now) !== p.as) return l
      changed = true
      return {
        ...l, rate: p.rate, source: p.source, sourceId: p.sourceId, includesTax: p.includesTax, pricedFor: p.as,
      }
    })
    return changed ? { ...c, lines } : c
  }
}

export function snapshotOf(
  cart: Cart,
): { customerId: string | null; billDiscount: number; convertedFrom: string | null; lines: BillLineInput[] } {
  const lines = cart.lines.map((line): BillLineInput => ({
    productId: line.product.id,
    saleUnit: line.saleUnit,
    qty: Quantity.fromUnits(line.qty),
    ...(pricingBatch(line) ? { batchId: pricingBatch(line) } : {}),
    // A typed rate is the cashier's; anything else is passed back as already
    // resolved so a held bill is not re-priced behind the customer.
    ...(line.manual
      ? { rateOverride: line.rate as never, rateIncludesTax: line.includesTax !== false }
      : {
          resolved: {
            rate: line.rate as never, source: line.source, sourceId: line.sourceId,
            includesTax: line.includesTax !== false,
          },
        }),
  }))

  // The clamped figure, not the typed one. The service rejects a discount larger
  // than the part of the bill that may carry it, and a rejected autosave is
  // invisible — the cashier would go on billing against a draft that stopped
  // saving. The screen shows the clamp; this sends what the screen shows.
  const forTotals = cart.lines.map((l) => ({
    qty: Quantity.fromUnits(l.qty),
    rate: l.rate as never,
    taxRateBp: l.product.taxRateBp,
    rateIncludesTax: l.includesTax !== false,
    discountBlocked: l.product.discountBlocked,
  }))
  const discountable = Totals.computeTotals(forTotals, 0 as never).discountableSubtotal
  const totals = Totals.computeTotals(
    forTotals,
    discountAmount(cart, discountable) as never,
    // No rounding rule: the only figure taken from here is the clamped
    // discount, which the last few paise of the total cannot change.
  )

  return {
    customerId: cart.customer?.id ?? null,
    billDiscount: totals.discount,
    convertedFrom: cart.fromOrder?.id ?? null,
    lines,
  }
}

/** What autosave writes for one cart. */
export type CartSnapshot = ReturnType<typeof snapshotOf>

/** Rebuilds a cart from a saved draft. */
export async function cartFromDraft(db: SqlDriver, detail: DraftDetail): Promise<Cart> {
  const products = await productsByIds(db, detail.lines.map((l) => l.productId))
  const byId = new Map(products.map((p) => [p.id, p]))

  const lines: CartLine[] = []
  for (const [i, saved] of detail.lines.entries()) {
    const product = byId.get(saved.productId)
    if (!product) continue
    lines.push({
      key: `${saved.productId}-${i}-${Date.now()}`,
      product,
      saleUnit: saved.saleUnit,
      units: await saleUnitsFor(db, saved.productId),
      qty: Quantity.toUnits(saved.qty),
      rate: saved.rate,
      source: saved.priceSource,
      sourceId: saved.priceSourceId,
      manual: saved.priceSource === 'manual_override',
      includesTax: saved.rateIncludesTax,
      batchPick: saved.batchId,
    })
  }

  let customer: CustomerListItem | null = null
  if (detail.customerId) {
    const found = await searchCustomers(db, detail.customerName ?? '')
    customer = found.find((c) => c.id === detail.customerId) ?? null
  }

  const cart: Cart = {
    tabId: nextTabId(),
    billId: detail.billId,
    /* Priced for what each line is now, so a held bill keeps the rates it was
       held at until somebody changes a line. */
    lines: lines.map((l) => ({ ...l, pricedFor: pricedForOf(l, customer?.id ?? null) })),
    customer,
    // Held as the amount it came to: a percentage is a way of typing one.
    discount: detail.billDiscount > 0 ? Money.format(detail.billDiscount) : '',
    discountPercent: false,
    error: null,
    fromOrder: detail.fromOrder,
    hydrating: false,
  }
  return cart
}

/**
 * Builds a tab from an old bill.
 *
 * Priced today, not as it was priced then. What the customer bought is a fact
 * about the past; what it costs is a fact about now, and a March rate quietly
 * reappearing on a September bill is the kind of thing nobody notices until
 * the month's margin is short.
 *
 * An item that has since been removed from the catalogue is dropped and said
 * out loud, rather than making a tab that is silently short a line.
 */
export async function cartFromRepeat(
  db: SqlDriver, request: RepeatRequest,
): Promise<{ cart: Cart; missing: number }> {
  const products = await productsByIds(db, request.lines.map((l) => l.productId))
  const byId = new Map(products.map((p) => [p.id, p]))

  let customer: CustomerListItem | null = null
  if (request.customerId) {
    const found = await searchCustomers(db)
    customer = found.find((c) => c.id === request.customerId) ?? null
  }

  const pricing = await pricingContextFor(db, customer?.id ?? null)
  const lines: CartLine[] = []
  let missing = 0

  for (const [i, wanted] of request.lines.entries()) {
    const product = byId.get(wanted.productId)
    if (!product) { missing += 1; continue }

    const units = await saleUnitsFor(db, product.id)
    // The unit it was sold in, if the shop still sells in it.
    const unit = units.find((u) => u.saleUnit === wanted.saleUnit)?.saleUnit
      ?? units.find((u) => u.isDefault)?.saleUnit
      ?? product.baseUnit

    /* An order arrives with its rate and keeps it; anything else is priced
       at today's. The line is not marked manual either way — nobody at this
       counter typed it, and calling it a cashier's override would put an
       unusual price against the wrong person's name. */
    const priced = wanted.rate != null && request.order
      ? {
          rate: wanted.rate, source: 'order_rate' as Pricing.PriceSource, sourceId: request.order.id,
          includesTax: wanted.includesTax !== false,
        }
      : await resolveLinePrice(db, pricing, {
        productId: product.id,
        saleUnit: unit,
        qty: Quantity.fromUnits(wanted.qty),
      })

    lines.push({
      key: `${product.id}-repeat-${i}-${Date.now()}`,
      product,
      saleUnit: unit,
      units,
      qty: wanted.qty,
      rate: priced.rate,
      source: priced.source,
      sourceId: priced.sourceId,
      manual: false,
      includesTax: priced.includesTax,
      pricedFor: pricedForOf({ saleUnit: unit, qty: wanted.qty }, customer?.id ?? null),
    })
  }

  return {
    cart: { ...emptyCart(), lines, customer, fromOrder: request.order ?? null },
    missing,
  }
}
