import { eq } from 'drizzle-orm'
import type { SqlDriver, SqlValue } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { newId } from '../ids.js'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'
import { requirePermission } from '../integrity/permissions.js'

/**
 * Taking a product out of use without taking it out of history.
 *
 * `products.is_active` has been in the schema since 001 and read since the
 * catalogue was written — `searchProducts` filters on it, the reorder report
 * filters on it, the counter's search filters on it. Nothing has ever set it to
 * 0. The column worked perfectly and no shop could reach it.
 *
 * What a shop did instead was rename the product to "OLD - do not use", or
 * leave it there and hope. Both are worse than the thing the column was for.
 *
 * ── Retired, not deleted ──────────────────────────────────────────────────
 *
 * A product that has been sold can never be deleted. Every `bill_items` row
 * names it, and `product_name` is copied onto the line as it was at the time of
 * sale precisely so that an old bill reads correctly — but the stock ledger,
 * the margin report and the return path all still join to the product itself.
 * Deleting it would leave a shop with bills it cannot explain.
 *
 * So retiring hides it from the two places a live product belongs — the
 * counter's search and the reorder list — and changes nothing else. Reports
 * still name it, because it was sold and the sale happened. Its stock is still
 * counted, because the goods are still on the shelf until somebody says
 * otherwise. An old bill still reprints.
 *
 * ── Why it is not `deleted_at` ────────────────────────────────────────────
 *
 * `products` carries both columns. `deleted_at` on a product means "this row
 * should not have existed" and is the harder, rarer thing; `is_active` means
 * "we do not sell this any more", which is the ordinary end of a product's
 * life and the one a shopkeeper needs a button for. One concept per column,
 * and this is the one with a button.
 */
export async function setProductActive(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  isActive: boolean,
): Promise<void> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const [before] = await q(db)
    .select({ isActive: schema.products.isActive, name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!before) throw new Error(`unknown product: ${productId}`)
  if ((before.isActive === 1) === isActive) return

  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    /* `rev` is bumped by the trigger from migration 019, which is what carries
       this to the other till: a product retired on the back-office machine has
       to stop appearing on the counter's search, and that is a sync, not a
       local preference. */
    await q(tx).update(schema.products)
      .set({ isActive: isActive ? 1 : 0, updatedAt: now })
      .where(eq(schema.products.id, productId))
    await writeAudit(tx, ctx, {
      entity: 'products',
      entityId: productId,
      action: 'update',
      before: { 'Sold here': before.isActive === 1 ? 'yes' : 'retired' },
      after: { 'Sold here': isActive ? 'yes' : 'retired' },
    })
  })
}

export interface ProductDetails {
  /** Absent for a new item. */
  id?: string | null
  name: string
  brand: string | null
  hsnCode: string | null
  taxRateBp: number
  /**
   * GST compensation cess, ad valorem, in basis points. Absent leaves an item's
   * cess as it is (and a new item's at none), so a caller that predates cess
   * cannot clear one by not knowing about it.
   */
  cessRateBp?: number
  baseRate: Money
  mrp: Money | null
  /** Only read for a new item: an item's counting unit does not change under its stock. */
  baseUnit: string
  discountBlocked: boolean
  loyaltyBlocked: boolean
  returnBlocked: boolean
  isStockTracked: boolean
  /**
   * The amount is typed at the counter on every sale (068). Absent leaves an
   * item's setting as it is, and a new item's off, as cess does.
   */
  openPrice?: boolean
  /**
   * What it costs, per base unit before tax (074): a default for Stock In and
   * purchase orders, never read by valuation. Absent leaves it as it is, as
   * cess does; null clears it.
   */
  costPrice?: Money | null
  reorderLevel: Qty | null
  reorderQty: Qty | null
}

export type SaveProductResult =
  | { ok: true; productId: string; created: boolean }
  | { ok: false; code: 'NO_NAME' | 'BAD_RATE' | 'BAD_MRP' | 'BAD_COST' | 'BAD_TAX' | 'BAD_LEVEL' | 'UNKNOWN_PRODUCT' }

/**
 * An item's own details, written in one place and put on the audit trail.
 *
 * The Inventory screen used to write these with its own `INSERT` and `UPDATE`,
 * which meant the one change a shop most needs to be able to trace -- who moved
 * the selling price, from what, to what -- was the one change nothing recorded.
 * Everything else the screen saves already went through a service that audits.
 */
