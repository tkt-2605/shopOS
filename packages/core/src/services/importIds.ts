import { eq, isNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId, derivedId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

/**
 * Where a catalogue file's rows land: the category each name means and the id
 * a new item is made under. Both are derived from what the row says rather
 * than drawn at random, so two tills importing one file while apart make the
 * same category and the same item, which the merge then joins into one.
 */

/**
 * The category each name in the file means, making the ones the shop lacks.
 *
 * By name, ignoring case, as `createCategory` holds them unique. Made here in
 * the import's own transaction rather than through `createCategory`, which
 * opens one of its own, so a failed import does not leave its categories behind.
 */
export async function categoriesFor(
  tx: SqlDriver, ctx: AuditContext, rows: readonly { category: string | null }[], now: string,
): Promise<(name: string) => string> {
  const ids = new Map<string, string>()
  const known = await q(tx)
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
  for (const c of known) ids.set(c.name.trim().toLowerCase(), c.id)

  for (const row of rows) {
    if (row.category === null || ids.has(row.category.toLowerCase())) continue
    // Derived, as an imported product is, so two tills importing one file make one category.
    const derived = await derivedId('categories', 'import', row.category.toLowerCase())
    const [taken] = await q(tx).select({ id: schema.categories.id }).from(schema.categories)
      .where(eq(schema.categories.id, derived))
    const id = taken ? newId() : derived
    await q(tx).insert(schema.categories).values({ id, name: row.category, createdAt: now, updatedAt: now })
    await writeAudit(tx, ctx, {
      entity: 'categories', entityId: id, action: 'create',
      after: { name: row.category, source: 'csv import' },
    })
    ids.set(row.category.toLowerCase(), id)
  }

  return (name) => ids.get(name.toLowerCase()) as string
}

/**
 * The id an imported product is created under.
 *
 * Derived from what the row is -- its barcode and name, or its name where it
 * has no barcode (the name too since 069, when one code may be two items) -- so two tills importing the same file while apart create the same product
 * rather than two, which the merge then joins into one. A random id would give
 * the shop every item twice, and nothing would refuse it: `code` is empty on
 * an import, so no UNIQUE is there to notice.
 *
 * A hint and not a key. A name can be changed; if something already holds the
 * derived id here -- an item renamed and then imported again -- the row gets a
 * fresh one instead of failing the whole import on a primary key.
 */
export async function importedProductId(tx: SqlDriver, barcode: string | null, name: string): Promise<string> {
  const named = name.trim().toLowerCase()
  const id = barcode?.trim()
    ? await derivedId('products', 'import', barcode.trim(), named)
    : await derivedId('products', 'import', named)
  const [taken] = await q(tx).select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, id))
  return taken ? newId() : id
}
