import type { SqlDriver } from '../db/driver.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

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
  const before = await db.get<{ is_active: number; name: string }>(
    `SELECT is_active, name FROM products WHERE id = ?`,
    [productId],
  )
  if (!before) throw new Error(`unknown product: ${productId}`)
  if ((before.is_active === 1) === isActive) return

  const now = ctx.now?.() ?? new Date().toISOString()

  await db.transaction(async (tx) => {
    /* `rev` is bumped by the trigger from migration 019, which is what carries
       this to the other till: a product retired on the back-office machine has
       to stop appearing on the counter's search, and that is a sync, not a
       local preference. */
    await tx.execute(
      `UPDATE products SET is_active = ?, updated_at = ? WHERE id = ?`,
      [isActive ? 1 : 0, now, productId],
    )
    await writeAudit(tx, ctx, {
      entity: 'products',
      entityId: productId,
      action: 'update',
      before: { 'Sold here': before.is_active === 1 ? 'yes' : 'retired' },
      after: { 'Sold here': isActive ? 'yes' : 'retired' },
    })
  })
}
