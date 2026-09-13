import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

/**
 * The barcodes an item answers to.
 *
 * One product, several labels: the manufacturer's EAN on the packet, the shop's
 * own printed tag, and the one from the old packaging that is still on the
 * shelves at the back. All three have to find the same item.
 *
 * `products.barcode` stays as the primary — it is what lists show and what a
 * shelf tag is printed from — and this module is the only place that writes the
 * pair, so the two cannot drift. Everything else reads.
 */

export interface Barcode {
  id: string
  barcode: string
  label: string | null
  isPrimary: boolean
}

export interface BarcodeInput {
  barcode: string
  label?: string | null
}

export type SetBarcodesResult =
  | { ok: true; barcodes: Barcode[] }
  | { ok: false; code: 'TAKEN'; barcode: string; productId: string; productName: string }

export async function listBarcodes(db: SqlDriver, productId: string): Promise<Barcode[]> {
  const rows = await db.query<{ id: string; barcode: string; label: string | null; is_primary: number }>(
    `SELECT id, barcode, label, is_primary FROM product_barcodes
      WHERE product_id = ? ORDER BY is_primary DESC, barcode`,
    [productId],
  )
  return rows.map((r) => ({ id: r.id, barcode: r.barcode, label: r.label, isPrimary: r.is_primary === 1 }))
}

/**
 * Replaces the whole set for a product, first entry primary.
 *
 * Rewritten wholesale rather than patched line by line, because the editor hands
 * over a list and a diff of that against the database is a lot of machinery to
 * get an answer the rewrite gives for free.
 */
export async function setBarcodes(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  productId: string,
  inputs: BarcodeInput[],
): Promise<SetBarcodesResult> {
  const cleaned: BarcodeInput[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const code = input.barcode.trim()
    if (code === '' || seen.has(code)) continue
    seen.add(code)
    cleaned.push({ barcode: code, label: input.label?.trim() || null })
  }

  // Somebody else's barcode is the one error worth refusing over: a scan that
  // could mean two things is worse than a scan that means nothing.
  for (const input of cleaned) {
    const owner = await db.get<{ product_id: string; name: string }>(
      `SELECT b.product_id, p.name FROM product_barcodes b
         JOIN products p ON p.id = b.product_id
        WHERE b.barcode = ? AND b.product_id <> ?`,
      [input.barcode, productId],
    )
    if (owner) {
      return { ok: false, code: 'TAKEN', barcode: input.barcode, productId: owner.product_id, productName: owner.name }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const before = await listBarcodes(db, productId)

  await db.transaction(async (tx) => {
    await tx.execute(`DELETE FROM product_barcodes WHERE product_id = ?`, [productId])

    for (const [index, input] of cleaned.entries()) {
      await tx.execute(
        `INSERT INTO product_barcodes (id, product_id, barcode, label, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), productId, input.barcode, input.label ?? null, index === 0 ? 1 : 0, now],
      )
    }

    // The pair, written in the one place that owns it.
    await tx.execute(
      `UPDATE products SET barcode = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [cleaned[0]?.barcode ?? null, now, productId],
    )

    await writeAudit(tx, ctx, {
      entity: 'products',
      entityId: productId,
      action: 'update',
      before: { barcodes: before.map((b) => b.barcode).join(', ') || null },
      after: { barcodes: cleaned.map((b) => b.barcode).join(', ') || null },
    })
  })

  return { ok: true, barcodes: await listBarcodes(db, productId) }
}

/**
 * Which product a scan means, if any.
 *
 * Kept beside `findByBarcode` in the catalog repo rather than replacing it: this
 * answers the id, that answers the whole product row the counter needs.
 */
export async function productIdForBarcode(db: SqlDriver, barcode: string): Promise<string | null> {
  const row = await db.get<{ product_id: string }>(
    `SELECT product_id FROM product_barcodes WHERE barcode = ?`,
    [barcode.trim()],
  )
  return row?.product_id ?? null
}
