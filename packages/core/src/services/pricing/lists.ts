import { eq, and, ne, isNull, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { writeAudit, type AuditContext } from '../../integrity/audit.js'
import { setSetting, DEFAULT_PRICE_LIST } from '../settings.js'
import { defaultPriceListId } from '../../repos/pricing.js'
import { requirePermission } from '../../integrity/permissions.js'

/*
 * Price lists: created, renamed, archived, and brought back.
 */

export interface PriceList {
  id: string
  name: string
  isDefault: boolean
  /**
   * Whether the rates on this list already include GST. True for a shelf
   * price list; false for a wholesale list quoted before tax (063).
   */
  ratesIncludeTax: boolean
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
      ratesIncludeTax: schema.priceLists.ratesIncludeTax,
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
    .map((r) => ({
      ...r, isDefault: r.id === chosen, archived: r.deletedAt !== null, ratesIncludeTax: r.ratesIncludeTax !== 0,
    }))
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
  input: { name: string; isDefault?: boolean; ratesIncludeTax?: boolean },
): Promise<PriceListResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
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
    await q(tx).insert(schema.priceLists).values({
      id, name, ratesIncludeTax: input.ratesIncludeTax === false ? 0 : 1, createdAt: now, updatedAt: now,
    })
    /* One default, always, and now by construction: one setting can only name
       one list. This used to be `UPDATE price_lists SET is_default = 0` across
       every row — which gave every list in the shop a revision and a feed entry
       in order to record one fact about one of them. */
    if (input.isDefault) await setSetting(tx, DEFAULT_PRICE_LIST, id, now)
    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: id, action: 'create',
      after: { name, is_default: input.isDefault ? 1 : 0, rates_include_tax: input.ratesIncludeTax === false ? 0 : 1 },
    })
  })

  return { ok: true, priceListId: id }
}

export async function updatePriceList(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: {
    priceListId: string; name?: string; isDefault?: boolean; isActive?: boolean
    /**
     * Changing it re-reads every rate on the list the other way from the next
     * bill on. Bills already made keep the way their lines were read.
     */
    ratesIncludeTax?: boolean
  },
): Promise<PriceListResult> {
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
  const [before] = await q(db)
    .select({ name: schema.priceLists.name, ratesIncludeTax: schema.priceLists.ratesIncludeTax })
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
      .set({
        name,
        ratesIncludeTax: input.ratesIncludeTax === undefined ? before.ratesIncludeTax : input.ratesIncludeTax ? 1 : 0,
        updatedAt: now,
        rev: sql`${schema.priceLists.rev} + 1`,
      })
      .where(eq(schema.priceLists.id, input.priceListId))

    /* Naming this one names it; unnaming it leaves the shop with none, which is
       what `is_default = 0` on the last default meant too. The screen has no
       way to ask for that — the checkbox turns off by another list being turned
       on — so the branch exists for completeness rather than for a button. */
    if (isDefault) await setSetting(tx, DEFAULT_PRICE_LIST, input.priceListId, now)
    else if (wasDefault) await setSetting(tx, DEFAULT_PRICE_LIST, '', now)

    await writeAudit(tx, ctx, {
      entity: 'price_lists', entityId: input.priceListId, action: 'update',
      before: { name: before.name, is_default: wasDefault ? 1 : 0, rates_include_tax: before.ratesIncludeTax },
      after: {
        name, is_default: isDefault ? 1 : 0,
        rates_include_tax: input.ratesIncludeTax === undefined ? before.ratesIncludeTax : input.ratesIncludeTax ? 1 : 0,
      },
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
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
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
  await requirePermission(db, ctx.actorId, 'price_list', 'write')
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
