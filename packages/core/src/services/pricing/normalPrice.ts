import { eq, and, isNull, lte } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { qty, QTY_SCALE } from '../../quantity.js'
import { addTax } from '../../domain/tax.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import { requirePermission } from '../../integrity/permissions.js'
import { defaultPriceListId, listIncludesTax } from '../../repos/pricing.js'
import { removeItemPrice } from './itemPrices.js'

/*
 * One normal price per item.
 *
 * An item's selling rate is what everybody pays. Until 24 October the item
 * form also had "Price on the shop's list", a rate on the default price list
 * that the counter took *before* the selling rate -- so an item could show
 * ₹10 on Inventory and ring up at ₹9, with nothing on the item to say why.
 * The default list now holds only the quantity breaks above the selling rate.
 *
 * A shop that set such a rate keeps it until somebody chooses: these are the
 * items priced twice, and what choosing one does.
 */

export interface DoublePrice {
  productId: string
  name: string
  /** The selling rate on the item, GST in. */
  sellingRate: Money
  /** The rate on the shop's list, GST in, the way a shelf price is read. */
  listRate: Money
  /** The two say the same thing, and the list's can go without asking anybody. */
  same: boolean
}

/** Every item whose single rate on the shop's list is not simply its selling rate. */
export async function itemsPricedTwice(db: SqlDriver): Promise<DoublePrice[]> {
  const listId = await defaultPriceListId(db)
  if (!listId) return []
  const withTax = await listIncludesTax(db, listId)

  /* Only the plain rate in the item's own unit: a box price, or a break at ten,
     is not a second price for one piece. */
  const rows = await q(db)
    .select({
      productId: schema.products.id,
      name: schema.products.name,
      sellingRate: schema.products.baseRate,
      taxRateBp: schema.products.taxRateBp,
      cessRateBp: schema.products.cessRateBp,
      rate: schema.itemPrices.rate,
    })
    .from(schema.itemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.itemPrices.productId))
    .where(and(
      eq(schema.itemPrices.priceListId, listId),
      eq(schema.itemPrices.saleUnit, schema.products.baseUnit),
      lte(schema.itemPrices.minQty, qty(QTY_SCALE)),
      isNull(schema.itemPrices.deletedAt),
      isNull(schema.products.deletedAt),
    ))
    .orderBy(schema.products.name)

  const seen = new Set<string>()
  const out: DoublePrice[] = []
  for (const r of rows) {
    if (seen.has(r.productId)) continue
    seen.add(r.productId)
    const listRate = withTax
      ? r.rate
      : (r.rate + addTax(r.rate, r.taxRateBp, 'intra_state', r.cessRateBp ?? 0).taxTotal) as Money
    out.push({ productId: r.productId, name: r.name, sellingRate: r.sellingRate, listRate, same: listRate === r.sellingRate })
  }
  return out
}

export type SettleResult = { ok: true } | { ok: false; code: 'NOT_PRICED_TWICE' }

/**
 * Keeps one of an item's two prices.
 *
 * `selling` keeps the item's selling rate and takes the list's rate off.
 * `list` makes the list's rate the selling rate first -- what the counter has
 * been charging, so nothing a customer pays changes -- and then takes it off.
 */
export async function settleDoublePrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; keep: 'selling' | 'list' },
): Promise<SettleResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const found = (await itemsPricedTwice(db)).find((d) => d.productId === input.productId)
  if (!found) return { ok: false, code: 'NOT_PRICED_TWICE' }
  const listId = (await defaultPriceListId(db))!

  if (input.keep === 'list' && found.listRate !== found.sellingRate) {
    await requirePermission(db, ctx.actorId, 'product', 'write')
    const now = ctx.now?.() ?? new Date().toISOString()
    await q(db).update(schema.products)
      .set({ baseRate: found.listRate, updatedAt: now })
      .where(eq(schema.products.id, input.productId))
    await writeAudit(db, ctx, {
      entity: 'products', entityId: input.productId, action: 'update',
      before: { base_rate: found.sellingRate }, after: { base_rate: found.listRate, reason: 'kept the shop list price' },
    })
  }

  const rows = await q(db)
    .select({ id: schema.itemPrices.id })
    .from(schema.itemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.itemPrices.productId))
    .where(and(
      eq(schema.itemPrices.productId, input.productId),
      eq(schema.itemPrices.priceListId, listId),
      eq(schema.itemPrices.saleUnit, schema.products.baseUnit),
      lte(schema.itemPrices.minQty, qty(QTY_SCALE)),
      isNull(schema.itemPrices.deletedAt),
    ))
  for (const r of rows) await removeItemPrice(db, ctx, r.id)
  return { ok: true }
}

export interface PriceElsewhere {
  /** A price list's name, or a customer's. */
  who: string
  kind: 'list' | 'customer'
  saleUnit: string
  /** The rung's start: zero or one is the plain rate. */
  minQty: number
  rate: Money
}

/**
 * Where else an item has a price, for the line under its selling rate.
 *
 * Read-only on the item: these are set on Special Prices, and the item only
 * has to say they exist, so nobody is surprised at the counter.
 */
export async function pricesElsewhere(db: SqlDriver, productId: string): Promise<PriceElsewhere[]> {
  const listId = await defaultPriceListId(db)
  const lists = await q(db)
    .select({
      who: schema.priceLists.name, saleUnit: schema.itemPrices.saleUnit,
      minQty: schema.itemPrices.minQty, rate: schema.itemPrices.rate, listId: schema.priceLists.id,
    })
    .from(schema.itemPrices)
    .innerJoin(schema.priceLists, eq(schema.priceLists.id, schema.itemPrices.priceListId))
    .where(and(
      eq(schema.itemPrices.productId, productId),
      isNull(schema.itemPrices.deletedAt),
      isNull(schema.priceLists.deletedAt),
    ))
    .orderBy(schema.priceLists.name, schema.itemPrices.minQty)
  const customers = await q(db)
    .select({
      who: schema.customers.name, saleUnit: schema.customerItemPrices.saleUnit,
      minQty: schema.customerItemPrices.minQty, rate: schema.customerItemPrices.rate,
    })
    .from(schema.customerItemPrices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerItemPrices.customerId))
    .where(and(
      eq(schema.customerItemPrices.productId, productId),
      isNull(schema.customerItemPrices.deletedAt),
      isNull(schema.customers.deletedAt),
    ))
    .orderBy(schema.customers.name, schema.customerItemPrices.minQty)
  return [
    ...lists.filter((r) => r.listId !== listId).map(({ listId: _, ...r }) => ({ ...r, kind: 'list' as const })),
    ...customers.map((r) => ({ ...r, kind: 'customer' as const })),
  ]
}
