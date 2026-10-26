import { eq } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { AuditContext } from '../../integrity/audit.js'
import { recordAttachment, removeAttachment, type StoredFile } from '../attachments.js'

/*
 * The photo the storefront shows for an item.
 *
 * Two attachments to the product, made by the till from one picture when it
 * was added: about 600 pixels across for the item's page and about 200 for
 * lists, both WebP, so a phone never downloads a camera's full-size picture to
 * show a thumbnail. `product_photos` says which two they are; the item can
 * carry other attachments that are not its photo.
 *
 * The rows travel to every till; the files do not -- attachments never have.
 * The main is the till that serves photos, so the screen offers this only
 * there.
 */

export interface ProductPhoto {
  photo: { id: string; storedPath: string; sha256: string }
  thumb: { id: string; storedPath: string; sha256: string }
}

export async function productPhoto(db: SqlDriver, productId: string): Promise<ProductPhoto | null> {
  /* raw: the attachments table twice, once per size. */
  const [row] = await db.query<{
    photo_id: string; photo_path: string; photo_sha: string; thumb_id: string; thumb_path: string; thumb_sha: string
  }>(
    `SELECT big.id AS photo_id, big.stored_path AS photo_path, big.sha256 AS photo_sha,
            small.id AS thumb_id, small.stored_path AS thumb_path, small.sha256 AS thumb_sha
       FROM product_photos pp
       JOIN attachments big ON big.id = pp.photo_id AND big.deleted_at IS NULL
       JOIN attachments small ON small.id = pp.thumb_id AND small.deleted_at IS NULL
      WHERE pp.product_id = ?`,
    [productId],
  )
  if (!row) return null
  return {
    photo: { id: row.photo_id, storedPath: row.photo_path, sha256: row.photo_sha },
    thumb: { id: row.thumb_id, storedPath: row.thumb_path, sha256: row.thumb_sha },
  }
}

/**
 * Sets an item's photo from the two files the till has already stored. The
 * one it replaces is taken off; the files that leaves with nothing pointing at
 * them are returned for the caller to delete, as `removeAttachment` does.
 */
export async function setProductPhoto(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: { productId: string; photo: StoredFile; thumb: StoredFile },
): Promise<{ orphaned: string[] }> {
  const before = await productPhoto(db, input.productId)
  const photo = await recordAttachment(db, ctx, { entity: 'product', entityId: input.productId, file: input.photo, caption: 'Photo' })
  const thumb = await recordAttachment(db, ctx, { entity: 'product', entityId: input.productId, file: input.thumb, caption: 'Photo (small)' })
  const at = (ctx.now ?? (() => new Date().toISOString()))()
  await q(db).insert(schema.productPhotos)
    .values({ productId: input.productId, photoId: photo.id, thumbId: thumb.id, updatedAt: at })
    .onConflictDoUpdate({ target: schema.productPhotos.productId, set: { photoId: photo.id, thumbId: thumb.id, updatedAt: at } })
  return { orphaned: before ? await dropFiles(db, ctx, before) : [] }
}

export async function removeProductPhoto(
  db: SqlDriver, ctx: AuditContext & { actorId: string }, productId: string,
): Promise<{ orphaned: string[] }> {
  const before = await productPhoto(db, productId)
  if (!before) return { orphaned: [] }
  const orphaned = await dropFiles(db, ctx, before)
  await q(db).delete(schema.productPhotos).where(eq(schema.productPhotos.productId, productId))
  return { orphaned }
}

/**
 * Items the storefront lists that have no photo yet, by name -- so the owner
 * can work through them in one sitting.
 */
export async function listedWithoutPhoto(db: SqlDriver, categories: ReadonlySet<string>): Promise<{ id: string; name: string }[]> {
  if (categories.size === 0) return []
  const ids = [...categories]
  /* raw: "no live photo row" is a NOT EXISTS over a join of three tables. */
  return db.query<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM products p
      WHERE p.is_active = 1 AND p.open_price = 0 AND p.deleted_at IS NULL
        AND p.category_id IN (${ids.map(() => '?').join(', ')})
        AND NOT EXISTS (
          SELECT 1 FROM product_photos pp
            JOIN attachments a ON a.id = pp.thumb_id AND a.deleted_at IS NULL
           WHERE pp.product_id = p.id)
      ORDER BY p.name`,
    ids,
  )
}

async function dropFiles(db: SqlDriver, ctx: AuditContext & { actorId: string }, held: ProductPhoto): Promise<string[]> {
  const out: string[] = []
  for (const id of [held.photo.id, held.thumb.id]) {
    const { orphaned } = await removeAttachment(db, ctx, id)
    if (orphaned) out.push(orphaned)
  }
  return out
}
