import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit, type AuditContext } from '../integrity/audit.js'

/**
 * Photographs and documents kept against a bill, a stock entry, a customer or a
 * product.
 *
 * The rows live here; the bytes live on disk under the attachments root, named
 * by their own hash. That split is deliberate. A photograph inside the database
 * would be copied by every VACUUM INTO and carried by every backup whether or
 * not anything still pointed at it, and the driver at the Tauri boundary cannot
 * bind a byte array at all.
 *
 * Content addressing does the deduplicating for free: the same UPI screenshot
 * pasted onto two bills is one file, and a backup collects each file once no
 * matter how many documents cite it.
 */

export const ATTACHMENT_ENTITIES = ['bill', 'stock_entry', 'customer', 'product'] as const
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number]

/**
 * What the counter is allowed to attach.
 *
 * An allow-list rather than a block-list, and photographs plus PDF rather than
 * anything: this is a shop's evidence folder, not a file share. The boundary in
 * Rust checks the bytes themselves — a name and a declared type are only what
 * the webview claims.
 */
export const ACCEPTED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
] as const

/** Ten megabytes. A phone photograph is two; a scan of an invoice is under one. */
export const MAX_BYTES = 10 * 1024 * 1024

export interface StoredFile {
  fileName: string
  mime: string
  sizeBytes: number
  sha256: string
  /** Relative to the attachments root, which only the Rust side knows. */
  storedPath: string
}

export interface Attachment extends StoredFile {
  id: string
  entity: AttachmentEntity
  entityId: string
  caption: string | null
  createdBy: string
  createdAt: string
}

interface Row {
  id: string; entity: string; entity_id: string; file_name: string; stored_path: string
  mime: string; size_bytes: number; sha256: string; caption: string | null
  created_by: string; created_at: string
}

const toAttachment = (r: Row): Attachment => ({
  id: r.id,
  entity: r.entity as AttachmentEntity,
  entityId: r.entity_id,
  fileName: r.file_name,
  storedPath: r.stored_path,
  mime: r.mime,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  caption: r.caption,
  createdBy: r.created_by,
  createdAt: r.created_at,
})

const SELECT = `SELECT id, entity, entity_id, file_name, stored_path, mime, size_bytes,
                       sha256, caption, created_by, created_at
                  FROM attachments`

export async function listAttachments(
  db: SqlDriver,
  entity: AttachmentEntity,
  entityId: string,
): Promise<Attachment[]> {
  const rows = await db.query<Row>(
    `${SELECT} WHERE entity = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    [entity, entityId],
  )
  return rows.map(toAttachment)
}

export async function countAttachments(
  db: SqlDriver,
  entity: AttachmentEntity,
  entityIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (entityIds.length === 0) return counts

  const holes = entityIds.map(() => '?').join(', ')
  const rows = await db.query<{ entity_id: string; n: number }>(
    `SELECT entity_id, COUNT(*) AS n FROM attachments
      WHERE entity = ? AND entity_id IN (${holes}) AND deleted_at IS NULL
      GROUP BY entity_id`,
    [entity, ...entityIds],
  )
  for (const row of rows) counts.set(row.entity_id, row.n)
  return counts
}

export interface AttachInput {
  entity: AttachmentEntity
  entityId: string
  file: StoredFile
  caption?: string | null
}

/**
 * Records a file that is already on disk.
 *
 * The bytes are written first and the row second, on purpose. The other order
 * would give a document a photograph that is not there; this order can at worst
 * leave a file nothing points at, which costs disk and nothing else.
 */
export async function recordAttachment(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  input: AttachInput,
): Promise<Attachment> {
  if (input.file.sizeBytes > MAX_BYTES) {
    throw new Error('That file is larger than ShopOS will keep against a document.')
  }

  const id = newId()
  const now = (ctx.now ?? (() => new Date().toISOString()))()
  const row: Row = {
    id,
    entity: input.entity,
    entity_id: input.entityId,
    file_name: input.file.fileName,
    stored_path: input.file.storedPath,
    mime: input.file.mime,
    size_bytes: input.file.sizeBytes,
    sha256: input.file.sha256,
    caption: input.caption?.trim() || null,
    created_by: ctx.actorId,
    created_at: now,
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO attachments
         (id, entity, entity_id, file_name, stored_path, mime, size_bytes, sha256,
          caption, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.entity, row.entity_id, row.file_name, row.stored_path, row.mime,
        row.size_bytes, row.sha256, row.caption, row.created_by, row.created_at,
      ],
    )
    await writeAudit(tx, ctx, {
      entity: 'attachments',
      entityId: id,
      action: 'create',
      after: { entity: row.entity, entity_id: row.entity_id, file_name: row.file_name, sha256: row.sha256 },
    })
  })

  return toAttachment(row)
}

export interface RemovalResult {
  /**
   * The file to delete from disk, or null when another document still cites the
   * same bytes. Returned rather than acted on because this package never touches
   * the filesystem — deleting is the caller's move, after the row is gone.
   */
  orphaned: string | null
}

export async function removeAttachment(
  db: SqlDriver,
  ctx: AuditContext & { actorId: string },
  id: string,
): Promise<RemovalResult> {
  const row = await db.get<Row>(`${SELECT} WHERE id = ? AND deleted_at IS NULL`, [id])
  if (!row) return { orphaned: null }

  const now = (ctx.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    await tx.execute(`UPDATE attachments SET deleted_at = ?, rev = rev + 1 WHERE id = ?`, [now, id])
    await writeAudit(tx, ctx, {
      entity: 'attachments',
      entityId: id,
      action: 'delete',
      before: { entity: row.entity, entity_id: row.entity_id, file_name: row.file_name, sha256: row.sha256 },
    })

    // Asked inside the same transaction as the delete, so two attachments of the
    // same photograph removed at once cannot both decide the file is theirs to
    // take with them.
    const still = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments WHERE stored_path = ? AND deleted_at IS NULL`,
      [row.stored_path],
    )
    return { orphaned: (still?.n ?? 0) === 0 ? row.stored_path : null }
  })
}

export interface CarriedFile {
  storedPath: string
  sha256: string
  sizeBytes: number
}

/**
 * The files a backup taken now has to carry: every attachment recorded within
 * the window, each named once however many documents cite it.
 *
 * The window is the answer to a growth problem that has no good silent fix.
 * Every archive holds the whole database, always — bills, stock and money cannot
 * be reconstructed from anywhere else. A nine-month-old photograph of a supplier
 * invoice is corroborating evidence, a different order of loss, and it stays on
 * disk under the attachments root whether or not a zip carries it.
 */
export async function attachmentsToCarry(
  db: SqlDriver,
  now: Date,
  windowDays: number,
): Promise<CarriedFile[]> {
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const rows = await db.query<{ stored_path: string; sha256: string; size_bytes: number }>(
    `SELECT stored_path, sha256, MAX(size_bytes) AS size_bytes
       FROM attachments
      WHERE deleted_at IS NULL AND created_at >= ?
      GROUP BY stored_path, sha256
      ORDER BY stored_path`,
    [cutoff],
  )
  return rows.map((r) => ({ storedPath: r.stored_path, sha256: r.sha256, sizeBytes: r.size_bytes }))
}

/** Default window, in days. A setting later; a number the code agrees on now. */
export const CARRY_WINDOW_DAYS = 90
