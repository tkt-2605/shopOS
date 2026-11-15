import { eq, and, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { QTY_SCALE } from '../quantity.js'
import { toCsv } from '../domain/csv.js'

/** The family a variant belongs to, joined by name for the file. */
const family = alias(schema.products, 'family')

/**
 * The catalogue as a file, in the same shape `planImport` reads.
 *
 * Round-tripping is the point: a shop exports, edits prices in Excel, and
 * imports the same file back. Every column here is one this importer
 * understands, and `csvRoundTrip.test.ts` holds that to account -- an export
 * with a column the import ignores is a column of edits that silently do
 * nothing.
 *
 * A variant (`variants.ts`) is a line of its own with its family's name in
 * `variantof` and its label in `variant`, and the family is a line too, so
 * the same file imports back into the same families. Moved out of
 * `import.ts`, which reads files, when the family columns came in.
 */
export async function exportCatalogue(db: SqlDriver): Promise<string> {
  const rows = await q(db)
    .select({
      name: schema.products.name,
      brand: schema.products.brand,
      category: schema.categories.name,
      barcode: schema.products.barcode,
      hsn: schema.products.hsnCode,
      taxRateBp: schema.products.taxRateBp,
      unit: schema.products.baseUnit,
      rate: schema.products.baseRate,
      mrp: schema.products.mrp,
      onHand: sql<number>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
      value: sql<number>`COALESCE(${schema.productStock.stockValue}, 0)`,
      variantOf: family.name,
      variant: schema.products.variantLabel,
    })
    .from(schema.products)
    // Left joined, so an item never counted or never grouped still gets a row
    // rather than vanishing from its own catalogue.
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, and(
      eq(schema.categories.id, schema.products.categoryId),
      isNull(schema.categories.deletedAt),
    ))
    .leftJoin(family, eq(family.id, schema.products.parentProductId))
    .where(and(isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))
    .orderBy(schema.products.name)

  return toCsv(
    ['name', 'brand', 'category', 'barcode', 'hsn', 'tax', 'unit', 'rate', 'mrp', 'cost', 'openingqty', 'variantof', 'variant'],
    rows.map((r) => [
      r.name,
      r.brand ?? '',
      r.category ?? '',
      r.barcode ?? '',
      r.hsn ?? '',
      // Basis points back to the percentage a person typed.
      r.taxRateBp === 0 ? '' : String(r.taxRateBp / 100),
      r.unit,
      money2(r.rate),
      r.mrp === null ? '' : money2(r.mrp),
      // What one on the shelf is valued at: derived from the value, which is what is kept.
      r.onHand > 0 ? money2(Math.round(r.value * QTY_SCALE / r.onHand) as Money) : '',
      String(r.onHand / QTY_SCALE),
      r.variantOf ?? '',
      r.variantOf === null ? '' : (r.variant ?? ''),
    ]),
  )
}

function money2(value: Money): string {
  return (value / 100).toFixed(2)
}
