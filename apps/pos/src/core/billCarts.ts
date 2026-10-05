import {
  Money, Quantity, Pricing, Totals,
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
   * The batch the cashier picked for this line, when batches are on. Kept on
   * screen only: a draft brought back after a restart has none, and the line
   * then comes out soonest expiry first, which is what it would have shown.
   */
  batchPick?: string | null
}

export interface Cart {
  tabId: string
  /** The draft row. Null until the tab has its first line. */
  billId: string | null
  lines: CartLine[]
  customer: CustomerListItem | null
  discount: string
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
    error: null,
    fromOrder: null,
    hydrating: false,
  }
}

export function snapshotOf(
  cart: Cart,
): { customerId: string | null; billDiscount: number; convertedFrom: string | null; lines: BillLineInput[] } {
  const lines = cart.lines.map((line): BillLineInput => ({
    productId: line.product.id,
    saleUnit: line.saleUnit,
    qty: Quantity.fromUnits(line.qty),
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
  const totals = Totals.computeTotals(
    cart.lines.map((l) => ({
      qty: Quantity.fromUnits(l.qty),
      rate: l.rate as never,
      taxRateBp: l.product.taxRateBp,
      rateIncludesTax: l.includesTax !== false,
      discountBlocked: l.product.discountBlocked,
    })),
    (Money.parseMoney(cart.discount) ?? 0) as never,
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
    lines,
    customer,
    discount: detail.billDiscount > 0 ? Money.format(detail.billDiscount) : '',
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
    })
  }

  return {
    cart: { ...emptyCart(), lines, customer, fromOrder: request.order ?? null },
    missing,
  }
}
