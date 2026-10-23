import { eq, and, isNull, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { derivedId } from '../../ids.js'
import type { Money } from '../../money.js'
import { type Qty, qty } from '../../quantity.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import type { ItemPriceResult } from './itemPrices.js'
import { unitExists } from './units.js'
import { requirePermission } from '../../integrity/permissions.js'
import { listIncludesTax } from '../../repos/pricing.js'
import { rateRefusal } from '../belowCost.js'

/*
 * A price agreed with one customer, and the list a customer buys from.
 */

export interface CustomerPrice {
  id: string
  customerId: string
  customerName: string
  productId: string
  productName: string
  saleUnit: string
  /** A customer's own rate is a ladder too: ₹9, ₹8 from ten, ₹7 from fifty. */
  minQty: Qty
  rate: Money
  validFrom: string | null
  validTo: string | null
}

export async function listCustomerPrices(
  db: SqlDriver,
  filter: { customerId?: string; productId?: string } = {},
): Promise<CustomerPrice[]> {
  return q(db)
    .select({
      id: schema.customerItemPrices.id,
      customerId: schema.customerItemPrices.customerId,
      customerName: schema.customers.name,
      productId: schema.customerItemPrices.productId,
      productName: schema.products.name,
      saleUnit: schema.customerItemPrices.saleUnit,
      minQty: schema.customerItemPrices.minQty,
      rate: schema.customerItemPrices.rate,
      validFrom: schema.customerItemPrices.validFrom,
      validTo: schema.customerItemPrices.validTo,
    })
    .from(schema.customerItemPrices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerItemPrices.customerId))
    .innerJoin(schema.products, eq(schema.products.id, schema.customerItemPrices.productId))
    .where(and(
      isNull(schema.customerItemPrices.deletedAt),
      ...(filter.customerId ? [eq(schema.customerItemPrices.customerId, filter.customerId)] : []),
      ...(filter.productId ? [eq(schema.customerItemPrices.productId, filter.productId)] : []),
    ))
    .orderBy(
      asc(schema.customers.name),
      asc(schema.products.name),
      asc(schema.customerItemPrices.saleUnit),
      asc(schema.customerItemPrices.minQty),
    )
}

export async function setCustomerPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: {
    customerId: string; productId: string; saleUnit: string; rate: Money
    minQty?: Qty; validFrom?: string | null; validTo?: string | null
    /** Write a rate below cost anyway: for a role allowed to, and recorded (`belowCost.ts`). */
    allowBelowCost?: boolean
  },
): Promise<ItemPriceResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }
  /* Read the way the counter reads a customer's own rate: as their list
     quotes, with GST in it unless their list says otherwise. */
  const [customer] = await q(db)
    .select({ priceListId: schema.customers.priceListId })
    .from(schema.customers)
    .where(eq(schema.customers.id, input.customerId))
  const under = await rateRefusal(db, ctx, {
    productId: input.productId, saleUnit: input.saleUnit, rate: input.rate,
    includesTax: await listIncludesTax(db, customer?.priceListId ?? null),
    allow: input.allowBelowCost === true, entity: 'customer_item_prices', entityId: input.productId,
  })
  if (under) return under

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const minQty = input.minQty ?? qty(0)
  const [existing] = await q(db)
    .select({ id: schema.customerItemPrices.id, rate: schema.customerItemPrices.rate })
    .from(schema.customerItemPrices)
    .where(and(
      eq(schema.customerItemPrices.customerId, input.customerId),
      eq(schema.customerItemPrices.productId, input.productId),
      eq(schema.customerItemPrices.saleUnit, input.saleUnit),
      eq(schema.customerItemPrices.minQty, minQty),
    ))
  // Same reasoning as `setItemPrice`, with the customer in the combination.
  const id = existing?.id
    ?? await derivedId(
      'customer_item_prices', input.customerId, input.productId, input.saleUnit, minQty,
    )

  await db.transaction(async (tx) => {
    if (existing) {
      await q(tx).update(schema.customerItemPrices)
        .set({
          rate: input.rate,
          validFrom: input.validFrom ?? null,
          validTo: input.validTo ?? null,
          deletedAt: null,
          updatedAt: now,
          rev: sql`${schema.customerItemPrices.rev} + 1`,
        })
        .where(eq(schema.customerItemPrices.id, id))
    } else {
      await q(tx).insert(schema.customerItemPrices).values({
        id,
        customerId: input.customerId,
        productId: input.productId,
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
      entity: 'customer_item_prices', entityId: id, action: existing ? 'update' : 'create',
      before: existing ? { rate: existing.rate } : null,
      after: { customer_id: input.customerId, product_id: input.productId, rate: input.rate },
    })
  })

  return { ok: true, itemPriceId: id }
}

export async function removeCustomerPrice(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  id: string,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.customerItemPrices)
      .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.customerItemPrices.rev} + 1` })
      .where(eq(schema.customerItemPrices.id, id))
    await writeAudit(tx, ctx, { entity: 'customer_item_prices', entityId: id, action: 'delete' })
  })
}

/** Which price list a customer buys on. Null puts them back on the default. */
export async function setCustomerPriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  customerId: string,
  priceListId: string | null,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const [before] = await q(db)
    .select({ priceListId: schema.customers.priceListId })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))

  await db.transaction(async (tx) => {
    await q(tx).update(schema.customers)
      .set({ priceListId, updatedAt: now, rev: sql`${schema.customers.rev} + 1` })
      .where(eq(schema.customers.id, customerId))
    await writeAudit(tx, ctx, {
      entity: 'customers', entityId: customerId, action: 'update',
      before: { price_list_id: before?.priceListId ?? null },
      after: { price_list_id: priceListId },
    })
  })
}

/* --------------------------------------------------------------- ladders --- */

/** The list a customer buys from, or null for the shop's default. */
export async function customerPriceListId(db: SqlDriver, customerId: string): Promise<string | null> {
  const [row] = await q(db)
    .select({ priceListId: schema.customers.priceListId })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
  return row?.priceListId ?? null
}

/** Who buys on a list, by name: the people a rate on it reaches. */
export async function customersOnList(
  db: SqlDriver,
  priceListId: string,
): Promise<{ id: string; name: string }[]> {
  return q(db)
    .select({ id: schema.customers.id, name: schema.customers.name })
    .from(schema.customers)
    .where(and(eq(schema.customers.priceListId, priceListId), isNull(schema.customers.deletedAt)))
    .orderBy(schema.customers.name)
}
