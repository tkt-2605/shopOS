import { eq, ne, and, or, isNull, count, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'

/**
 * Putting items into groups, and tying versions of the same thing together.
 *
 * Two different things that are easy to confuse:
 *
 * A **category** is what an item is — stationery, cold drinks, groceries. It is
 * how a person browses when they do not already know the name, which is what a
 * touch screen or an app needs and a search box cannot provide.
 *
 * A **variant** is what an item is a version of. The same pen in six colours
 * stays six products — six barcodes, six stock counts, because there really are
 * six things on the shelf — but they hang off one parent, so a search offers the
 * six together and a report can ask how the pen is selling rather than how the
 * blue one is.
 */

/* ------------------------------------------------------------ categories --- */

export interface Category {
  id: string
  name: string
  parentId: string | null
  parentName: string | null
  productCount: number
}

export async function listCategories(db: SqlDriver): Promise<Category[]> {
  const parent = alias(schema.categories, 'p')
  const item = alias(schema.products, 'pr')

  /* The count was a correlated subquery and is now a join, which SQLite plans
     the same way and the compiler can read. The join carries the "not deleted"
     test in its own condition rather than in `where`: moved up, it would turn
     the left join back into an inner one and lose every empty category. */
  const rows = await q(db)
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
      parentName: parent.name,
      n: count(item.id),
    })
    .from(schema.categories)
    .leftJoin(parent, eq(parent.id, schema.categories.parentId))
    .leftJoin(item, and(eq(item.categoryId, schema.categories.id), isNull(item.deletedAt)))
    .where(isNull(schema.categories.deletedAt))
    .groupBy(schema.categories.id, parent.name)
    .orderBy(sql`COALESCE(${parent.name}, ${schema.categories.name})`, schema.categories.name)

  return rows.map((r) => ({
    id: r.id, name: r.name, parentId: r.parentId, parentName: r.parentName, productCount: r.n,
  }))
}

export type CategoryResult =
  | { ok: true; categoryId: string }
  | { ok: false; code: 'NO_NAME' }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'WOULD_LOOP' }

export async function createCategory(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { name: string; parentId?: string | null },
): Promise<CategoryResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }

  const [taken] = await q(db)
    .select({ id: schema.categories.id })
    .from(schema.categories)
    // raw: `COLLATE NOCASE`. Two categories called Stationery and stationery
    // are one category to everybody except the comparison.
    .where(and(
      sql`${schema.categories.name} = ${name} COLLATE NOCASE`,
      isNull(schema.categories.deletedAt),
    ))
  if (taken) return { ok: false, code: 'NAME_TAKEN' }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.categories).values({
      id, name, parentId: input.parentId ?? null, createdAt: now, updatedAt: now,
    })
    await writeAudit(tx, ctx, {
      entity: 'categories', entityId: id, action: 'create',
      after: { name, parent_id: input.parentId ?? null },
    })
  })

  return { ok: true, categoryId: id }
}

export async function renameCategory(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { categoryId: string; name: string; parentId?: string | null },
): Promise<CategoryResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }

  const [before] = await q(db)
    .select({ name: schema.categories.name, parentId: schema.categories.parentId })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, input.categoryId), isNull(schema.categories.deletedAt)))
  if (!before) throw new Error('no such category')

  const [taken] = await q(db)
    .select({ id: schema.categories.id })
    .from(schema.categories)
    // raw: `COLLATE NOCASE`, as in `createCategory`.
    .where(and(
      sql`${schema.categories.name} = ${name} COLLATE NOCASE`,
      ne(schema.categories.id, input.categoryId),
      isNull(schema.categories.deletedAt),
    ))
  if (taken) return { ok: false, code: 'NAME_TAKEN' }

  const parentId = input.parentId === undefined ? before.parentId : input.parentId
  // One level of nesting is all a shop needs, and a category that is its own
  // ancestor makes every list that walks upwards run for ever.
  if (parentId === input.categoryId) return { ok: false, code: 'WOULD_LOOP' }
  if (parentId) {
    const [parent] = await q(db)
      .select({ parentId: schema.categories.parentId })
      .from(schema.categories)
      .where(eq(schema.categories.id, parentId))
    if (parent?.parentId === input.categoryId) return { ok: false, code: 'WOULD_LOOP' }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.categories)
      .set({ name, parentId, updatedAt: now, rev: sql`${schema.categories.rev} + 1` })
      .where(eq(schema.categories.id, input.categoryId))
    await writeAudit(tx, ctx, {
      entity: 'categories', entityId: input.categoryId, action: 'update',
      before: { name: before.name, parent_id: before.parentId },
      after: { name, parent_id: parentId },
    })
  })

  return { ok: true, categoryId: input.categoryId }
}

/**
 * Retires a category. Items keep their own record of it until they are edited —
 * removing a category is a change of how the shop organises itself, not a claim
 * that the things in it never existed.
 */
