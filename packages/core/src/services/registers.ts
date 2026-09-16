import { eq, ne, and, isNull, count, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { writeAudit } from '../integrity/audit.js'
import { assertDeletable } from '../integrity/links.js'
import { getSetting, forgetSetting } from './bootstrap.js'

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
  const rows = await q(db)
    .select({
      id: schema.registers.id,
      name: schema.registers.name,
      prefix: schema.registers.prefix,
      isActive: schema.registers.isActive,
      /* A left join and a count rather than a subquery. The join carries "not
         closed" in its own condition: in `where` it would turn the left join
         into an inner one and drop every counter that is not open, which is
         every counter before the shop opens. */
      openSessions: count(schema.cashSessions.id),
    })
    .from(schema.registers)
    .leftJoin(schema.cashSessions, and(
      eq(schema.cashSessions.registerId, schema.registers.id),
      isNull(schema.cashSessions.closedAt),
    ))
    .where(and(...(includeInactive ? [] : [eq(schema.registers.isActive, 1)])))
    .groupBy(schema.registers.id)
    .orderBy(schema.registers.name)

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    isActive: r.isActive === 1,
    hasOpenSession: r.openSessions > 0,
  }))
}

export type RegisterResult =
  | { ok: true; registerId: string }
  | { ok: false; code: 'NAME_TAKEN' }
  | { ok: false; code: 'PREFIX_TAKEN'; prefix: string }
  | { ok: false; code: 'BAD_PREFIX' }

/**
 * Four characters, not six, and the limit is legal rather than aesthetic.
 *
 * A document number is `B` + prefix + `/2627/00001`, and Rule 46(b) caps the
 * whole thing at sixteen. Six characters put it at eighteen. See `numbering.ts`.
 *
 * A register that already has a longer prefix keeps it — it is stamped on every
 * bill printed against it and cannot be rewritten — so this stops new ones
 * rather than repairing old ones.
 */
const PREFIX = /^[A-Z0-9]{2,4}$/

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
    await q(tx).insert(schema.registers)
      .values({ id, name, prefix, createdAt: now, updatedAt: now })
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

  const [before] = await q(db)
    .select({ name: schema.registers.name })
    .from(schema.registers)
    .where(eq(schema.registers.id, input.registerId))

  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(schema.registers.id, input.registerId))
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
    const [open] = await q(db)
      .select({ n: count() })
      .from(schema.cashSessions)
      .where(and(
        eq(schema.cashSessions.registerId, input.registerId),
        isNull(schema.cashSessions.closedAt),
      ))
    if ((open?.n ?? 0) > 0) return { ok: false, code: 'HAS_OPEN_SESSION' }
  }

  await db.transaction(async (tx) => {
    await q(tx).update(schema.registers)
      .set({ isActive: input.isActive ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(schema.registers.id, input.registerId))
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'registers', entityId: input.registerId, action: 'update',
      after: { is_active: input.isActive ? 1 : 0 },
    })
  })
  return { ok: true }
}

export async function deleteRegister(db: SqlDriver, registerId: string): Promise<void> {
  await assertDeletable(db, 'registers', registerId)
  await q(db).delete(schema.registers).where(eq(schema.registers.id, registerId))
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
    const [live] = await q(db)
      .select({ id: schema.registers.id })
      .from(schema.registers)
      .where(and(eq(schema.registers.id, chosen), eq(schema.registers.isActive, 1)))
    if (live) return live.id
  }

  const [fallback] = await q(db)
    .select({ id: schema.registers.id })
    .from(schema.registers)
    .where(eq(schema.registers.isActive, 1))
    /* raw: `rowid`, which is not a column and so is not in the schema. The
       order it gives is the order the counters were created in, which is what
       makes the fallback the shop's first counter rather than an arbitrary
       one. */
    .orderBy(sql`rowid`)
    .limit(1)
  return fallback?.id ?? null
}

const LEGACY_DEVICE_REGISTER = 'device_register_id'

/**
 * The counter a shop already running had chosen, from the shared row it used to
 * be kept in.
 *
 * Reading and forgetting are two functions rather than one on purpose. The value
 * has to reach `device.json` before this row is removed, and that write can
 * fail — see `deviceSettings.ts`. A single take-and-delete looked tidier and
 * lost the answer whenever the file could not be written.
 */
export async function legacyDeviceRegister(db: SqlDriver): Promise<string | null> {
  return getSetting(db, LEGACY_DEVICE_REGISTER)
}

/** Called only once the machine has recorded the counter as its own. */
export async function forgetLegacyDeviceRegister(db: SqlDriver): Promise<void> {
  await forgetSetting(db, LEGACY_DEVICE_REGISTER)
}

async function exists(db: SqlDriver, column: 'name' | 'prefix', value: string, exceptId?: string): Promise<boolean> {
  /* The column was interpolated into the SQL by name. It is picked from the
     table here instead, so a third caller cannot pass a string that is not a
     column of `registers`. */
  const [row] = await q(db)
    .select({ id: schema.registers.id })
    .from(schema.registers)
    .where(and(
      eq(schema.registers[column], value),
      ...(exceptId === undefined ? [] : [ne(schema.registers.id, exceptId)]),
    ))
  return row !== undefined
}
