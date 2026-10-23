import { eq, and, or, like, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { qty, QTY_SCALE, type Qty } from '../../quantity.js'
import { isOn } from '../../services/features.js'

/**
 * The parent a variant hangs off, and the item's own barcodes.
 *
 * Both are the products table and the barcodes table joined to themselves or to
 * products a second time, so they need names of their own -- without them the
 * join condition would compare a column to itself.
 */
const parent = alias(schema.products, 'parent')
const scanned = alias(schema.productBarcodes, 'pb')

/**
 * The columns every product list returns.
 *
 * Three queries used to carry the same twenty-three lines of SELECT written out
 * three times, which is three places for a column to go missing from one. The
 * joins still have to be repeated -- they differ -- but what comes back does not.
 */
const productShape = {
  id: schema.products.id,
  code: schema.products.code,
  name: schema.products.name,
  brand: schema.products.brand,
  barcode: schema.products.barcode,
  baseUnit: schema.products.baseUnit,
  baseRate: schema.products.baseRate,
  mrp: schema.products.mrp,
  taxRateBp: schema.products.taxRateBp,
  cessRateBp: schema.products.cessRateBp,
  hsnCode: schema.products.hsnCode,
  isStockTracked: schema.products.isStockTracked,
  isActive: schema.products.isActive,
  discountBlocked: schema.products.discountBlocked,
  loyaltyBlocked: schema.products.loyaltyBlocked,
  returnBlocked: schema.products.returnBlocked,
  openPrice: schema.products.openPrice,
  costPrice: schema.products.costPrice,
  reorderLevel: schema.products.reorderLevel,
  reorderQty: schema.products.reorderQty,
  categoryId: schema.products.categoryId,
  categoryName: schema.categories.name,
  parentProductId: schema.products.parentProductId,
  parentName: parent.name,
  variantLabel: schema.products.variantLabel,
  qtyOnHand: sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
}

export interface ProductListItem {
  id: string
  code: string | null
  name: string
  brand: string | null
  barcode: string | null
  baseUnit: string
  baseRate: Money
  mrp: Money | null
  taxRateBp: number
  /** GST compensation cess, in basis points (063). */
  cessRateBp: number
  hsnCode: string | null
  isStockTracked: boolean
  /**
   * Still sold here. False means retired: hidden from the counter's search and
   * the reorder list, still on every report and every old bill.
   *
   * Returned because the one screen that shows retired products has to be able
   * to say which they are. Everywhere else filters them out in SQL and never
   * sees a false.
   */
  isActive: boolean
  qtyOnHand: Qty
  /** Margin too thin to carry a discount, or to pay loyalty points on. */
  discountBlocked: boolean
  loyaltyBlocked: boolean
  /** A recharge, a cut length, anything perishable. The return screen refuses it. */
  returnBlocked: boolean
  /**
   * The amount is typed at the counter every time, by anyone billing: a loose
   * item standing in for whatever was bundled together (068).
   */
  openPrice: boolean
  /**
   * What it costs per base unit before tax, as typed on the item (074). A
   * default for Stock In and purchase orders, never a valuation: see `costHints`.
   */
  costPrice: Money | null
  /** Null means the owner has not set one, which is not the same as zero. */
  reorderLevel: Qty | null
  reorderQty: Qty | null
  categoryId: string | null
  categoryName: string | null
  /** Set when this item is a version of another — the blue one of the pen. */
  parentProductId: string | null
  parentName: string | null
  variantLabel: string | null
  /**
   * Found because the search term is one of its barcodes. Only a search sets
   * it; two such rows are one code on two items, and the screen asks which.
   */
  scanned?: boolean
}

export interface SearchOptions {
  term?: string
  limit?: number
  offset?: number
  includeInactive?: boolean
  /** Browse one group rather than search: what a touch screen and an app need. */
  categoryId?: string
}

/**
 * An exact barcode match sorts first: the scanner is the primary input and the
 * cashier expects the scanned item, not an alphabetical near-miss.
 *
 * "Exact" means any of the item's barcodes, not just the printed one — the
 * manufacturer's EAN and the shop's own label are the same product.
 *
 * A search also matches an item's parent, so typing the pen's name offers all
 * six colours rather than only the ones whose own name repeats it, and versions
 * of the same thing sort together rather than scattering through the alphabet.
 */
export async function searchProducts(db: SqlDriver, opts: SearchOptions = {}): Promise<ProductListItem[]> {
  const term = opts.term?.trim() ?? ''
  const anywhere = `%${term}%`

  /* An empty term used to be handled by `(? = '' OR …)` -- the term bound a
     second time so SQLite could decide the rest of the condition did not
     apply. Here the condition is simply not in the list. */
  const matching = term === '' ? [] : [or(
    isNotNull(scanned.id),
    like(schema.products.name, anywhere),
    like(schema.products.brand, anywhere),
    like(schema.products.code, anywhere),
    like(parent.name, anywhere),
  )!]

  const rows = await q(db)
    .selectDistinct({ ...productShape, scanned: sql<number>`CASE WHEN ${scanned.id} IS NOT NULL THEN 1 ELSE 0 END` })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    /* The scanned barcode belongs in the join and not in the WHERE: as a left
       join it decides the sort order below without removing the items that
       were found by name. */
    .leftJoin(scanned, and(
      eq(scanned.productId, schema.products.id),
      eq(scanned.barcode, term),
      isNull(scanned.deletedAt),
    ))
    .where(and(
      isNull(schema.products.deletedAt),
      ...(opts.includeInactive ? [] : [eq(schema.products.isActive, 1)]),
      ...(opts.categoryId ? [eq(schema.products.categoryId, opts.categoryId)] : []),
      ...matching,
    ))
    .orderBy(
      sql`CASE WHEN ${scanned.id} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`COALESCE(${parent.name}, ${schema.products.name})`,
      schema.products.variantLabel,
      schema.products.name,
    )
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)

  return rows.map(({ scanned: hit, ...r }) => ({ ...toProduct(r), scanned: hit === 1 }))
}

/**
 * The items a scan found, when there is more than one to choose between.
 *
 * Null when the rows hold one barcode match or none, which is every scan of a
 * code only one item has: the caller goes on as before. Two or more is one code
 * on several items (069), and the caller shows these and lets the person pick
 * -- the order a search returns is not a choice anybody made.
 */
export function scanChoices(rows: ProductListItem[]): ProductListItem[] | null {
  const hits = rows.filter((r) => r.scanned === true)
  return hits.length > 1 ? hits : null
}

/** Products by id, for rebuilding a held bill's cart from what was saved. */
export async function productsByIds(db: SqlDriver, ids: string[]): Promise<ProductListItem[]> {
  if (ids.length === 0) return []

  const rows = await q(db)
    .select(productShape)
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    .where(and(inArray(schema.products.id, ids), isNull(schema.products.deletedAt)))

  return rows.map(toProduct)
}

/**
 * The item a scan means, when it means exactly one.
 *
 * Null for a code nobody has and for one several items share (069): handing
 * back the first of two would be choosing for the cashier. `findAllByBarcode`
 * is for a caller that can ask.
 */
export async function findByBarcode(db: SqlDriver, barcode: string): Promise<ProductListItem | null> {
  const all = await findAllByBarcode(db, barcode)
  return all.length === 1 ? all[0]! : null
}

/** Every active item a scan could mean, by name. */
export async function findAllByBarcode(db: SqlDriver, barcode: string): Promise<ProductListItem[]> {
  const rows = await q(db)
    .selectDistinct(productShape)
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    // An inner join here, unlike the search: no barcode, no answer.
    .innerJoin(scanned, and(
      eq(scanned.productId, schema.products.id),
      eq(scanned.barcode, barcode.trim()),
      isNull(scanned.deletedAt),
    ))
    .where(and(isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))
    .orderBy(schema.products.name, schema.products.baseRate)

  return rows.map(toProduct)
}

export interface SaleUnitOption {
  saleUnit: string
  baseUnits: Qty
  isDefault: boolean
  /**
   * The MRP printed on one of this unit, when the shop uses box prices (079);
   * null otherwise, and for the base unit. See `lineMrp`.
   */
  mrp: Money | null
}

export async function saleUnitsFor(db: SqlDriver, productId: string): Promise<SaleUnitOption[]> {
  const [product] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!product) return []

  const rows = await q(db)
    .select({
      saleUnit: schema.productUnits.saleUnit,
      baseUnits: schema.productUnits.baseUnits,
      isDefault: schema.productUnits.isDefault,
      mrp: schema.productUnits.mrp,
    })
    .from(schema.productUnits)
    .where(and(eq(schema.productUnits.productId, productId), isNull(schema.productUnits.deletedAt)))
    .orderBy(schema.productUnits.baseUnits)
  const own = await isOn(db, 'unitPrices')

  return [
    { saleUnit: product.baseUnit, baseUnits: qty(QTY_SCALE), isDefault: rows.every((r) => r.isDefault === 0), mrp: null },
    ...rows.map((r) => ({ saleUnit: r.saleUnit, baseUnits: r.baseUnits, isDefault: r.isDefault === 1, mrp: own ? r.mrp : null })),
  ]
}

/**
 * A row exactly as the three product queries return it.
 *
 * Derived from what a screen is given rather than written out a second time:
 * the columns are the same, and the six SQLite keeps as 0 and 1 because it has
 * no boolean are the only ones that differ.
 */
type Ticked = 'isStockTracked' | 'isActive' | 'discountBlocked' | 'loyaltyBlocked' | 'returnBlocked' | 'openPrice'
type ProductRow = Omit<ProductListItem, Ticked> & Record<Ticked, number>

/**
 * The six columns SQLite keeps as 0 and 1 because it has no boolean.
 *
 * Everything else arrives in the shape the screen wants, brands included, so
 * this is all that is left of what used to be a twenty-three line hand
 * translation from snake_case rows.
 */
function toProduct(r: ProductRow): ProductListItem {
  return {
    ...r,
    isStockTracked: r.isStockTracked === 1,
    isActive: r.isActive === 1,
    discountBlocked: r.discountBlocked === 1,
    loyaltyBlocked: r.loyaltyBlocked === 1,
    returnBlocked: r.returnBlocked === 1,
    openPrice: r.openPrice === 1,
  }
}
