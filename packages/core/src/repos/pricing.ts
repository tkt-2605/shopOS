import { eq, and, isNull, isNotNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { qty, QTY_SCALE, type Qty } from '../quantity.js'
import { resolvePrice } from '../domain/pricing.js'
import type { PriceCandidates, PriceTier, ResolvedPrice } from '../domain/pricing.js'
import { isOn } from '../services/features.js'
import { getSetting, DEFAULT_PRICE_LIST } from '../services/settings.js'
import { costHint } from './costs.js'

export interface PricingContext {
  productId: string
  saleUnit: string
  customerId?: string | null
  customerPriceListId?: string | null
  defaultPriceListId: string | null
  /** Defaults to true. See `PriceCandidates.quantityBreaks`. */
  quantityBreaks?: boolean | undefined
  /**
   * Whether a unit's own price for everyone is charged: "Box prices and MRP"
   * (079). Defaults to true. Off, a box is priced as its pieces.
   */
  unitPrices?: boolean | undefined
  /**
   * The batch the line sells out of (070). A batch with a rate of its own
   * stands in for the item's base rate; the lists and the customer's own rates
   * still outrank it, as they outrank the base rate.
   */
  batchId?: string | null | undefined
}

/**
 * Everything that could set the price of one line, in that line's own unit.
 *
 * A quantity ladder is written once, against the base unit, in base units —
 * "ten or more pieces are ₹9 each" — and it then applies however the goods
 * leave the shop. Two boxes of twelve is twenty-four pieces, so it earns the
 * ten-or-more rate, and the box is charged twelve times it.
 *
 * That conversion happens here rather than in the resolver: a rung at ten base
 * units, seen from a box of twelve, is a rung at ten-twelfths of a box priced
 * at twelve times the rate. Dividing the threshold and multiplying the rate is
 * exactly equivalent to comparing base quantities, and it leaves the resolver
 * the pure, well-tested thing it already is.
 */
export async function loadPriceCandidates(db: SqlDriver, ctx: PricingContext): Promise<PriceCandidates> {
  const [product] = await q(db)
    .select({ baseRate: schema.products.baseRate, baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(eq(schema.products.id, ctx.productId))
  if (!product) throw new Error(`unknown product: ${ctx.productId}`)

  let baseRate = product.baseRate
  if (ctx.batchId) {
    const [batch] = await q(db)
      .select({ rate: schema.batches.rate })
      .from(schema.batches)
      .where(and(eq(schema.batches.id, ctx.batchId), eq(schema.batches.productId, ctx.productId)))
    if (batch?.rate != null) baseRate = batch.rate
  }

  // How many base units one of the line's units is. One, when the line is in
  // the base unit itself.
  const factor = await baseUnitsPer(db, ctx.productId, ctx.saleUnit, product.baseUnit)
  const inSaleUnit = (rate: Money): Money => scaleRate(rate, factor)

  // The base rate is per base unit, so a box of twelve is twelve times it.
  // Without this a shop selling by the box collects one piece's worth of money
  // and gives away twelve pieces of stock.
  const candidates: PriceCandidates = {
    baseRate: inSaleUnit(baseRate),
    quantityBreaks: ctx.quantityBreaks !== false,
  }
  const ladderUnit = product.baseUnit === ctx.saleUnit ? null : product.baseUnit

  if (ctx.customerId) {
    const tiers: PriceTier[] = await customerTiers(db, ctx.customerId, ctx.productId, ctx.saleUnit)

    // Only when this customer has said nothing about this unit — see loadTiers.
    if (ladderUnit && tiers.length === 0) {
      const base = await customerTiers(db, ctx.customerId, ctx.productId, ladderUnit)
      tiers.push(...base.map((r) => converted(r, factor)))
    }

    if (tiers.length > 0) candidates.customerTiers = tiers
  }

  if (ctx.customerPriceListId) {
    candidates.customerListTiers = await loadTiers(
      db, ctx.productId, ctx.customerPriceListId, ctx.saleUnit, ladderUnit, factor,
    )
  }
  if (ctx.defaultPriceListId && ctx.defaultPriceListId !== ctx.customerPriceListId) {
    candidates.defaultListTiers = await loadTiers(
      db, ctx.productId, ctx.defaultPriceListId, ctx.saleUnit, ladderUnit, factor,
      {
        // Box prices switched off: the box's own rows are kept and not read.
        ownUnit: ctx.unitPrices !== false,
        /* The item's own breaks, seen from a box, are breaks too. With them
           off, a rung at ten pieces must not become the price of a box of
           ten -- only a rung at one piece, which is a price and not a break. */
        baseFrom: ctx.quantityBreaks === false ? qty(QTY_SCALE) : null,
      },
    )
  }

  return candidates
}

/** What a price row says, whichever table it is in. */
interface TierRow {
  id: string
  minQty: Qty
  rate: Money
  validFrom: string | null
  validTo: string | null
}

/** One customer's own prices for one product in one unit. */
async function customerTiers(
  db: SqlDriver,
  customerId: string,
  productId: string,
  saleUnit: string,
): Promise<TierRow[]> {
  return q(db)
    .select({
      id: schema.customerItemPrices.id,
      minQty: schema.customerItemPrices.minQty,
      rate: schema.customerItemPrices.rate,
      validFrom: schema.customerItemPrices.validFrom,
      validTo: schema.customerItemPrices.validTo,
    })
    .from(schema.customerItemPrices)
    .where(and(
      eq(schema.customerItemPrices.customerId, customerId),
      eq(schema.customerItemPrices.productId, productId),
      eq(schema.customerItemPrices.saleUnit, saleUnit),
      isNull(schema.customerItemPrices.deletedAt),
    ))
}

/** A price list's prices for one product in one unit. */
async function listTiers(
  db: SqlDriver,
  productId: string,
  priceListId: string,
  saleUnit: string,
): Promise<TierRow[]> {
  return q(db)
    .select({
      id: schema.itemPrices.id,
      minQty: schema.itemPrices.minQty,
      rate: schema.itemPrices.rate,
      validFrom: schema.itemPrices.validFrom,
      validTo: schema.itemPrices.validTo,
    })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.productId, productId),
      eq(schema.itemPrices.priceListId, priceListId),
      eq(schema.itemPrices.saleUnit, saleUnit),
      isNull(schema.itemPrices.deletedAt),
    ))
}

