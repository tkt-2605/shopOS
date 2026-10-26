import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { ZERO, type Money } from '../../money.js'
import { fromUnits } from '../../quantity.js'
import { computeTotals } from '../../domain/billTotals.js'
import { chargesTax } from '../../domain/taxScheme.js'
import { loadTaxScheme } from '../features.js'
import {
  pricingContextFor, resolveLinePrice, resolveSaleUnit, lineMrp, type BillPricingContext,
} from '../../repos/pricing.js'
import { loadWebSettings } from './gate.js'
import { getSetting } from '../settings.js'

/*
 * What the storefront lists, priced the way the counter would price it for a
 * walk-in customer.
 *
 * Published as one file named by its own hash. The phone keeps the last one it
 * read and Cloudflare keeps every one it has served, so a catalogue that has
 * not changed costs the main nothing however many people browse it, and a
 * catalogue that has changed is a new name nobody can be holding a stale copy
 * of. The small manifest beside it is the only thing that is ever asked again.
 *
 * No counts. A customer is told an item is there or is not; how many the shop
 * has is the shop's business, and a number would be out of date by the time a
 * phone showed it anyway.
 */

export interface CatalogUnit {
  /** The sale unit's name, e.g. `piece` or `box of 10`. */
  unit: string
  /** One of this unit, tax included, in paise. */
  price: Money
  mrp: Money | null
}

export interface CatalogItem {
  id: string
  name: string
  brand: string | null
  categoryId: string | null
  units: CatalogUnit[]
  /** Whether the shop had any on its last count. */
  available: boolean
  /** Content hashes of the two photo sizes, served at `/img/<hash>`. */
  thumb: string | null
  photo: string | null
}

export interface CatalogCategory {
  id: string
  name: string
  parentId: string | null
}

export interface Catalog {
  shop: string
  categories: CatalogCategory[]
  items: CatalogItem[]
}

export interface PublishedCatalog {
  hash: string
  /** The JSON served at `/catalog/<hash>.json`. */
  body: string
  itemCount: number
}

/** The categories chosen, and every category under them. */
export async function listedCategoryIds(db: SqlDriver): Promise<Set<string>> {
  const chosen = (await loadWebSettings(db)).categoryIds
  const all = await q(db)
    .select({ id: schema.categories.id, parentId: schema.categories.parentId })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
  const children = new Map<string, string[]>()
  for (const c of all) {
    if (c.parentId === null) continue
    children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id])
  }
  const live = new Set(all.map((c) => c.id))
  const listed = new Set<string>()
  const walk = (id: string) => {
    if (listed.has(id) || !live.has(id)) return
    listed.add(id)
    for (const child of children.get(id) ?? []) walk(child)
  }
  chosen.forEach(walk)
  return listed
}

/** Whether an item may be ordered online: sold, not deleted, and in a listed category. */
export async function isListed(db: SqlDriver, productId: string, categories?: Set<string>): Promise<boolean> {
  const [row] = await q(db)
    .select({ categoryId: schema.products.categoryId })
    .from(schema.products)
    .where(and(
      eq(schema.products.id, productId),
      eq(schema.products.isActive, 1),
      eq(schema.products.openPrice, 0),
      isNull(schema.products.deletedAt),
    ))
  if (!row || row.categoryId === null) return false
  return (categories ?? await listedCategoryIds(db)).has(row.categoryId)
}

export interface ShelfPricer {
  ctx: BillPricingContext
  taxed: boolean
}

export async function shelfPricer(db: SqlDriver): Promise<ShelfPricer> {
  return { ctx: await pricingContextFor(db, null), taxed: chargesTax(await loadTaxScheme(db)) }
}

/**
 * One of a unit, as a walk-in customer would pay for it at the counter today:
 * the same rate `resolveLinePrice` gives a bill, with tax put on the way a bill
 * puts it on, so a list that quotes before GST still shows the price paid.
 */
