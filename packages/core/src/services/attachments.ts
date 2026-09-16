import { eq, and, inArray, isNull, count, max, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
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

/** The columns an attachment is read back by, in one place for both readers. */
const attachmentShape = {
  id: schema.attachments.id,
  entity: schema.attachments.entity,
  entityId: schema.attachments.entityId,
  fileName: schema.attachments.fileName,
  storedPath: schema.attachments.storedPath,
  mime: schema.attachments.mime,
  sizeBytes: schema.attachments.sizeBytes,
  sha256: schema.attachments.sha256,
  caption: schema.attachments.caption,
  createdBy: schema.attachments.createdBy,
  createdAt: schema.attachments.createdAt,
}

type Row = Omit<Attachment, 'entity'> & { entity: string }

/* `entity` is text in the database. The four this build knows are in
   `ATTACHMENT_ENTITIES`, and a row naming a fifth -- written by a later build,
   or by a till that has one -- is handed back as it was read rather than
   refused: what the caller does with it is show a file that exists. */
const toAttachment = (r: Row): Attachment => ({ ...r, entity: r.entity as AttachmentEntity })

export async function listAttachments(
  db: SqlDriver,
  entity: AttachmentEntity,
  entityId: string,
): Promise<Attachment[]> {
  const rows = await q(db)
    .select(attachmentShape)
    .from(schema.attachments)
    .where(and(
      eq(schema.attachments.entity, entity),
      eq(schema.attachments.entityId, entityId),
      isNull(schema.attachments.deletedAt),
    ))
    .orderBy(schema.attachments.createdAt, schema.attachments.id)
  return rows.map(toAttachment)
}

export async function countAttachments(
  db: SqlDriver,
  entity: AttachmentEntity,
  entityIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (entityIds.length === 0) return counts

  const rows = await q(db)
    .select({ entityId: schema.attachments.entityId, n: count() })
    .from(schema.attachments)
    .where(and(
      eq(schema.attachments.entity, entity),
      inArray(schema.attachments.entityId, entityIds),
      isNull(schema.attachments.deletedAt),
    ))
    .groupBy(schema.attachments.entityId)

  for (const row of rows) counts.set(row.entityId, row.n)
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
    entityId: input.entityId,
    fileName: input.file.fileName,
    storedPath: input.file.storedPath,
    mime: input.file.mime,
    sizeBytes: input.file.sizeBytes,
    sha256: input.file.sha256,
    caption: input.caption?.trim() || null,
    createdBy: ctx.actorId,
    createdAt: now,
  }

  await db.transaction(async (tx) => {
    await q(tx).insert(schema.attachments).values(row)
    await writeAudit(tx, ctx, {
      entity: 'attachments',
      entityId: id,
      action: 'create',
      after: { entity: row.entity, entity_id: row.entityId, file_name: row.fileName, sha256: row.sha256 },
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
  const [row] = await q(db)
    .select(attachmentShape)
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, id), isNull(schema.attachments.deletedAt)))
  if (!row) return { orphaned: null }

  const now = (ctx.now ?? (() => new Date().toISOString()))()

  return db.transaction(async (tx) => {
    await q(tx).update(schema.attachments)
      .set({ deletedAt: now, rev: sql`${schema.attachments.rev} + 1` })
      .where(eq(schema.attachments.id, id))
    await writeAudit(tx, ctx, {
      entity: 'attachments',
      entityId: id,
      action: 'delete',
      before: { entity: row.entity, entity_id: row.entityId, file_name: row.fileName, sha256: row.sha256 },
    })

    // Asked inside the same transaction as the delete, so two attachments of the
    // same photograph removed at once cannot both decide the file is theirs to
    // take with them.
    const [still] = await q(tx)
      .select({ n: count() })
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.storedPath, row.storedPath),
        isNull(schema.attachments.deletedAt),
      ))
    return { orphaned: (still?.n ?? 0) === 0 ? row.storedPath : null }
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
  const rows = await q(db)
    .select({
      storedPath: schema.attachments.storedPath,
      sha256: schema.attachments.sha256,
      /* The same bytes are one file however many documents cite them, so the
         group is the path and the hash. `MAX` picks the size off one of the
         rows in the group -- they agree, because the hash does. */
      sizeBytes: max(schema.attachments.sizeBytes),
    })
    .from(schema.attachments)
    .where(and(
      isNull(schema.attachments.deletedAt),
      sql`${schema.attachments.createdAt} >= ${cutoff}`,
    ))
    .groupBy(schema.attachments.storedPath, schema.attachments.sha256)
    .orderBy(schema.attachments.storedPath)

  return rows.map((r) => ({ ...r, sizeBytes: r.sizeBytes ?? 0 }))
}

/** Default window, in days. A setting later; a number the code agrees on now. */
export const CARRY_WINDOW_DAYS = 90
