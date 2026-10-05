import { eq, and, isNull, asc } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { AuditContext } from '../../integrity/audit.js'
import type { Rung } from '../../domain/ladder.js'
import { removeCustomerPrice, setCustomerPrice } from './customerPrices.js'
import { removeItemPrice, setItemPrice } from './itemPrices.js'
import { unitExists } from './units.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * Quantity breaks: the rate that applies from each quantity up, for a
 * product and for one customer.
 */

export type SetLadderResult =
  | { ok: true; rungs: number; removed: number }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }
  | { ok: false; code: 'BAD_DATES' }

/**
 * A whole quantity ladder in one go.
 *
 * The rungs given become the ladder: anything at a quantity not in the list is
 * removed. That is what makes the compact form on the product screen honest —
 * what is typed there is the ladder, not an addition to whatever was there
 * before, which would leave a rung nobody can see quietly undercutting the rest.
 */
export async function setLadder(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; priceListId: string; saleUnit: string; rungs: Rung[] },
): Promise<SetLadderResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const existing = await q(db)
    .select({ id: schema.itemPrices.id, minQty: schema.itemPrices.minQty })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.productId, input.productId),
      eq(schema.itemPrices.priceListId, input.priceListId),
      eq(schema.itemPrices.saleUnit, input.saleUnit),
      isNull(schema.itemPrices.deletedAt),
    ))
  const keep = new Set<number>(input.rungs.map((r) => r.minQty))

  for (const rung of input.rungs) {
    const written = await setItemPrice(db, ctx, {
      productId: input.productId,
      priceListId: input.priceListId,
      saleUnit: input.saleUnit,
      minQty: rung.minQty,
      rate: rung.rate,
    })
    if (!written.ok) return written
  }

  for (const row of existing) {
    if (!keep.has(row.minQty)) await removeItemPrice(db, ctx, row.id)
  }

  return { ok: true, rungs: input.rungs.length, removed: existing.filter((r) => !keep.has(r.minQty)).length }
}

/** The same, for a rate that belongs to one customer and one item. */
export async function setCustomerLadder(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { customerId: string; productId: string; saleUnit: string; rungs: Rung[] },
): Promise<SetLadderResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

  const existing = await q(db)
    .select({ id: schema.customerItemPrices.id, minQty: schema.customerItemPrices.minQty })
    .from(schema.customerItemPrices)
    .where(and(
      eq(schema.customerItemPrices.customerId, input.customerId),
      eq(schema.customerItemPrices.productId, input.productId),
      eq(schema.customerItemPrices.saleUnit, input.saleUnit),
      isNull(schema.customerItemPrices.deletedAt),
    ))
  const keep = new Set<number>(input.rungs.map((r) => r.minQty))

  for (const rung of input.rungs) {
    const written = await setCustomerPrice(db, ctx, {
      customerId: input.customerId,
      productId: input.productId,
      saleUnit: input.saleUnit,
      minQty: rung.minQty,
      rate: rung.rate,
    })
    if (!written.ok) return written
  }

  for (const row of existing) {
    if (!keep.has(row.minQty)) await removeCustomerPrice(db, ctx, row.id)
  }

  return { ok: true, rungs: input.rungs.length, removed: existing.filter((r) => !keep.has(r.minQty)).length }
}

/** One product's ladder on one list, in the order it applies. */
export async function ladderFor(
  db: SqlDriver,
  input: { productId: string; priceListId: string; saleUnit: string },
): Promise<Rung[]> {
  return q(db)
    .select({ minQty: schema.itemPrices.minQty, rate: schema.itemPrices.rate })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.productId, input.productId),
      eq(schema.itemPrices.priceListId, input.priceListId),
      eq(schema.itemPrices.saleUnit, input.saleUnit),
      isNull(schema.itemPrices.deletedAt),
    ))
    .orderBy(asc(schema.itemPrices.minQty))
}

export async function customerLadderFor(
  db: SqlDriver,
  input: { customerId: string; productId: string; saleUnit: string },
): Promise<Rung[]> {
  return q(db)
    .select({ minQty: schema.customerItemPrices.minQty, rate: schema.customerItemPrices.rate })
    .from(schema.customerItemPrices)
    .where(and(
      eq(schema.customerItemPrices.customerId, input.customerId),
      eq(schema.customerItemPrices.productId, input.productId),
      eq(schema.customerItemPrices.saleUnit, input.saleUnit),
      isNull(schema.customerItemPrices.deletedAt),
    ))
    .orderBy(asc(schema.customerItemPrices.minQty))
}

/**
 * Every product's ladder on one list, for a column in a list of products.
 *
 * One query rather than one per row: a shop with three thousand items would
 * otherwise open its product screen three thousand times.
 */
export async function laddersFor(
  db: SqlDriver,
  priceListId: string,
): Promise<Map<string, Rung[]>> {
  const rows = await q(db)
    .select({
      productId: schema.itemPrices.productId,
      minQty: schema.itemPrices.minQty,
      rate: schema.itemPrices.rate,
    })
    .from(schema.itemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.itemPrices.productId))
    .where(and(
      eq(schema.itemPrices.priceListId, priceListId),
      isNull(schema.itemPrices.deletedAt),
      // The base-unit ladder only: a column of rates in a list of products is
      // per piece, and a box rate in it would read as a very expensive piece.
      eq(schema.itemPrices.saleUnit, schema.products.baseUnit),
    ))
    .orderBy(asc(schema.itemPrices.productId), asc(schema.itemPrices.minQty))

  const ladders = new Map<string, Rung[]>()
  for (const row of rows) {
    const rungs = ladders.get(row.productId) ?? []
    rungs.push({ minQty: row.minQty, rate: row.rate })
    ladders.set(row.productId, rungs)
  }
  return ladders
}

/* --------------------------------------------------------------- helpers --- */