export async function shelfPrice(
  db: SqlDriver, pricer: ShelfPricer, productId: string, saleUnit: string | null, on: Date,
): Promise<{ unit: string; price: Money; mrp: Money | null }> {
  const unit = await resolveSaleUnit(db, productId, saleUnit)
  const resolved = await resolveLinePrice(
    db, pricer.ctx, { productId, saleUnit: unit.saleUnit, qty: fromUnits(1) }, on,
  )
  const [product] = await q(db)
    .select({ taxRateBp: schema.products.taxRateBp, cessRateBp: schema.products.cessRateBp, mrp: schema.products.mrp })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  const totals = computeTotals([{
    qty: fromUnits(1),
    rate: resolved.rate,
    taxRateBp: pricer.taxed ? product?.taxRateBp ?? 0 : 0,
    cessRateBp: pricer.taxed ? product?.cessRateBp ?? 0 : 0,
    rateIncludesTax: resolved.includesTax,
  }], ZERO, 'intra_state', 'none')
  return {
    unit: unit.saleUnit,
    price: totals.grandTotal,
    mrp: lineMrp(product?.mrp ?? null, unit, pricer.ctx.unitPrices ?? false),
  }
}

export async function buildCatalog(db: SqlDriver, on: Date = new Date()): Promise<Catalog> {
  const categories = await listedCategoryIds(db)
  const shop = (await getSetting(db, 'shop_name')) ?? ''
  const categoryRows = categories.size === 0 ? [] : await q(db)
    .select({ id: schema.categories.id, name: schema.categories.name, parentId: schema.categories.parentId })
    .from(schema.categories)
    .where(inArray(schema.categories.id, [...categories]))

  const products = categories.size === 0 ? [] : await q(db)
    .select({
      id: schema.products.id,
      name: schema.products.name,
      brand: schema.products.brand,
      categoryId: schema.products.categoryId,
      baseUnit: schema.products.baseUnit,
      onHand: schema.productStock.qtyOnHand,
      tracked: schema.products.isStockTracked,
    })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(and(
      inArray(schema.products.categoryId, [...categories]),
      eq(schema.products.isActive, 1),
      eq(schema.products.openPrice, 0),
      isNull(schema.products.deletedAt),
    ))

  const units = products.length === 0 ? [] : await q(db)
    .select({ productId: schema.productUnits.productId, saleUnit: schema.productUnits.saleUnit })
    .from(schema.productUnits)
    .where(and(
      inArray(schema.productUnits.productId, products.map((p) => p.id)),
      isNull(schema.productUnits.deletedAt),
    ))
  const unitsOf = new Map<string, string[]>()
  for (const u of units) unitsOf.set(u.productId, [...(unitsOf.get(u.productId) ?? []), u.saleUnit])

  const photos = await photoHashes(db)
  const pricer = await shelfPricer(db)
  const items: CatalogItem[] = []
  for (const p of products) {
    const names = [p.baseUnit, ...(unitsOf.get(p.id) ?? []).filter((u) => u !== p.baseUnit)]
    const priced: CatalogUnit[] = []
    for (const name of names) {
      const s = await shelfPrice(db, pricer, p.id, name === p.baseUnit ? null : name, on)
      /* A unit nobody has priced would show as free. Leave it out. */
      if (s.price > 0) priced.push(s)
    }
    if (priced.length === 0) continue
    const photo = photos.get(p.id)
    items.push({
      id: p.id,
      name: p.name,
      brand: p.brand,
      categoryId: p.categoryId,
      units: priced,
      available: p.tracked === 0 || (p.onHand ?? 0) > 0,
      thumb: photo?.thumb ?? null,
      photo: photo?.photo ?? null,
    })
  }

  return {
    shop,
    categories: categoryRows.sort(byName),
    items: items.sort((a, b) => byName(a, b) || (a.id < b.id ? -1 : 1)),
  }
}

/** The catalogue as the file it is served as, named by its own content. */
export async function publishCatalog(db: SqlDriver, on: Date = new Date()): Promise<PublishedCatalog> {
  const catalog = await buildCatalog(db, on)
  const body = JSON.stringify(catalog)
  return { hash: await sha256Hex(body), body, itemCount: catalog.items.length }
}

/** Each listed item's photo, as the content hashes of its two sizes. */
async function photoHashes(db: SqlDriver): Promise<Map<string, { photo: string; thumb: string }>> {
  /* raw: the same table joined twice under two names, once per size, which the
     builder can only say through aliases that cost more to read than this. */
  const rows = await db.query<{ product_id: string; photo: string; thumb: string }>(
    `SELECT pp.product_id, big.sha256 AS photo, small.sha256 AS thumb
       FROM product_photos pp
       JOIN attachments big ON big.id = pp.photo_id AND big.deleted_at IS NULL
       JOIN attachments small ON small.id = pp.thumb_id AND small.deleted_at IS NULL`,
  )
  return new Map(rows.map((r) => [r.product_id, { photo: r.photo, thumb: r.thumb }]))
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
