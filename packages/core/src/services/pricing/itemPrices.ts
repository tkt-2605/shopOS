import { eq, and, isNull, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { derivedId } from '../../ids.js'
import type { Money } from '../../money.js'
import { type Qty, qty } from '../../quantity.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import { unitExists } from './units.js'
import { defaultPriceListId, listIncludesTax } from '../../repos/pricing.js'
import { rateRefusal, type BelowCostRefusal } from '../belowCost.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * A product's price on a list, per unit it sells in.
 */

export interface ItemPrice {
  id: string
  productId: string
  productName: string
  priceListId: string
  priceListName: string
  saleUnit: string
  /** Buy this many or more and this rate applies. Zero is the plain rate. */
  minQty: Qty
  rate: Money
  validFrom: string | null
  validTo: string | null
}

export interface ItemPriceInput {
  productId: string
  priceListId: string
  saleUnit: string
  minQty?: Qty
  rate: Money
  validFrom?: string | null
  validTo?: string | null
  /** Write a rate below cost anyway: for a role allowed to, and recorded (`belowCost.ts`). */
  allowBelowCost?: boolean
}

export type ItemPriceResult =
  | { ok: true; itemPriceId: string }
  | { ok: false; code: 'BAD_DATES' }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }
  /** The rate, without its GST, is below what the item costs. Nothing was written. */
  | BelowCostRefusal

export async function listItemPrices(
  db: SqlDriver,
  filter: { productId?: string; priceListId?: string } = {},
): Promise<ItemPrice[]> {
  /* The default list first. It used to be `price_lists.is_default`, which 043
     stopped anything setting; the default is the setting now, so the sort
     reads the setting rather than a column that is 0 on every row. */
  const standard = await defaultPriceListId(db)
  return q(db)
    .select({
      id: schema.itemPrices.id,
      productId: schema.itemPrices.productId,
      productName: schema.products.name,
      priceListId: schema.itemPrices.priceListId,
      priceListName: schema.priceLists.name,
      saleUnit: schema.itemPrices.saleUnit,
      minQty: schema.itemPrices.minQty,
      rate: schema.itemPrices.rate,
      validFrom: schema.itemPrices.validFrom,
      validTo: schema.itemPrices.validTo,
    })
    .from(schema.itemPrices)
    .innerJoin(schema.products, eq(schema.products.id, schema.itemPrices.productId))
    .innerJoin(schema.priceLists, eq(schema.priceLists.id, schema.itemPrices.priceListId))
    .where(and(
      isNull(schema.itemPrices.deletedAt),
      ...(filter.productId ? [eq(schema.itemPrices.productId, filter.productId)] : []),
      ...(filter.priceListId ? [eq(schema.itemPrices.priceListId, filter.priceListId)] : []),
    ))
    .orderBy(
      asc(schema.products.name),
      sql`CASE WHEN ${schema.priceLists.id} = ${standard ?? ''} THEN 0 ELSE 1 END`,
      asc(schema.priceLists.name),
      asc(schema.itemPrices.saleUnit),
      asc(schema.itemPrices.minQty),
    )
}

/**
 * Writes one rate.
 *
 * The unique key is (product, list, unit, minimum quantity), so saving the same
 * rung twice replaces it rather than making a second one the resolver would have
 * to choose between.
 */
export async function setItemPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: ItemPriceInput,
): Promise<ItemPriceResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }
  const under = await rateRefusal(db, ctx, {
    productId: input.productId, saleUnit: input.saleUnit, rate: input.rate,
    includesTax: await listIncludesTax(db, input.priceListId),
    allow: input.allowBelowCost === true, entity: 'item_prices', entityId: input.productId,
  })
  if (under) return under

  const minQty = input.minQty ?? qty(0)
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  const [existing] = await q(db)
    .select({ id: schema.itemPrices.id, rate: schema.itemPrices.rate })
    .from(schema.itemPrices)
    .where(and(
      eq(schema.itemPrices.productId, input.productId),
      eq(schema.itemPrices.priceListId, input.priceListId),
      eq(schema.itemPrices.saleUnit, input.saleUnit),
      eq(schema.itemPrices.minQty, minQty),
    ))

  /* Reusing the row already here is what makes a second save an edit rather
     than a second rung. `derivedId` extends that agreement to a till this one
     has never spoken to: the id *is* the combination, so two counters that both
     price this product on this list in this unit at this quantity write one row
     and the later timestamp settles the rate. With `newId` they wrote two, and
     the resolver would have found a ladder with two identical rungs. */
  const id = existing?.id
    ?? await derivedId(
      'item_prices', input.productId, input.priceListId, input.saleUnit, minQty,
    )
  await db.transaction(async (tx) => {
    if (existing) {
      /* `deleted_at = NULL` on the way past: writing the same rung again is how
         a shop brings back a rate it removed, and leaving it archived would
         make the screen show a rung the resolver ignores. */
      await q(tx).update(schema.itemPrices)
        .set({
          rate: input.rate,
          validFrom: input.validFrom ?? null,
          validTo: input.validTo ?? null,
          deletedAt: null,
          updatedAt: now,
          rev: sql`${schema.itemPrices.rev} + 1`,
        })
        .where(eq(schema.itemPrices.id, id))
    } else {
      await q(tx).insert(schema.itemPrices).values({
        id,
        productId: input.productId,
        priceListId: input.priceListId,
        saleUnit: input.saleUnit,
        minQty,
        rate: input.rate,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        createdAt: now,
        updatedAt: now,
      })
    }
    await writeAudit(tx, ctx, {
      entity: 'item_prices', entityId: id, action: existing ? 'update' : 'create',
      before: existing ? { rate: existing.rate } : null,
      after: { product_id: input.productId, sale_unit: input.saleUnit, min_qty: minQty, rate: input.rate },
    })
  })

  return { ok: true, itemPriceId: id }
}

export async function removeItemPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  itemPriceId: string,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    // Soft, because a submitted bill points at this row through price_source_id
    // and support has to be able to answer "why was this ₹42" next March.
    await q(tx).update(schema.itemPrices)
      .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.itemPrices.rev} + 1` })
      .where(eq(schema.itemPrices.id, itemPriceId))
    await writeAudit(tx, ctx, { entity: 'item_prices', entityId: itemPriceId, action: 'delete' })
  })
}

/* ------------------------------------------------- customer-specific rates --- */