async function loadTiers(
  db: SqlDriver,
  productId: string,
  priceListId: string,
  saleUnit: string,
  ladderUnit: string | null,
  factor: Qty,
  opts: { ownUnit?: boolean; baseFrom?: Qty | null } = {},
): Promise<PriceTier[]> {
  const tiers: PriceTier[] = ladderUnit && opts.ownUnit === false
    ? []
    : await listTiers(db, productId, priceListId, saleUnit)

  // The base ladder fills in for units the shop has said nothing about, and
  // steps aside entirely for one it has.
  //
  // "A box is ₹110" is a deliberate statement about boxes, and a ladder's bottom
  // rung — the ordinary per-piece price — must not quietly outrank it. Letting
  // the two mix meant comparing a threshold of one piece against a threshold of
  // one box, which is not a comparison at all. A shop that wants volume breaks
  // on boxes writes a box ladder: 1=110, 2=96.
  if (ladderUnit && tiers.length === 0) {
    const base = await listTiers(db, productId, priceListId, ladderUnit)
    const upTo = opts.baseFrom ?? null
    tiers.push(...base.filter((r) => upTo === null || r.minQty <= upTo).map((r) => converted(r, factor)))
  }

  return tiers
}

/** A base-unit rung seen from a bigger unit. */
function converted(row: TierRow, factor: Qty): PriceTier {
  return {
    ...row,
    minQty: qty(Math.round((row.minQty * QTY_SCALE) / factor)),
    rate: scaleRate(row.rate, factor),
  }
}

function scaleRate(rate: Money, factor: Qty): Money {
  return Math.round((rate * factor) / QTY_SCALE) as Money
}

async function baseUnitsPer(
  db: SqlDriver,
  productId: string,
  saleUnit: string,
  baseUnit: string,
): Promise<Qty> {
  if (saleUnit === baseUnit) return qty(QTY_SCALE)
  const [row] = await q(db)
    .select({ baseUnits: schema.productUnits.baseUnits })
    .from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, productId),
      eq(schema.productUnits.saleUnit, saleUnit),
      isNull(schema.productUnits.deletedAt),
    ))
  return row?.baseUnits ?? qty(QTY_SCALE)
}

