import { eq, and, ne, isNull, asc, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId, derivedId } from '../ids.js'
import type { Money } from '../money.js'
import { type Qty, qty, QTY_SCALE } from '../quantity.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import type { Rung } from '../domain/ladder.js'
import { setSetting, DEFAULT_PRICE_LIST } from './bootstrap.js'
import { defaultPriceListId } from '../repos/pricing.js'

/**
 * Writing prices down.
 *
 * The reading half of this — the four-step chain that decides what a line costs —
 * has existed since v1 in `domain/pricing.ts` and is thoroughly tested. What was
 * missing was any way for a shop to put a price into it: the tables were filled
 * by the demo seed and by nothing else. A pricing engine a shopkeeper cannot
 * reach is not a feature, it is a claim.
 *
 * Everything here is the write side of tables `repos/pricing.ts` already reads.
 */

/* ---------------------------------------------------------------- units --- */

export interface SaleUnit {
  id: string
  saleUnit: string
  /** How many base units one of these is. A ream is 500 sheets. */
  baseUnits: Qty
  isDefault: boolean
}

export interface SaleUnitInput {
  saleUnit: string
  baseUnits: Qty
  isDefault?: boolean
}

export type SetUnitsResult =
  | { ok: true; units: SaleUnit[] }
  | { ok: false; code: 'BAD_FACTOR'; saleUnit: string }
  | { ok: false; code: 'CLASHES_WITH_BASE'; saleUnit: string }
  | { ok: false; code: 'IN_USE'; saleUnit: string; billCount: number }

export async function listUnits(db: SqlDriver, productId: string): Promise<SaleUnit[]> {
  const rows = await q(db)
    .select({
      id: schema.productUnits.id,
      saleUnit: schema.productUnits.saleUnit,
      baseUnits: schema.productUnits.baseUnits,
      isDefault: schema.productUnits.isDefault,
    })
    .from(schema.productUnits)
    .where(eq(schema.productUnits.productId, productId))
    .orderBy(asc(schema.productUnits.baseUnits))

  return rows.map((r) => ({ ...r, isDefault: r.isDefault === 1 }))
}

/**
 * Replaces the sale units of a product.
 *
 * The base unit is not in this list and cannot be: it is the thing everything
 * else is counted in, stock is held in, and valuation is calculated in. A pack
 * is ten pieces; the piece is not a pack of anything.
 *
 * A unit that bills have already been written against is not removable. Those
 * bills name it, and a stock ledger derived from a factor that has been
 * deleted cannot be re-derived.
 */
