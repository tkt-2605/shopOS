import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SqlDriver } from '@shopos/core'

/*
 * A shop's data on its way to support, in parts, and its deletion.
 *
 * The line at a shop is poor and the file is tens of megabytes, so it comes
 * in parts and a broken upload carries on where it stopped: asking to start
 * the same file again (same till, same SHA-256) answers with the upload
 * already under way and how much of it has arrived. A part that does not
 * start where the last ended is answered with where to start.
 *
 * The portal never sees inside: the file is sealed to the vendor's key on
 * the till. It checks only that what arrived is what the till said it sent.
 */

/** Kept this long after it arrives, then deleted. Told to the owner before they send. */
export const KEEP_DAYS = 30
/** An upload abandoned part of the way is deleted after this. */
export const ABANDONED_DAYS = 7
/** Larger than any shop's database, compressed, is likely to be. */
export const MAX_BYTES = 1024 * 1024 * 1024

export interface Upload {
  id: string
  shopId: string
  deviceId: string
  createdAt: string
  bytes: number
  sha256: string
  received: number
  completedAt: string | null
  deleteAfter: string
  deletedAt: string | null
  anonymised: boolean
  note: string | null
}

const COLUMNS = `id, shop_id AS shopId, device_id AS deviceId, created_at AS createdAt, bytes, sha256, received,
  completed_at AS completedAt, delete_after AS deleteAfter, deleted_at AS deletedAt, anonymised, note`

function fileOf(dir: string, id: string): string {
  return join(dir, `${id}.sod`)
}

function shaped(row: Upload | undefined): Upload | null {
  return row === undefined ? null : { ...row, anonymised: Boolean(row.anonymised) }
}

export async function startUpload(
  db: SqlDriver,
  dir: string,
  input: { shopId: string; deviceId: string; bytes: number; sha256: string; anonymised: boolean; note: string | null; now: Date },
): Promise<Upload> {
  const under = shaped(await db.get<Upload>(
    `SELECT ${COLUMNS} FROM data_uploads
      WHERE shop_id = ? AND device_id = ? AND sha256 = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [input.shopId, input.deviceId, input.sha256],
  ))
  if (under !== null) return under

  const id = randomBytes(16).toString('hex')
  const deleteAfter = new Date(input.now.getTime() + ABANDONED_DAYS * 86_400_000).toISOString()
  mkdirSync(dir, { recursive: true })
  writeFileSync(fileOf(dir, id), Buffer.alloc(0))
  await db.execute(
    `INSERT INTO data_uploads (id, shop_id, device_id, created_at, bytes, sha256, received, delete_after, anonymised, note)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, input.shopId, input.deviceId, input.now.toISOString(), input.bytes, input.sha256, deleteAfter,
      input.anonymised ? 1 : 0, input.note],
  )
  return (await uploadById(db, id))!
}

export async function uploadById(db: SqlDriver, id: string): Promise<Upload | null> {
  return shaped(await db.get<Upload>(`SELECT ${COLUMNS} FROM data_uploads WHERE id = ?`, [id]))
}

export type PartResult =
  | { ok: true; upload: Upload }
  | { ok: false; code: 'WRONG_OFFSET' | 'TOO_LONG' | 'GONE'; received: number }
  | { ok: false; code: 'NOT_WHAT_WAS_SENT'; received: 0 }

export async function addPart(
  db: SqlDriver, dir: string, upload: Upload, input: { offset: number; data: Buffer; now: Date },
): Promise<PartResult> {
  if (upload.deletedAt !== null) return { ok: false, code: 'GONE', received: 0 }
  if (upload.completedAt !== null) return { ok: true, upload }
  /* The file on disk is the truth about what has arrived: a part written
     whose row update was lost is still there, and is counted. */
  const file = fileOf(dir, upload.id)
  const onDisk = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (input.offset !== onDisk) return { ok: false, code: 'WRONG_OFFSET', received: onDisk }
  if (onDisk + input.data.length > upload.bytes) return { ok: false, code: 'TOO_LONG', received: onDisk }

  appendFileSync(file, input.data)
  const received = onDisk + input.data.length
  let completedAt: string | null = null
  let deleteAfter = upload.deleteAfter

  if (received === upload.bytes) {
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (sha !== upload.sha256) {
      // Something changed on the way. Start again from nothing rather than keep a file nobody can open.
      truncateSync(file, 0)
      await db.execute('UPDATE data_uploads SET received = 0 WHERE id = ?', [upload.id])
      return { ok: false, code: 'NOT_WHAT_WAS_SENT', received: 0 }
    }
    completedAt = input.now.toISOString()
    deleteAfter = new Date(input.now.getTime() + KEEP_DAYS * 86_400_000).toISOString()
  }

  await db.execute(
    'UPDATE data_uploads SET received = ?, completed_at = ?, delete_after = ? WHERE id = ?',
    [received, completedAt, deleteAfter, upload.id],
  )
  return { ok: true, upload: (await uploadById(db, upload.id))! }
}

export async function uploadsOf(db: SqlDriver, shopId: string): Promise<Upload[]> {
  const rows = await db.query<Upload>(`SELECT ${COLUMNS} FROM data_uploads WHERE shop_id = ? ORDER BY created_at DESC`, [shopId])
  return rows.map((r) => shaped(r)!)
}

export function readUpload(dir: string, id: string): Buffer {
  return readFileSync(fileOf(dir, id))
}

/** Deletes every file past its date. The row stays, marked deleted. Returns how many went. */
export async function sweepUploads(db: SqlDriver, dir: string, now: Date): Promise<number> {
  const due = await db.query<{ id: string; shop_id: string }>(
    'SELECT id, shop_id FROM data_uploads WHERE deleted_at IS NULL AND delete_after <= ?', [now.toISOString()],
  )
  for (const row of due) {
    rmSync(fileOf(dir, row.id), { force: true })
    await db.execute('UPDATE data_uploads SET deleted_at = ? WHERE id = ?', [now.toISOString(), row.id])
    await db.execute(
      'INSERT INTO support_log (id, at, account_id, action, shop_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [randomBytes(16).toString('hex'), now.toISOString(), 'system', 'data_deleted', row.shop_id, row.id],
    )
  }
  return due.length
}