export async function defaultPriceListId(db: SqlDriver): Promise<string | null> {
  const chosen = await getSetting(db, DEFAULT_PRICE_LIST)
  if (chosen === null || chosen === '') return null

  /* Checked rather than trusted. The setting can name a list that has since been
     archived — on this till or, more to the point, on another one — and a
     default that does not exist must read as no default rather than as a list
     the resolver will not find. */
  const [row] = await q(db)
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(and(eq(schema.priceLists.id, chosen), isNull(schema.priceLists.deletedAt)))
  return row?.id ?? null
}

/**
 * Which price lists apply to a customer, looked up once for a whole bill rather
 * than per line.
 *
 * This exists so the billing screen and the billing service cannot disagree. The
 * screen used to resolve a scanned item's price with the customer's price list
 * hardcoded to null and a quantity of one, while the service resolved the same
 * line with the real list and the real quantity — so the rate on screen was not
 * always the rate on the bill.
 */
export interface BillPricingContext {
  customerId: string | null
  customerPriceListId: string | null
  defaultPriceListId: string | null
  /** Whether this shop uses quantity breaks. Read once per bill, not per line. */
  quantityBreaks: boolean
  /** Whether a box's own price for everyone is charged (079). Missing reads as on. */
  unitPrices?: boolean
  /** Whether the customer's list quotes its rates with tax in them (063). True with no list. */
  customerListIncludesTax: boolean
  /** The same, for the shop's default list. */
  defaultListIncludesTax: boolean
}

/**
 * A resolved rate, and whether it has the tax in it.
 *
 * Carried with the rate rather than looked up later, because by then nobody
 * knows which list it came from. A product's own base rate is a shelf price;
 * a list's rate is however that list quotes; a customer's own price for an
 * item is read the way their list quotes, since it is the same negotiation.
 */
export interface ResolvedLinePrice extends ResolvedPrice {
  includesTax: boolean
}

/** Whether a list quotes with tax in. A list that is gone, or none, is a shelf price. */
/** Whether a price list's rates have GST in them. No list is the shelf, which does. */
export async function listIncludesTax(db: SqlDriver, priceListId: string | null): Promise<boolean> {
  if (!priceListId) return true
  const [row] = await q(db)
    .select({ ratesIncludeTax: schema.priceLists.ratesIncludeTax })
    .from(schema.priceLists)
    .where(eq(schema.priceLists.id, priceListId))
  return row?.ratesIncludeTax !== 0
}

export async function pricingContextFor(
  db: SqlDriver,
  customerId: string | null,
): Promise<BillPricingContext> {
  /* The join is what makes archiving a price list mean anything. A customer
     keeps pointing at the list after it is archived -- the row is not rewritten
     and the pointer is how restoring it puts them straight back on their old
     rates -- so the list has to be checked here, where the rate is decided,
     rather than trusted because it was live when somebody was put on it.
     Without this, an archived list goes on quietly pricing every line for every
     customer on it, which is exactly what `is_active` did for the whole of this
     table's life. */
  const [customer] = customerId
    ? await q(db)
        .select({ priceListId: schema.priceLists.id })
        .from(schema.customers)
        .leftJoin(schema.priceLists, and(
          eq(schema.priceLists.id, schema.customers.priceListId),
          isNull(schema.priceLists.deletedAt),
        ))
        .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    : []

  const defaultList = await defaultPriceListId(db)
  return {
    customerId: customerId ?? null,
    customerPriceListId: customer?.priceListId ?? null,
    defaultPriceListId: defaultList,
    quantityBreaks: await isOn(db, 'tieredPricing'),
    unitPrices: await isOn(db, 'unitPrices'),
    customerListIncludesTax: await listIncludesTax(db, customer?.priceListId ?? null),
    defaultListIncludesTax: await listIncludesTax(db, defaultList),
  }
}