export async function setUnits(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  inputs: SaleUnitInput[],
): Promise<SetUnitsResult> {
  const [product] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
  if (!product) throw new Error('no such product')

  const cleaned: SaleUnitInput[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const name = input.saleUnit.trim()
    if (name === '' || seen.has(name)) continue
    if (name === product.baseUnit) return { ok: false, code: 'CLASHES_WITH_BASE', saleUnit: name }
    if (input.baseUnits <= 0) return { ok: false, code: 'BAD_FACTOR', saleUnit: name }
    seen.add(name)
    cleaned.push({ saleUnit: name, baseUnits: input.baseUnits, isDefault: input.isDefault ?? false })
  }

  const existing = await listUnits(db, productId)
  for (const unit of existing) {
    if (seen.has(unit.saleUnit)) continue
    const [used] = await q(db)
      .select({ n: sql<number>`COUNT(*)` })
      .from(schema.billItems)
      .where(and(
        eq(schema.billItems.productId, productId),
        eq(schema.billItems.saleUnit, unit.saleUnit),
      ))
    if ((used?.n ?? 0) > 0) {
      return { ok: false, code: 'IN_USE', saleUnit: unit.saleUnit, billCount: used?.n ?? 0 }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await q(tx).delete(schema.productUnits)
      .where(eq(schema.productUnits.productId, productId))

    for (const input of cleaned) {
      /* Derived, not minted. The whole set is rewritten on every save, so a
         unit nobody touched used to come back under a new id — two tills doing
         that mint two, and the shop ends up holding "box of 12" twice. Derived
         from the product and the unit name, the rewrite writes the row both
         tills already agreed on, and the feed collapses the delete and the
         insert into one upsert of that row. */
      await q(tx).insert(schema.productUnits).values({
        id: await derivedId('product_units', productId, input.saleUnit),
        productId,
        saleUnit: input.saleUnit,
        baseUnits: input.baseUnits,
        isDefault: input.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: productId, action: 'update',
      before: { units: existing.map((u) => u.saleUnit).join(', ') || null },
      after: { units: cleaned.map((u) => u.saleUnit).join(', ') || null },
    })
  })

  return { ok: true, units: await listUnits(db, productId) }
}

/* ----------------------------------------------------------- price lists --- */

export interface PriceList {
  id: string
  name: string
  isDefault: boolean
  /** Taken off the list of lists. See `archivePriceList`. */
  archived: boolean
  /** How many customers are on this list, so archiving one is an informed act. */
  customerCount: number
  priceCount: number
}

export async function listPriceLists(
  db: SqlDriver,
  options: { includeArchived?: boolean } = {},
): Promise<PriceList[]> {
  /* raw: two correlated counts. A pair of joins would multiply one by the
     other -- a list with four customers and nine rates would report thirty-six
     of each -- and a shopkeeper about to archive a list is reading these two
     numbers to decide whether they can. */
  const customers = sql<number>`(SELECT COUNT(*) FROM customers c
     WHERE c.price_list_id = price_lists.id AND c.deleted_at IS NULL)`
  const prices = sql<number>`(SELECT COUNT(*) FROM item_prices p
     WHERE p.price_list_id = price_lists.id AND p.deleted_at IS NULL)`

  /* Which one is the default comes from the setting, not from the column 043
     made vestigial. Read once here rather than joined, because it is one value
     and the alternative is a correlated subquery against `settings` on every
     row. */
  const chosen = await defaultPriceListId(db)

  const rows = await q(db)
    .select({
      id: schema.priceLists.id,
      name: schema.priceLists.name,
      deletedAt: schema.priceLists.deletedAt,
      customerCount: customers,
      priceCount: prices,
    })
    .from(schema.priceLists)
    .where(options.includeArchived ? undefined : isNull(schema.priceLists.deletedAt))
    .orderBy(
      asc(sql`${schema.priceLists.deletedAt} IS NOT NULL`),
      asc(schema.priceLists.name),
    )

  // Live lists first, the default at the top of them, then by name. The first
  // two are the database's business; the third was, until the default moved.
  return rows
    .map((r) => ({ ...r, isDefault: r.id === chosen, archived: r.deletedAt !== null }))
    .sort((x, y) => Number(x.archived) - Number(y.archived)
      || Number(y.isDefault) - Number(x.isDefault)
      || x.name.localeCompare(y.name))
}

export type PriceListResult =
  | { ok: true; priceListId: string }
  | { ok: false; code: 'NO_NAME' }
  | { ok: false; code: 'NAME_TAKEN' }
  /* The name is UNIQUE in the schema and an archived list keeps its row, so
     "Wholesale" stays spoken for after it is taken off the list. Saying which
     kind of clash it is lets the screen offer the one useful answer -- bring
     the old one back -- instead of a shopkeeper typing Wholesale2. */
  | { ok: false; code: 'NAME_TAKEN_ARCHIVED'; priceListId: string }

export async function createPriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { name: string; isDefault?: boolean },
): Promise<PriceListResult> {
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  const [taken] = await q(db)
    .select({ id: schema.priceLists.id, deletedAt: schema.priceLists.deletedAt })
    .from(schema.priceLists)
    /* raw: `COLLATE NOCASE`, which decides whether "wholesale" and "Wholesale"
       are the same name. The unique index on this column carries the same
       collation, so a comparison without it would let a shop past this check
       and into the constraint. */
    .where(sql`${schema.priceLists.name} = ${name} COLLATE NOCASE`)
  if (taken) {
    return taken.deletedAt === null
      ? { ok: false, code: 'NAME_TAKEN' }
      : { ok: false, code: 'NAME_TAKEN_ARCHIVED', priceListId: taken.id }
  }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.priceLists).values({ id, name, createdAt: now, updatedAt: now })
    /* One default, always, and now by construction: one setting can only name
       one list. This used to be `UPDATE price_lists SET is_default = 0` across
       every row — which gave every list in the shop a revision and a feed entry
       in order to record one fact about one of them. */
    if (input.isDefault) await setSetting(tx, DEFAULT_PRICE_LIST, id, now)
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: id, action: 'create', after: { name, is_default: input.isDefault ? 1 : 0 },
    })
  })

  return { ok: true, priceListId: id }
}

