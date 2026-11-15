import { eq, and, isNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { followFamily } from './variants.js'

/**
 * A catalogue file's families: the `variantof` and `variant` columns, which
 * say a row is a variant of another item (`variants.ts`) and what kind.
 *
 * Kept out of `import.ts`, which matches and writes rows, because a family is
 * a link between rows: it can only be checked once every row is read, and only
 * made once every row is written.
 */

/** The cells a family needs, as `planImport` reads them. */
export interface FamilyCells { line: number; name: string; variantOf: string | null; variant: string | null }

/**
 * Lines whose family is in neither the shop nor the file, or that name a
 * family without saying which kind they are. A family can be one level only,
 * so a family that is itself a variant in the file is refused too.
 */
export function familyProblems(
  rows: readonly FamilyCells[], shopItems: readonly { name: string; parentProductId: string | null }[],
): Map<number, 'NO_FAMILY' | 'NO_VARIANT'> {
  const tops = new Set(shopItems.filter((p) => p.parentProductId === null).map((p) => p.name.trim().toLowerCase()))
  for (const r of rows) if (r.variantOf === null) tops.add(r.name.toLowerCase())
  const variantsInFile = new Set(rows.filter((r) => r.variantOf !== null).map((r) => r.name.toLowerCase()))
  const problems = new Map<number, 'NO_FAMILY' | 'NO_VARIANT'>()
  for (const r of rows) {
    if (r.variantOf === null) continue
    const family = r.variantOf.toLowerCase()
    if (r.variant === null) problems.set(r.line, 'NO_VARIANT')
    else if (!tops.has(family) || variantsInFile.has(family)) problems.set(r.line, 'NO_FAMILY')
  }
  return problems
}

/**
 * Puts each written row under its family, inside the import's transaction,
 * once every row is in -- so a family that is a new line in the same file is
 * already there to belong to. A variant's name follows its family's
 * (`followFamily`), so "XO pen (Blue)" comes out the same however the file
 * spelt it.
 */
export async function attachFamilies(
  tx: SqlDriver, ctx: AuditContext, rows: readonly { productId: string; variantOf: string | null; variant: string | null }[], now: string,
): Promise<void> {
  for (const row of rows) {
    if (row.variantOf === null || row.variant === null) continue
    // raw: a case-blind match on the name, which the typed builder has no word for
    const [family] = await tx.query<{ id: string }>(
      `SELECT id FROM products WHERE lower(trim(name)) = lower(trim(?)) AND parent_product_id IS NULL
         AND deleted_at IS NULL AND id <> ? ORDER BY created_at LIMIT 1`,
      [row.variantOf, row.productId],
    )
    if (!family) continue
    const [was] = await q(tx).select({ parent: schema.products.parentProductId, label: schema.products.variantLabel })
      .from(schema.products).where(eq(schema.products.id, row.productId))
    if (was?.parent === family.id && was.label === row.variant) continue
    await q(tx).update(schema.products)
      .set({ parentProductId: family.id, variantLabel: row.variant, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
      .where(and(eq(schema.products.id, row.productId), isNull(schema.products.deletedAt)))
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: row.productId, action: 'update',
      before: { parent_product_id: was?.parent ?? null, variant_label: was?.label ?? null },
      after: { parent_product_id: family.id, variant_label: row.variant, source: 'csv import' },
    })
    await followFamily(tx, ctx, row.productId)
  }
}
