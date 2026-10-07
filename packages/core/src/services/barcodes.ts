import { eq, ne, and, desc, isNull, notInArray, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { derivedId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'

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
  const rows = await q(db)
    .select({
      id: schema.productBarcodes.id,
      barcode: schema.productBarcodes.barcode,
      label: schema.productBarcodes.label,
      isPrimary: schema.productBarcodes.isPrimary,
    })
    .from(schema.productBarcodes)
    .where(and(eq(schema.productBarcodes.productId, productId), isNull(schema.productBarcodes.deletedAt)))
    .orderBy(desc(schema.productBarcodes.isPrimary), schema.productBarcodes.barcode)

  return rows.map((r) => ({ ...r, isPrimary: r.isPrimary === 1 }))
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
  await requirePermission(db, ctx.actorId, 'product', 'write')
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
    const [owner] = await q(db)
      .select({ productId: schema.productBarcodes.productId, name: schema.products.name })
      .from(schema.productBarcodes)
      .innerJoin(schema.products, eq(schema.products.id, schema.productBarcodes.productId))
      .where(and(
        eq(schema.productBarcodes.barcode, input.barcode),
        ne(schema.productBarcodes.productId, productId),
        isNull(schema.productBarcodes.deletedAt),
      ))
    if (owner) {
      return { ok: false, code: 'TAKEN', barcode: input.barcode, productId: owner.productId, productName: owner.name }
    }
  }

  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const before = await listBarcodes(db, productId)

  await db.transaction(async (tx) => {
    /* Taken off, not deleted (056): a removal is an edit and merges like one,
       where a delete left a tombstone that a third till could outlive -- and a
       barcode brought back that way scans as an item the shop took it off. */
    const keep = cleaned.map((b) => b.barcode)
    await q(tx).update(schema.productBarcodes)
      .set({ deletedAt: now })
      .where(and(
        eq(schema.productBarcodes.productId, productId),
        isNull(schema.productBarcodes.deletedAt),
        ...(keep.length > 0 ? [notInArray(schema.productBarcodes.barcode, keep)] : []),
      ))

    for (const [index, input] of cleaned.entries()) {
      /* Derived from the code itself, which is the one thing about a barcode
         that cannot be edited into something else — a different code is a
         different barcode. The set is deleted and rewritten on every save, so
         with a minted id a barcode nobody touched came back under a new one,
         and two tills saving the same product wrote two rows for one code.
         Same id, and the feed folds the delete and the insert into one upsert. */
      /* The same code, back on this item or moved to it from one it was taken
         off: the row it always was, alive again. Found by the code rather than
         by the derived id, because rows written before ids were derived carry
         a minted one and the code is what is unique. */
      const [held] = await q(tx)
        .select({ id: schema.productBarcodes.id })
        .from(schema.productBarcodes)
        .where(eq(schema.productBarcodes.barcode, input.barcode))
      if (held) {
        await q(tx).update(schema.productBarcodes)
          .set({ productId, label: input.label ?? null, isPrimary: index === 0 ? 1 : 0, deletedAt: null })
          .where(eq(schema.productBarcodes.id, held.id))
        continue
      }
      await q(tx).insert(schema.productBarcodes).values({
        id: await derivedId('product_barcodes', input.barcode),
        productId,
        barcode: input.barcode,
        label: input.label ?? null,
        isPrimary: index === 0 ? 1 : 0,
        createdAt: now,
      })
    }

    // The pair, written in the one place that owns it.
    await q(tx).update(schema.products)
      .set({
        barcode: cleaned[0]?.barcode ?? null,
        updatedAt: now,
        rev: sql`${schema.products.rev} + 1`,
      })
      .where(eq(schema.products.id, productId))

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
 * Puts one barcode on an item as its primary, keeping the others it answers to.
 *
 * For a caller already inside a transaction that has checked the code is not
 * another item's -- the catalogue import, which plans that before it writes.
 * `setBarcodes` replaces the whole set, which from a file that carries one
 * barcode a row would take the old packaging's code off every item in it.
 */
export async function addPrimaryBarcode(
  tx: SqlDriver, productId: string, barcode: string, now: string,
): Promise<void> {
  const code = barcode.trim()
  await q(tx).update(schema.productBarcodes)
    .set({ isPrimary: 0 })
    .where(and(eq(schema.productBarcodes.productId, productId), ne(schema.productBarcodes.barcode, code)))

  // The same code, taken off this item or another earlier: its row, alive again. See `setBarcodes`.
  const [held] = await q(tx)
    .select({ id: schema.productBarcodes.id })
    .from(schema.productBarcodes)
    .where(eq(schema.productBarcodes.barcode, code))
  if (held) {
    await q(tx).update(schema.productBarcodes)
      .set({ productId, isPrimary: 1, deletedAt: null })
      .where(eq(schema.productBarcodes.id, held.id))
  } else {
    await q(tx).insert(schema.productBarcodes).values({
      id: await derivedId('product_barcodes', code),
      productId, barcode: code, isPrimary: 1, createdAt: now,
    })
  }

  await q(tx).update(schema.products)
    .set({ barcode: code, updatedAt: now, rev: sql`${schema.products.rev} + 1` })
    .where(eq(schema.products.id, productId))
}

/**
 * Which product a scan means, if any.
 *
 * Kept beside `findByBarcode` in the catalog repo rather than replacing it: this
 * answers the id, that answers the whole product row the counter needs.
 */
export async function productIdForBarcode(db: SqlDriver, barcode: string): Promise<string | null> {
  const [row] = await q(db)
    .select({ productId: schema.productBarcodes.productId })
    .from(schema.productBarcodes)
    .where(and(eq(schema.productBarcodes.barcode, barcode.trim()), isNull(schema.productBarcodes.deletedAt)))
  return row?.productId ?? null
}