export async function removeCategory(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  categoryId: string,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({ categoryId: null })
      .where(eq(schema.products.categoryId, categoryId))
    await q(tx).update(schema.categories)
      .set({ parentId: null })
      .where(eq(schema.categories.parentId, categoryId))
    await q(tx).update(schema.categories)
      .set({ deletedAt: now, updatedAt: now, rev: sql`${schema.categories.rev} + 1` })
      .where(eq(schema.categories.id, categoryId))
    await writeAudit(tx, ctx, { entity: 'categories', entityId: categoryId, action: 'delete' })
  })
}

export async function setProductCategory(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  categoryId: string | null,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const [before] = await q(db)
    .select({ categoryId: schema.products.categoryId })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (before?.categoryId === categoryId) return

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({ categoryId, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(eq(schema.products.id, productId))
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: productId, action: 'update',
      before: { category_id: before?.categoryId ?? null }, after: { category_id: categoryId },
    })
  })
}

/* -------------------------------------------------------------- variants --- */

export interface VariantMember {
  id: string
  name: string
  variantLabel: string | null
  isParent: boolean
}

export type VariantResult =
  | { ok: true }
  | { ok: false; code: 'SELF' }
  | { ok: false; code: 'PARENT_IS_A_VARIANT'; parentId: string }
  | { ok: false; code: 'HAS_VARIANTS'; count: number }

/**
 * Hangs a product off another as a version of it.
 *
 * One level only. A variant of a variant is a tree, and a tree needs a walk at
 * every point that touches it — for a distinction ("blue", "500g") that is flat
 * in every shop that has ever asked for this.
 */
export async function setVariantOf(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; parentProductId: string | null; variantLabel?: string | null },
): Promise<VariantResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  if (input.parentProductId === input.productId) return { ok: false, code: 'SELF' }

  if (input.parentProductId) {
    const [parent] = await q(db)
      .select({ parentProductId: schema.products.parentProductId })
      .from(schema.products)
      .where(and(
        eq(schema.products.id, input.parentProductId),
        isNull(schema.products.deletedAt),
      ))
    if (!parent) throw new Error('no such product')
    if (parent.parentProductId) {
      return { ok: false, code: 'PARENT_IS_A_VARIANT', parentId: parent.parentProductId }
    }

    // Something that already has versions of its own cannot become a version of
    // something else without making that second level.
    const [children] = await q(db)
      .select({ n: count() })
      .from(schema.products)
      .where(and(
        eq(schema.products.parentProductId, input.productId),
        isNull(schema.products.deletedAt),
      ))
    if ((children?.n ?? 0) > 0) return { ok: false, code: 'HAS_VARIANTS', count: children?.n ?? 0 }
  }

  const [before] = await q(db)
    .select({
      parentProductId: schema.products.parentProductId,
      variantLabel: schema.products.variantLabel,
    })
    .from(schema.products)
    .where(eq(schema.products.id, input.productId))

  const label = input.variantLabel?.trim() || null
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await q(tx).update(schema.products)
      .set({
        parentProductId: input.parentProductId,
        variantLabel: input.parentProductId ? label : null,
        updatedAt: now,
        rev: sql`${schema.products.rev} + 1`,
      })
      .where(eq(schema.products.id, input.productId))
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: input.productId, action: 'update',
      before: { parent_product_id: before?.parentProductId ?? null, variant_label: before?.variantLabel ?? null },
      after: { parent_product_id: input.parentProductId, variant_label: input.parentProductId ? label : null },
    })
  })

  return { ok: true }
}

/**
 * The whole family a product belongs to, parent first — whether the product
 * asked about is the parent or one of the versions.
 */
export async function variantFamily(db: SqlDriver, productId: string): Promise<VariantMember[]> {
  const [self] = await q(db)
    .select({ id: schema.products.id, parentProductId: schema.products.parentProductId })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), isNull(schema.products.deletedAt)))
  if (!self) return []

  const rootId = self.parentProductId ?? self.id
  const rows = await q(db)
    .select({
      id: schema.products.id,
      name: schema.products.name,
      variantLabel: schema.products.variantLabel,
      parent: schema.products.parentProductId,
    })
    .from(schema.products)
    .where(and(
      or(eq(schema.products.id, rootId), eq(schema.products.parentProductId, rootId)),
      isNull(schema.products.deletedAt),
    ))
    // The parent first, then its versions by label. `CASE` rather than sorting
    // on `parent_product_id IS NULL`, so the intent survives being read.
    .orderBy(
      sql`CASE WHEN ${schema.products.id} = ${rootId} THEN 0 ELSE 1 END`,
      schema.products.variantLabel,
      schema.products.name,
    )

  return rows.map((r) => ({
    id: r.id, name: r.name, variantLabel: r.variantLabel, isParent: r.parent === null,
  }))
}