export async function updatePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { priceListId: string; name?: string; isDefault?: boolean; isActive?: boolean },
): Promise<PriceListResult> {
  const [before] = await q(db)
    .select({ name: schema.priceLists.name })
    .from(schema.priceLists)
    .where(and(eq(schema.priceLists.id, input.priceListId), isNull(schema.priceLists.deletedAt)))
  if (!before) throw new Error('no such price list')

  const name = input.name?.trim() ?? before.name
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (name !== before.name) {
    const [taken] = await q(db)
      .select({ id: schema.priceLists.id, deletedAt: schema.priceLists.deletedAt })
      .from(schema.priceLists)
      // raw: `COLLATE NOCASE`, as in `createPriceList`.
      .where(and(
        sql`${schema.priceLists.name} = ${name} COLLATE NOCASE`,
        ne(schema.priceLists.id, input.priceListId),
      ))
    if (taken) {
      return taken.deletedAt === null
        ? { ok: false, code: 'NAME_TAKEN' }
        : { ok: false, code: 'NAME_TAKEN_ARCHIVED', priceListId: taken.id }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const wasDefault = (await defaultPriceListId(db)) === input.priceListId
  const isDefault = input.isDefault ?? wasDefault

  await db.transaction(async (tx) => {
    await q(tx).update(schema.priceLists)
      .set({ name, updatedAt: now, rev: sql`${schema.priceLists.rev} + 1` })
      .where(eq(schema.priceLists.id, input.priceListId))

    /* Naming this one names it; unnaming it leaves the shop with none, which is
       what `is_default = 0` on the last default meant too. The screen has no
       way to ask for that — the checkbox turns off by another list being turned
       on — so the branch exists for completeness rather than for a button. */
    if (isDefault) await setSetting(tx, DEFAULT_PRICE_LIST, input.priceListId, now)
    else if (wasDefault) await setSetting(tx, DEFAULT_PRICE_LIST, '', now)

    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: input.priceListId, action: 'update',
      before: { name: before.name, is_default: wasDefault ? 1 : 0 },
      after: { name, is_default: isDefault ? 1 : 0 },
    })
  })

  return { ok: true, priceListId: input.priceListId }
}

export type ArchivePriceListResult =
  | { ok: true }
  /* The default list. Archiving it leaves a walk-in customer with no list at
     all, and `idx_price_lists_one_default` would go on holding the default
     slot for a row nothing can see. Make another one default first. */
  | { ok: false; code: 'IS_DEFAULT' }
  /* Customers buy on this list. Hiding it does not move them off it -- it
     changes what they are charged, quietly, at the counter, tomorrow morning.
     That is a decision about prices, and it belongs to the shop, one customer
     at a time, on the screen that shows who they are. */
  | { ok: false; code: 'IN_USE'; customerCount: number }