/** The rate for one line, resolved the one way. */
export async function resolveLinePrice(
  db: SqlDriver,
  ctx: BillPricingContext,
  line: { productId: string; saleUnit: string; qty: Qty; batchId?: string | null },
  on: Date = new Date(),
): Promise<ResolvedLinePrice> {
  const candidates = await loadPriceCandidates(db, {
    productId: line.productId,
    saleUnit: line.saleUnit,
    batchId: line.batchId ?? null,
    customerId: ctx.customerId,
    customerPriceListId: ctx.customerPriceListId,
    defaultPriceListId: ctx.defaultPriceListId,
    quantityBreaks: ctx.quantityBreaks,
    unitPrices: ctx.unitPrices,
  })
  const resolved = resolvePrice(candidates, line.qty, on)
  return { ...resolved, includesTax: includesTaxFor(resolved.source, ctx) }
}

function includesTaxFor(source: ResolvedPrice['source'], ctx: BillPricingContext): boolean {
  switch (source) {
    case 'customer_list':
    case 'customer_override':
      return ctx.customerListIncludesTax
    case 'default_list':
      return ctx.defaultListIncludesTax
    default:
      return true
  }
}

/**
 * The rate a purchase order's line is given when none is typed: what the item
 * last cost the shop, before tax, for the unit it is ordered in (`costHints`).
 *
 * Not `resolveLinePrice`, which is what the shop *sells* at, tax included. A
 * purchase order used to take that, and receiving it then posted the goods in
 * at the selling price, so a blank rate quietly booked the shelf price as the
 * cost and every margin on the item read as nearly nothing. An item with no
 * cost known anywhere is ordered at zero, which the screen says before it is
 * saved.
 */
export async function purchaseOrderRate(
  db: SqlDriver, productId: string, baseUnits: Qty,
): Promise<{ rate: Money; includesTax: boolean }> {
  const perBase = (await costHint(db, productId))?.unitCost ?? 0
  return { rate: Math.round((perBase * baseUnits) / QTY_SCALE) as Money, includesTax: false }
}

export interface SaleUnitInfo {
  saleUnit: string
  baseUnits: Qty
  /** The MRP printed on one of this unit (079), whether or not the shop uses it; null for the base unit. */
  mrp?: Money | null
}

/**
 * The MRP of one of a line's unit: the box's own when it has one and the
 * shop uses box prices (079), else the piece's -- the batch's, or the item's --
 * times how many the unit holds. Null where nothing is printed.
 *
 * Per sale unit, as the receipt, the A4 invoice and "you saved" all read it.
 * Until 079 a box line was given the piece's MRP, so a box of ten at ₹85
 * printed MRP ₹10 beside it and its saving was never shown.
 */
export function lineMrp(perBase: Money | null, unit: SaleUnitInfo, unitPrices: boolean): Money | null {
  if (unitPrices && unit.mrp != null) return unit.mrp
  if (perBase === null) return null
  return scaleRate(perBase, unit.baseUnits)
}

export async function resolveSaleUnit(db: SqlDriver, productId: string, saleUnit: string | null): Promise<SaleUnitInfo> {
  if (saleUnit) {
    const [row] = await q(db)
      .select({
        saleUnit: schema.productUnits.saleUnit,
        baseUnits: schema.productUnits.baseUnits,
        mrp: schema.productUnits.mrp,
      })
      .from(schema.productUnits)
      .where(and(
        eq(schema.productUnits.productId, productId),
        eq(schema.productUnits.saleUnit, saleUnit),
        isNull(schema.productUnits.deletedAt),
      ))
    if (row) return row
  }

  const [base] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!base) throw new Error(`unknown product: ${productId}`)
  if (saleUnit && saleUnit !== base.baseUnit && !(await formerBaseUnit(db, productId, saleUnit))) {
    throw new Error(`product ${productId} has no sale unit "${saleUnit}"`)
  }
  return { saleUnit: base.baseUnit, baseUnits: qty(QTY_SCALE) }
}

/**
 * Whether a word is what this item's base unit used to be called
 * (`renameBaseUnit`): a retired unit of one. A held bill, a quotation or a
 * price file written before the rename still means one of the base unit.
 */
export async function formerBaseUnit(db: SqlDriver, productId: string, saleUnit: string): Promise<boolean> {
  const [row] = await q(db)
    .select({ id: schema.productUnits.id })
    .from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, productId),
      eq(schema.productUnits.saleUnit, saleUnit),
      eq(schema.productUnits.baseUnits, qty(QTY_SCALE)),
      isNotNull(schema.productUnits.deletedAt),
    ))
  return row !== undefined
}
