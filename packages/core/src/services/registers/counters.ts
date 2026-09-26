import { eq, ne, and, isNull, count } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import { writeAudit } from '../../integrity/audit.js'

/*
 * The counters a shop has: listed, added, renamed, switched off.
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
