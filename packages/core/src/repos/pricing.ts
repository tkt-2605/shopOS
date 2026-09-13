import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { qty, QTY_SCALE, type Qty } from '../quantity.js'
import { resolvePrice } from '../domain/pricing.js'
import type { PriceCandidates, PriceTier, ResolvedPrice } from '../domain/pricing.js'

export interface PricingContext {
  productId: string
  saleUnit: string
  customerId?: string | null
  customerPriceListId?: string | null
  defaultPriceListId: string | null
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
  const product = await db.get<{ base_rate: number; base_unit: string }>(
    `SELECT base_rate, base_unit FROM products WHERE id = ?`, [ctx.productId],
  )
  if (!product) throw new Error(`unknown product: ${ctx.productId}`)

  // How many base units one of the line's units is. One, when the line is in
  // the base unit itself.
  const factor = await baseUnitsPer(db, ctx.productId, ctx.saleUnit, product.base_unit)
  const inSaleUnit = (rate: Money): Money => scaleRate(rate, factor)

  // The base rate is per base unit, so a box of twelve is twelve times it.
  // Without this a shop selling by the box collects one piece's worth of money
  // and gives away twelve pieces of stock.
  const candidates: PriceCandidates = { baseRate: inSaleUnit(product.base_rate as Money) }
  const ladderUnit = product.base_unit === ctx.saleUnit ? null : product.base_unit

  if (ctx.customerId) {
    const rows = await db.query<{
      id: string; min_qty: number; rate: number; valid_from: string | null; valid_to: string | null
    }>(
      `SELECT id, min_qty, rate, valid_from, valid_to FROM customer_item_prices
        WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
      [ctx.customerId, ctx.productId, ctx.saleUnit],
    )
    const tiers: PriceTier[] = rows.map((r) => ({
      id: r.id,
      minQty: qty(r.min_qty),
      rate: r.rate as Money,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }))

    // Only when this customer has said nothing about this unit — see loadTiers.
    if (ladderUnit && tiers.length === 0) {
      const base = await db.query<{
        id: string; min_qty: number; rate: number; valid_from: string | null; valid_to: string | null
      }>(
        `SELECT id, min_qty, rate, valid_from, valid_to FROM customer_item_prices
          WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
        [ctx.customerId, ctx.productId, ladderUnit],
      )
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
    )
  }

  return candidates
}

interface TierRow {
  id: string
  min_qty: number
  rate: number
  valid_from: string | null
  valid_to: string | null
}

async function loadTiers(
  db: SqlDriver,
  productId: string,
  priceListId: string,
  saleUnit: string,
  ladderUnit: string | null,
  factor: Qty,
): Promise<PriceTier[]> {
  const rows = await db.query<TierRow>(
    `SELECT id, min_qty, rate, valid_from, valid_to FROM item_prices
      WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
    [productId, priceListId, saleUnit],
  )

  const tiers: PriceTier[] = rows.map((r) => ({
    id: r.id,
    minQty: qty(r.min_qty),
    rate: r.rate as Money,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }))

  // The base ladder fills in for units the shop has said nothing about, and
  // steps aside entirely for one it has.
  //
  // "A box is ₹110" is a deliberate statement about boxes, and a ladder's bottom
  // rung — the ordinary per-piece price — must not quietly outrank it. Letting
  // the two mix meant comparing a threshold of one piece against a threshold of
  // one box, which is not a comparison at all. A shop that wants volume breaks
  // on boxes writes a box ladder: 1=110, 2=96.
  if (ladderUnit && tiers.length === 0) {
    const base = await db.query<TierRow>(
      `SELECT id, min_qty, rate, valid_from, valid_to FROM item_prices
        WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
      [productId, priceListId, ladderUnit],
    )
    tiers.push(...base.map((r) => converted(r, factor)))
  }

  return tiers
}

/** A base-unit rung seen from a bigger unit. */
function converted(row: TierRow, factor: Qty): PriceTier {
  return {
    id: row.id,
    minQty: qty(Math.round((row.min_qty * QTY_SCALE) / factor)),
    rate: scaleRate(row.rate as Money, factor),
    validFrom: row.valid_from,
    validTo: row.valid_to,
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
  const row = await db.get<{ base_units: number }>(
    `SELECT base_units FROM product_units WHERE product_id = ? AND sale_unit = ?`,
    [productId, saleUnit],
  )
  return qty(row?.base_units ?? QTY_SCALE)
}

export async function defaultPriceListId(db: SqlDriver): Promise<string | null> {
  const row = await db.get<{ id: string }>(`SELECT id FROM price_lists WHERE is_default = 1 AND deleted_at IS NULL`)
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
}

export async function pricingContextFor(
  db: SqlDriver,
  customerId: string | null,
): Promise<BillPricingContext> {
  const customer = customerId
    ? await db.get<{ price_list_id: string | null }>(
        `SELECT price_list_id FROM customers WHERE id = ? AND deleted_at IS NULL`,
        [customerId],
      )
    : null

  return {
    customerId: customerId ?? null,
    customerPriceListId: customer?.price_list_id ?? null,
    defaultPriceListId: await defaultPriceListId(db),
  }
}

/** The rate for one line, resolved the one way. */
export async function resolveLinePrice(
  db: SqlDriver,
  ctx: BillPricingContext,
  line: { productId: string; saleUnit: string; qty: Qty },
  on: Date = new Date(),
): Promise<ResolvedPrice> {
  const candidates = await loadPriceCandidates(db, {
    productId: line.productId,
    saleUnit: line.saleUnit,
    customerId: ctx.customerId,
    customerPriceListId: ctx.customerPriceListId,
    defaultPriceListId: ctx.defaultPriceListId,
  })
  return resolvePrice(candidates, line.qty, on)
}

export interface SaleUnitInfo {
  saleUnit: string
  baseUnits: Qty
}

export async function resolveSaleUnit(db: SqlDriver, productId: string, saleUnit: string | null): Promise<SaleUnitInfo> {
  if (saleUnit) {
    const row = await db.get<{ sale_unit: string; base_units: number }>(
      `SELECT sale_unit, base_units FROM product_units WHERE product_id = ? AND sale_unit = ?`,
      [productId, saleUnit],
    )
    if (row) return { saleUnit: row.sale_unit, baseUnits: qty(row.base_units) }
  }

  const base = await db.get<{ base_unit: string }>(`SELECT base_unit FROM products WHERE id = ?`, [productId])
  if (!base) throw new Error(`unknown product: ${productId}`)
  if (saleUnit && saleUnit !== base.base_unit) {
    throw new Error(`product ${productId} has no sale unit "${saleUnit}"`)
  }
  return { saleUnit: base.base_unit, baseUnits: qty(10_000) }
}