/**
 * Taking a price list off the list of price lists.
 *
 * `deleted_at` on this table has been filtered by every reader since 001 --
 * `listPriceLists`, `createPriceList`, `defaultPriceListId` -- and set by
 * nothing. So a list typed in by mistake, or one for a scheme that ended two
 * Diwalis ago, stayed on the screen for the life of the shop. This is the
 * writing half those readers were waiting for.
 *
 * It is a soft delete and it has to be. `item_prices` rows point at the list,
 * and a submitted bill line points at the `item_prices` row it was priced from
 * through `price_source_id` -- that chain is how support answers "why was this
 * one 42 rupees last March", and a hard delete breaks it at the first link.
 *
 * Archiving takes the rates out of use without taking them out of the record:
 * `pricingContextFor` will not price a customer on an archived list, and the
 * list stops appearing anywhere a live list belongs.
 */
export async function archivePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  priceListId: string,
): Promise<ArchivePriceListResult> {
  const [list] = await q(db)
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(and(eq(schema.priceLists.id, priceListId), isNull(schema.priceLists.deletedAt)))
  if (!list) throw new Error('no such price list')
  if (await defaultPriceListId(db) === priceListId) return { ok: false, code: 'IS_DEFAULT' }

  const [on] = await q(db)
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.customers)
    .where(and(
      eq(schema.customers.priceListId, priceListId),
      isNull(schema.customers.deletedAt),
    ))
  if ((on?.n ?? 0) > 0) return { ok: false, code: 'IN_USE', customerCount: on?.n ?? 0 }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.priceLists)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.priceLists.id, priceListId))
    await writeAudit(tx, ctx, { entity: 'price_lists', entityId: priceListId, action: 'delete' })
  })

  return { ok: true }
}

/**
 * And back.
 *
 * The rates on it were never touched, so the list resumes pricing exactly as it
 * did. That is the reason a shop can afford to archive one at all.
 */
export async function restorePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  priceListId: string,
): Promise<void> {
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.priceLists)
      .set({ deletedAt: null, updatedAt: now })
      .where(eq(schema.priceLists.id, priceListId))
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: priceListId, action: 'update',
      before: { 'On the list': 'removed' }, after: { 'On the list': 'yes' },
    })
  })
}

/* ----------------------------------------------------------- item prices --- */

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
}

export type ItemPriceResult =
  | { ok: true; itemPriceId: string }
  | { ok: false; code: 'BAD_DATES' }
  | { ok: false; code: 'UNKNOWN_UNIT'; saleUnit: string }

export async function listItemPrices(
  db: SqlDriver,
  filter: { productId?: string; priceListId?: string } = {},
): Promise<ItemPrice[]> {
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
      desc(schema.priceLists.isDefault),
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
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

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
  },
): Promise<ItemPriceResult> {
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    return { ok: false, code: 'BAD_DATES' }
  }
  if (!(await unitExists(db, input.productId, input.saleUnit))) {
    return { ok: false, code: 'UNKNOWN_UNIT', saleUnit: input.saleUnit }
  }

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

/**
 * A rate can only be written against a unit the product actually sells in —
 * otherwise it is a price nothing will ever resolve, sitting in the table
 * looking as though it works.
 */
async function unitExists(db: SqlDriver, productId: string, saleUnit: string): Promise<boolean> {
  const [base] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
  if (!base) return false
  if (base.baseUnit === saleUnit) return true

  const [row] = await q(db)
    .select({ id: schema.productUnits.id })
    .from(schema.productUnits)
    .where(and(
      eq(schema.productUnits.productId, productId),
      eq(schema.productUnits.saleUnit, saleUnit),
    ))
  return row !== undefined
}

/**
 * What one base unit costs at a given rate, for showing a shopkeeper whether a
 * pack of ten is actually cheaper than ten pieces.
 */
export function perBaseUnit(rate: Money, baseUnits: Qty): Money {
  if (baseUnits <= 0) return rate
  return Math.round((rate * QTY_SCALE) / baseUnits) as Money
}
