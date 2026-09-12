import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { qty, type Qty } from '../quantity.js'
import type { PriceCandidates, PriceTier, CustomerOverride } from '../domain/pricing.js'

export interface PricingContext {
  productId: string
  saleUnit: string
  customerId?: string | null
  customerPriceListId?: string | null
  defaultPriceListId: string | null
}

export async function loadPriceCandidates(db: SqlDriver, ctx: PricingContext): Promise<PriceCandidates> {
  const product = await db.get<{ base_rate: number }>(`SELECT base_rate FROM products WHERE id = ?`, [ctx.productId])
  if (!product) throw new Error(`unknown product: ${ctx.productId}`)

  const candidates: PriceCandidates = { baseRate: product.base_rate as Money }

  if (ctx.customerId) {
    const row = await db.get<{ id: string; rate: number; valid_from: string | null; valid_to: string | null }>(
      `SELECT id, rate, valid_from, valid_to FROM customer_item_prices
        WHERE customer_id = ? AND product_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
      [ctx.customerId, ctx.productId, ctx.saleUnit],
    )
    if (row) {
      candidates.customerOverride = {
        id: row.id,
        rate: row.rate as Money,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      } satisfies CustomerOverride
    }
  }

  if (ctx.customerPriceListId) {
    candidates.customerListTiers = await loadTiers(db, ctx.productId, ctx.customerPriceListId, ctx.saleUnit)
  }
  if (ctx.defaultPriceListId && ctx.defaultPriceListId !== ctx.customerPriceListId) {
    candidates.defaultListTiers = await loadTiers(db, ctx.productId, ctx.defaultPriceListId, ctx.saleUnit)
  }

  return candidates
}

async function loadTiers(db: SqlDriver, productId: string, priceListId: string, saleUnit: string): Promise<PriceTier[]> {
  const rows = await db.query<{ id: string; min_qty: number; rate: number; valid_from: string | null; valid_to: string | null }>(
    `SELECT id, min_qty, rate, valid_from, valid_to FROM item_prices
      WHERE product_id = ? AND price_list_id = ? AND sale_unit = ? AND deleted_at IS NULL`,
    [productId, priceListId, saleUnit],
  )
  return rows.map((r) => ({
    id: r.id,
    minQty: qty(r.min_qty),
    rate: r.rate as Money,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }))
}

export async function defaultPriceListId(db: SqlDriver): Promise<string | null> {
  const row = await db.get<{ id: string }>(`SELECT id FROM price_lists WHERE is_default = 1 AND deleted_at IS NULL`)
  return row?.id ?? null
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
