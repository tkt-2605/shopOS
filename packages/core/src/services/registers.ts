import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { assertDeletable } from '../integrity/links.js'
import { getSetting } from './bootstrap.js'

/**
 * A shop can run several counters. Each gets its own prefix, because that prefix
 * is what keeps two tills billing at the same moment from minting the same
 * invoice number — a globally sequential counter cannot survive a second till.
 */

export interface Register {
  id: string
  name: string
  prefix: string
  isActive: boolean
  hasOpenSession: boolean
}

export async function listRegisters(db: SqlDriver, includeInactive = false): Promise<Register[]> {
  const rows = await db.query<{ id: string; name: string; prefix: string; is_active: number; open_count: number }>(
    `SELECT r.id, r.name, r.prefix, r.is_active,
            (SELECT COUNT(*) FROM cash_sessions s WHERE s.register_id = r.id AND s.closed_at IS NULL) AS open_count
       FROM registers r
      ${includeInactive ? '' : 'WHERE r.is_active = 1'}
      ORDER BY r.name`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    isActive: r.is_active === 1,
    hasOpenSession: r.open_count > 0,
  }))
}

export type RegisterResult =
  | { ok: true; registerId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'PREFIX_TAKEN'; prefix: string }
  | { ok: false; code: 'BAD_PREFIX' }

const PREFIX = /^[A-Z0-9]{2,6}$/

export async function createRegister(
  db: SqlDriver,
  input: { name: string; prefix: string; actorId: string },
): Promise<RegisterResult> {
  const name = input.name.trim()
  const prefix = input.prefix.trim().toUpperCase()

  if (!PREFIX.test(prefix)) return { ok: false, code: 'BAD_PREFIX' }
  if (await exists(db, 'name', name)) return { ok: false, code: 'NAME_TAKEN' }
  if (await exists(db, 'prefix', prefix)) return { ok: false, code: 'PREFIX_TAKEN', prefix }

  const id = newId()
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO registers (id, name, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [id, name, prefix, now, now],
    )
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: id, action: 'create', after: { name, prefix },
    })
  })

  return { ok: true, registerId: id }
}

export async function renameRegister(
  db: SqlDriver,
  input: { registerId: string; name: string; actorId: string },
): Promise<RegisterResult> {
  const name = input.name.trim()
  if (await exists(db, 'name', name, input.registerId)) return { ok: false, code: 'NAME_TAKEN' }

  const before = await db.get<{ name: string }>(`SELECT name FROM registers WHERE id = ?`, [input.registerId])
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE registers SET name = ?, updated_at = ? WHERE id = ?`,
      [name, new Date().toISOString(), input.registerId])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: input.registerId, action: 'update',
      before: { name: before?.name ?? null }, after: { name },
    })
  })
  return { ok: true, registerId: input.registerId }
}

/**
 * The prefix is never editable once bills carry it — changing it would make two
 * different counters share a number series in the history.
 */
export async function setRegisterActive(
  db: SqlDriver,
  input: { registerId: string; isActive: boolean; actorId: string },
): Promise<{ ok: true } | { ok: false; code: 'HAS_OPEN_SESSION' }> {
  if (!input.isActive) {
    const open = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM cash_sessions WHERE register_id = ? AND closed_at IS NULL`,
      [input.registerId],
    )
    if ((open?.n ?? 0) > 0) return { ok: false, code: 'HAS_OPEN_SESSION' }
  }

  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE registers SET is_active = ?, updated_at = ? WHERE id = ?`,
      [input.isActive ? 1 : 0, new Date().toISOString(), input.registerId])
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: input.registerId, action: 'update',
      after: { is_active: input.isActive ? 1 : 0 },
    })
  })
  return { ok: true }
}

export async function deleteRegister(db: SqlDriver, registerId: string): Promise<void> {
  await assertDeletable(db, 'registers', registerId)
  await db.execute(`DELETE FROM registers WHERE id = ?`, [registerId])
}

/**
 * Which counter this machine bills on, given the choice the machine itself
 * remembers.
 *
 * The choice is **not** stored here, and that is the point. It used to live in
 * `settings` under `device_register_id` — a table the whole shop shares — so two
 * tills on one database would both claim the same counter, overwrite each
 * other's answer, and then mint the same invoice numbers. The comment above this
 * function said it "must never travel with the data when sync arrives" for as
 * long as it did exactly that. It lives in `device.json` beside the database now
 * (`src-tauri/src/device.rs`), which no backup carries and no restore replaces.
 *
 * What stays here is the part that is a question about the database rather than
 * about the machine: whether that counter still exists and is still open for
 * business, and which to fall back to when it is not.
 */
export async function resolveDeviceRegister(
  db: SqlDriver,
  chosen: string | null,
): Promise<string | null> {
  if (chosen) {
    const live = await db.get<{ id: string }>(
      `SELECT id FROM registers WHERE id = ? AND is_active = 1`, [chosen],
    )
    if (live) return live.id
  }
  const fallback = await db.get<{ id: string }>(
    `SELECT id FROM registers WHERE is_active = 1 ORDER BY rowid LIMIT 1`,
  )
  return fallback?.id ?? null
}

const LEGACY_DEVICE_REGISTER = 'device_register_id'

/**
 * Takes the old shared setting off the database and hands it back, once.
 *
 * Every shop already running has a `device_register_id` row, and on a single
 * till it holds the right answer — so it is moved rather than discarded, and the
 * machine keeps billing on the counter it was billing on yesterday. Reading and
 * deleting happen in one transaction so a crash between them cannot leave the
 * value in both places, which is the state where a second till would later pick
 * up the first one's counter.
 */
export async function takeLegacyDeviceRegister(db: SqlDriver): Promise<string | null> {
  return db.transaction(async (tx) => {
    const chosen = await getSetting(tx, LEGACY_DEVICE_REGISTER)
    if (chosen !== null) {
      await tx.execute(`DELETE FROM settings WHERE key = ?`, [LEGACY_DEVICE_REGISTER])
    }
    return chosen
  })
}

async function exists(db: SqlDriver, column: 'name' | 'prefix', value: string, exceptId?: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM registers WHERE ${column} = ? AND (? IS NULL OR id <> ?)`,
    [value, exceptId ?? null, exceptId ?? ''],
  )
  return row !== undefined
}
