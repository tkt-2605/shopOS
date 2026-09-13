import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

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
  const rows = await db.query<{
    id: string; name: string; parent_id: string | null; parent_name: string | null; n: number
  }>(
    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
            (SELECT COUNT(*) FROM products pr
              WHERE pr.category_id = c.id AND pr.deleted_at IS NULL) AS n
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
      WHERE c.deleted_at IS NULL
      ORDER BY COALESCE(p.name, c.name), c.name`,
  )
  return rows.map((r) => ({
    id: r.id, name: r.name, parentId: r.parent_id, parentName: r.parent_name, productCount: r.n,
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
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }

  const taken = await db.get<{ id: string }>(
    `SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`, [name],
  )
  if (taken) return { ok: false, code: 'NAME_TAKEN' }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO categories (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [id, name, input.parentId ?? null, now, now],
    )
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
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }

  const before = await db.get<{ name: string; parent_id: string | null }>(
    `SELECT name, parent_id FROM categories WHERE id = ? AND deleted_at IS NULL`, [input.categoryId],
  )
  if (!before) throw new Error('no such category')

  const taken = await db.get<{ id: string }>(
    `SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL`,
    [name, input.categoryId],
  )
  if (taken) return { ok: false, code: 'NAME_TAKEN' }

  const parentId = input.parentId === undefined ? before.parent_id : input.parentId
  // One level of nesting is all a shop needs, and a category that is its own
  // ancestor makes every list that walks upwards run for ever.
  if (parentId === input.categoryId) return { ok: false, code: 'WOULD_LOOP' }
  if (parentId) {
    const parent = await db.get<{ parent_id: string | null }>(
      `SELECT parent_id FROM categories WHERE id = ?`, [parentId],
    )
    if (parent?.parent_id === input.categoryId) return { ok: false, code: 'WOULD_LOOP' }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE categories SET name = ?, parent_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [name, parentId, now, input.categoryId],
    )
    await writeAudit(tx, ctx, {
      entity: 'categories', entityId: input.categoryId, action: 'update',
      before: { name: before.name, parent_id: before.parent_id },
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
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE products SET category_id = NULL WHERE category_id = ?`, [categoryId])
    await tx.execute(`UPDATE categories SET parent_id = NULL WHERE parent_id = ?`, [categoryId])
    await tx.execute(
      `UPDATE categories SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [now, now, categoryId],
    )
    await writeAudit(tx, ctx, { entity: 'categories', entityId: categoryId, action: 'delete' })
  })
}

export async function setProductCategory(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  categoryId: string | null,
): Promise<void> {
  const before = await db.get<{ category_id: string | null }>(
    `SELECT category_id FROM products WHERE id = ?`, [productId],
  )
  if (before?.category_id === categoryId) return

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE products SET category_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [categoryId, now, productId],
    )
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: productId, action: 'update',
      before: { category_id: before?.category_id ?? null }, after: { category_id: categoryId },
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
  if (input.parentProductId === input.productId) return { ok: false, code: 'SELF' }

  if (input.parentProductId) {
    const parent = await db.get<{ parent_product_id: string | null }>(
      `SELECT parent_product_id FROM products WHERE id = ? AND deleted_at IS NULL`,
      [input.parentProductId],
    )
    if (!parent) throw new Error('no such product')
    if (parent.parent_product_id) {
      return { ok: false, code: 'PARENT_IS_A_VARIANT', parentId: parent.parent_product_id }
    }

    // Something that already has versions of its own cannot become a version of
    // something else without making that second level.
    const children = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM products WHERE parent_product_id = ? AND deleted_at IS NULL`,
      [input.productId],
    )
    if ((children?.n ?? 0) > 0) return { ok: false, code: 'HAS_VARIANTS', count: children?.n ?? 0 }
  }

  const before = await db.get<{ parent_product_id: string | null; variant_label: string | null }>(
    `SELECT parent_product_id, variant_label FROM products WHERE id = ?`, [input.productId],
  )
  const label = input.variantLabel?.trim() || null
  const now = (ctx.now ?? (() => new Date().toISOString()))()

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE products SET parent_product_id = ?, variant_label = ?, updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [input.parentProductId, input.parentProductId ? label : null, now, input.productId],
    )
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: input.productId, action: 'update',
      before: { parent_product_id: before?.parent_product_id ?? null, variant_label: before?.variant_label ?? null },
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
  const self = await db.get<{ id: string; parent_product_id: string | null }>(
    `SELECT id, parent_product_id FROM products WHERE id = ? AND deleted_at IS NULL`, [productId],
  )
  if (!self) return []

  const rootId = self.parent_product_id ?? self.id
  const rows = await db.query<{ id: string; name: string; variant_label: string | null; parent: string | null }>(
    `SELECT id, name, variant_label, parent_product_id AS parent FROM products
      WHERE (id = ? OR parent_product_id = ?) AND deleted_at IS NULL
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, variant_label, name`,
    [rootId, rootId, rootId],
  )
  return rows.map((r) => ({
    id: r.id, name: r.name, variantLabel: r.variant_label, isParent: r.parent === null,
  }))
}
