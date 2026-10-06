import { eq, and, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { businessDate } from '../../dates.js'
import { type Money, ZERO, sub } from '../../money.js'
import { type Qty, qty, QTY_SCALE } from '../../quantity.js'
import type { PriceSource } from '../../domain/pricing.js'
import { computeTotals, grossOf, type ComputedTotals } from '../../domain/billTotals.js'
import type { SupplyType } from '../../domain/tax.js'
import { resolveSaleUnit, pricingContextFor, resolveLinePrice } from '../../repos/pricing.js'
import { loadRounding, loadTaxScheme } from '../features.js'
import { chargesTax } from '../../domain/taxScheme.js'
import { openSessionFor } from '../cash.js'
import { requirePermission } from '../../integrity/permissions.js'
import { billingCustomer, supplyFor } from './load.js'
import type { CreateBillInput, CreateBillResult } from './types.js'

/*
 * The lines of a bill, priced and taxed against today's lists and the
 * customer's own rates, before anything is written.
 */

export interface ComputedLine {
  productId: string
  productName: string
  hsnCode: string | null
  saleUnit: string
  qty: Qty
  baseQty: Qty
  rate: Money
  mrp: Money | null
  discount: Money
  taxRateBp: number
  cessRateBp: number
  /** Whether `rate` was quoted with the tax in it (063). */
  rateIncludesTax: boolean
  priceSource: PriceSource
  priceSourceId: string | null
  /** Copied onto the line as it stood at the time of sale, so a bill stays explainable. */
  discountBlocked: boolean
  loyaltyBlocked: boolean
}

/**
 * Whether this save types a rate nobody had typed before.
 *
 * A typed rate is a price decision, so it takes `price_list.write` -- the right
 * the counter already asks before it shows the box. But a held bill sends its
 * typed rates back on every autosave, so a cashier resuming a bill a manager
 * priced would be refused for a decision they did not make. An override already
 * saved on this draft, for the same item at the same rate, is the manager's and
 * goes through; only a new or changed one asks.
 */
async function overridesNeedingRight(db: SqlDriver, input: CreateBillInput, draftId?: string): Promise<boolean> {
  const typed = input.lines.filter((l) => l.rateOverride != null)
  if (typed.length === 0) return false
  if (!draftId) return true
  const saved = await q(db)
    .select({ productId: schema.billItems.productId, rate: schema.billItems.rate })
    .from(schema.billItems)
    .where(and(eq(schema.billItems.billId, draftId), eq(schema.billItems.priceSource, 'manual_override')))
  const known = new Set(saved.map((s) => `${s.productId}:${s.rate}`))
  return typed.some((l) => !known.has(`${l.productId}:${l.rateOverride}`))
}

/** Where a rate comes from when nobody decided it for this bill: the shop's own prices. */
const BY_THE_RULES: ReadonlySet<PriceSource> = new Set<PriceSource>([
  'base_rate', 'default_list', 'customer_list', 'customer_override',
])

const lineKey = (productId: string, saleUnit: string, quantity: number, rate: number, includesTax: boolean) =>
  `${productId}\u0000${saleUnit}\u0000${quantity}\u0000${rate}\u0000${includesTax ? 1 : 0}`

/**
 * The lines this draft already holds, as they are. A held bill sends its
 * lines back on every save, and one priced at yesterday's list keeps
 * yesterday's rate until somebody changes it -- the customer was quoted it.
 */
async function heldAsTheyAre(db: SqlDriver, draftId?: string): Promise<Set<string>> {
  if (!draftId) return new Set()
  const rows = await q(db)
    .select({
      productId: schema.billItems.productId, saleUnit: schema.billItems.saleUnit, qty: schema.billItems.qty,
      rate: schema.billItems.rate, includesTax: schema.billItems.rateIncludesTax,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, draftId))
  return new Set(rows.map((r) => lineKey(r.productId, r.saleUnit, r.qty, r.rate, r.includesTax === 1)))
}

/**
 * Everything a bill needs worked out, and nothing written. Both the first save and
 * every later one go through here, so a held bill cannot drift away from a fresh
 * one — prices, units and tax are resolved by the same code either way.
 */
type Priced =
  | { ok: true; computed: ComputedLine[]; totals: ComputedTotals; meta: DraftMeta; subtotal: Money }
  | Exclude<CreateBillResult, { ok: true }>

interface DraftMeta {
  sessionId: string | null
  customerId: string | null
  customerName: string | null
  postingDate: string
  placeOfSupply: string | null
  billDiscount: Money
  notes: string | null
  supply: SupplyType
  now: Date
}

export async function priceBill(
  db: SqlDriver,
  input: CreateBillInput,
  /** The draft being saved again, when it is one. See `overridesNeedingRight`. */
  draftId?: string,
): Promise<Priced> {
  if (input.lines.length === 0) return { ok: false, code: 'NO_LINES' }

  if (await overridesNeedingRight(db, input, draftId)) {
    await requirePermission(db, input.actorId, 'price_list', 'write')
  }

  const now = input.now ?? new Date()
  const postingDate = input.postingDate ?? businessDate(now)

  const sessionId = input.sessionId ?? (await openSessionFor(db, input.registerId))
  const customer = input.customerId ? await billingCustomer(db, input.customerId) : null
  const supply = await supplyFor(db, customer?.stateCode ?? null)

  /* A composition dealer may not collect tax on supplies at all (Section 10,
     Rule 49) and an unregistered shop has none to collect. Until now this
     product charged CGST and SGST on every line whatever the shop was, and
     handed the customer a document headed "Tax Invoice" to prove it.

     The rate is zeroed on the *line*, not on the product: the product's rate is
     a fact about the goods and has to survive the day the shop registers,
     whereas `bill_items.tax_rate_bp` is what this bill charged -- which was
     nothing. Everything downstream then follows without knowing the scheme
     exists: `splitTax` at 0 makes the taxable value the line total, the GST
     export reports a 0% row, and a return reverses nothing. */
  const taxed = chargesTax(await loadTaxScheme(db))
  const pricing = await pricingContextFor(db, input.customerId ?? null)
  const held = input.carriesRates ? new Set<string>() : await heldAsTheyAre(db, draftId)

  const computed: ComputedLine[] = []
  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, code: 'INVALID_QTY', productId: line.productId }

    const [product] = await q(db)
      .select({
        id: schema.products.id,
        name: schema.products.name,
        hsnCode: schema.products.hsnCode,
        taxRateBp: schema.products.taxRateBp,
        cessRateBp: schema.products.cessRateBp,
        mrp: schema.products.mrp,
        discountBlocked: schema.products.discountBlocked,
        loyaltyBlocked: schema.products.loyaltyBlocked,
      })
      .from(schema.products)
      .where(and(eq(schema.products.id, line.productId), isNull(schema.products.deletedAt)))
    if (!product) return { ok: false, code: 'UNKNOWN_PRODUCT', productId: line.productId }

    const discountBlocked = product.discountBlocked === 1
    const loyaltyBlocked = product.loyaltyBlocked === 1

    const unit = await resolveSaleUnit(db, line.productId, line.saleUnit ?? null)

    // A typed rate wins, then a rate already resolved for this line, and only a
    // line with neither is priced from scratch.
    const priced = line.rateOverride != null
      ? {
          rate: line.rateOverride, source: 'manual_override' as PriceSource, sourceId: null,
          includesTax: line.rateIncludesTax ?? true,
        }
      : line.resolved
        ? { ...line.resolved, includesTax: line.resolved.includesTax ?? true }
        : await resolveLinePrice(db, pricing, { productId: line.productId, saleUnit: unit.saleUnit, qty: line.qty }, now)

    /* A rate the caller says came from the shop's prices is held to them. The
       counter works rates out itself and sends them as already resolved, so a
       screen that priced a line for what it no longer was -- one piece's
       price on a box of fifty, until 0.2.3 -- charged it, and nothing here
       noticed. A line this draft already holds unchanged carries over (a held
       bill keeps its quote); an amendment says it carries its original's. */
    if (line.rateOverride == null && line.resolved && BY_THE_RULES.has(line.resolved.source) && !input.carriesRates
        && !held.has(lineKey(line.productId, unit.saleUnit, line.qty, priced.rate, priced.includesTax))) {
      const rule = await resolveLinePrice(
        db, pricing, { productId: line.productId, saleUnit: unit.saleUnit, qty: line.qty }, now)
      if (rule.rate !== priced.rate || rule.includesTax !== priced.includesTax) {
        return {
          ok: false, code: 'RATE_NOT_THE_RULE',
          productId: product.id, productName: product.name, rate: priced.rate, rule: rule.rate,
        }
      }
    }

    const discount = line.discount ?? ZERO
    if (discount < 0) return { ok: false, code: 'NEGATIVE_DISCOUNT' }
    // Refused rather than quietly dropped: a cashier who types a discount on a
    // razor-margin line should be told it will not be given, not left believing
    // it was.
    if (discountBlocked && discount > 0) {
      return { ok: false, code: 'DISCOUNT_BLOCKED', productId: product.id, productName: product.name }
    }
    if (sub(grossOf(priced.rate, line.qty), discount) < 0) {
      return { ok: false, code: 'DISCOUNT_EXCEEDS_TOTAL', subtotal: grossOf(priced.rate, line.qty), discount }
    }

    computed.push({
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsnCode,
      saleUnit: unit.saleUnit,
      qty: line.qty,
      baseQty: qty(Math.round((line.qty * unit.baseUnits) / QTY_SCALE)),
      rate: priced.rate,
      mrp: product.mrp ?? null,
      discount,
      taxRateBp: taxed ? product.taxRateBp : 0,
      // Cess is a tax like GST: a shop that may not collect one collects neither.
      cessRateBp: taxed ? product.cessRateBp : 0,
      rateIncludesTax: priced.includesTax,
      priceSource: priced.source,
      priceSourceId: priced.sourceId,
      discountBlocked,
      loyaltyBlocked,
    })
  }

  const billDiscount = input.billDiscount ?? ZERO
  if (billDiscount < 0) return { ok: false, code: 'NEGATIVE_DISCOUNT' }
  /* Read here rather than passed in, so the counter, the draft it saves and the
     bill it becomes are all rounded by the same answer. The screen reads the
     same setting through the core context. */
  const totals = computeTotals(computed, billDiscount, supply, await loadRounding(db))

  // computeTotals clamps for the screen's benefit; a service caller asking for
  // more discount than the bill holds is a mistake worth reporting, not silently
  // reducing. The comparison is against the discountable part, because a bill
  // whose lines are all excluded can carry no bill discount at all.
  if (billDiscount > totals.discountableSubtotal) {
    return {
      ok: false,
      code: 'DISCOUNT_EXCEEDS_TOTAL',
      subtotal: totals.discountableSubtotal,
      discount: billDiscount,
    }
  }

  return {
    ok: true,
    computed,
    totals,
    subtotal: totals.subtotal,
    meta: {
      sessionId,
      customerId: input.customerId ?? null,
      customerName: customer?.name ?? null,
      postingDate,
      placeOfSupply: customer?.stateCode ?? null,
      billDiscount,
      notes: input.notes ?? null,
      supply,
      now,
    },
  }
}