export async function saveProductDetails(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: ProductDetails,
): Promise<SaveProductResult> {
  await requirePermission(db, ctx.actorId, 'product', 'write')
  const name = input.name.trim()
  if (name === '') return { ok: false, code: 'NO_NAME' }
  if (!Number.isInteger(input.baseRate) || input.baseRate < 0) return { ok: false, code: 'BAD_RATE' }
  if (input.mrp !== null && (!Number.isInteger(input.mrp) || input.mrp < 0)) return { ok: false, code: 'BAD_MRP' }
  if (input.costPrice != null && (!Number.isInteger(input.costPrice) || input.costPrice < 0)) {
    return { ok: false, code: 'BAD_COST' }
  }
  if (!Number.isInteger(input.taxRateBp) || input.taxRateBp < 0 || input.taxRateBp > 10_000) {
    return { ok: false, code: 'BAD_TAX' }
  }
  // Cess runs well past GST on some goods (pan masala, gutkha), so the ceiling is 300%.
  if (input.cessRateBp !== undefined
    && (!Number.isInteger(input.cessRateBp) || input.cessRateBp < 0 || input.cessRateBp > 30_000)) {
    return { ok: false, code: 'BAD_TAX' }
  }
  for (const level of [input.reorderLevel, input.reorderQty]) {
    if (level !== null && (!Number.isInteger(level) || level < 0)) return { ok: false, code: 'BAD_LEVEL' }
  }

  const now = ctx.now?.() ?? new Date().toISOString()
  const fields = {
    name,
    brand: input.brand?.trim() || null,
    hsnCode: input.hsnCode?.trim() || null,
    taxRateBp: input.taxRateBp,
    ...(input.cessRateBp !== undefined ? { cessRateBp: input.cessRateBp } : {}),
    baseRate: input.baseRate,
    mrp: input.mrp,
    discountBlocked: input.discountBlocked ? 1 : 0,
    loyaltyBlocked: input.loyaltyBlocked ? 1 : 0,
    returnBlocked: input.returnBlocked ? 1 : 0,
    isStockTracked: input.isStockTracked ? 1 : 0,
    ...(input.openPrice !== undefined ? { openPrice: input.openPrice ? 1 : 0 } : {}),
    ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
    reorderLevel: input.reorderLevel,
    reorderQty: input.reorderQty,
  }

  return db.transaction(async (tx): Promise<SaveProductResult> => {
    if (!input.id) {
      const productId = newId()
      const costed = fields.costPrice !== undefined && fields.costPrice !== null
      await q(tx).insert(schema.products).values({
        id: productId, ...fields, baseUnit: input.baseUnit || 'piece', createdAt: now, updatedAt: now,
        ...(costed ? { costPriceAt: now } : {}),
      })
      await writeAudit(tx, ctx, {
        entity: 'products', entityId: productId, action: 'create',
        after: {
          name, base_rate: fields.baseRate, tax_rate_bp: fields.taxRateBp,
          ...(fields.openPrice === 1 ? { open_price: 1 } : {}),
          ...(costed ? { cost_price: fields.costPrice } : {}),
        },
      })
      return { ok: true, productId, created: true }
    }

    const [before] = await q(tx)
      .select({
        name: schema.products.name, baseRate: schema.products.baseRate, mrp: schema.products.mrp,
        taxRateBp: schema.products.taxRateBp, hsnCode: schema.products.hsnCode,
        cessRateBp: schema.products.cessRateBp, openPrice: schema.products.openPrice,
        costPrice: schema.products.costPrice,
      })
      .from(schema.products)
      .where(eq(schema.products.id, input.id))
    if (!before) return { ok: false, code: 'UNKNOWN_PRODUCT' }

    /* Stamped only when the figure moves, so saving the item for any other
       reason does not make an old cost price look newer than a delivery. */
    const costMoved = fields.costPrice !== undefined && fields.costPrice !== before.costPrice
    await q(tx).update(schema.products)
      .set({ ...fields, updatedAt: now, ...(costMoved ? { costPriceAt: fields.costPrice === null ? null : now } : {}) })
      .where(eq(schema.products.id, input.id))

    // Only what moved, so a history of price changes reads as one.
    const was: Record<string, SqlValue> = {}
    const is: Record<string, SqlValue> = {}
    const compare: [string, SqlValue, SqlValue][] = [
      ['name', before.name, fields.name],
      ['base_rate', before.baseRate, fields.baseRate],
      ['mrp', before.mrp, fields.mrp],
      ['tax_rate_bp', before.taxRateBp, fields.taxRateBp],
      ['cess_rate_bp', before.cessRateBp, fields.cessRateBp ?? before.cessRateBp],
      ['hsn_code', before.hsnCode, fields.hsnCode],
      // Who let any cashier price an item is as much a price change as a new rate.
      ['open_price', before.openPrice, fields.openPrice ?? before.openPrice],
      ['cost_price', before.costPrice, fields.costPrice === undefined ? before.costPrice : fields.costPrice],
    ]
    for (const [column, old, next] of compare) {
      if (old !== next) { was[column] = old; is[column] = next }
    }
    await writeAudit(tx, ctx, {
      entity: 'products', entityId: input.id, action: 'update', before: was, after: is,
    })
    return { ok: true, productId: input.id, created: false }
  })
}
