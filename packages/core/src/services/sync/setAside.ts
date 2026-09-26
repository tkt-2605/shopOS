import { asc, count, eq } from 'drizzle-orm'
import type { SqlDriver, SqlValue } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { newId } from '../../ids.js'
import {
  shapeOf, type ChangeBatch, type ChangeRecord, type RecordShape,
} from '../../domain/replicaShape.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { clock } from '../../clock.js'
import { applyRecord } from './record.js'

/*
 * What happens to a record that could not land: how the merge finds one before
 * its COMMIT would refuse it, and how it comes back out once it can. Kept apart
 * from `apply.ts`, which decides when these run.
 */

/**
 * The savepoint's name.
 *
 * One constant rather than one per record: `run_execute` in the Rust driver
 * prepares statements into a small cache, and a fresh name each time would push
 * out the statements the merge actually runs on. SQLite is content to reuse a
 * name — `ROLLBACK TO` and `RELEASE` find the most recent one that carries it.
 */
export const RECORD = 'shopos_record'

/** How a record is named in `setAside`, `waiting` and the quarantine. */
export function keyOf(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`
}

/** Whether anything is waiting in quarantine at all. One indexed count. */
export async function anythingSetAside(db: SqlDriver): Promise<boolean> {
  const [row] = await q(db).select({ n: count() }).from(schema.syncQuarantine)
  return (row?.n ?? 0) > 0
}

/**
 * Tries every parked record again, and forgets the ones that now land.
 *
 * Quarantine used to be a one-way door. The cursor had already moved past the
 * record, so the sending till would only ever offer it again if somebody
 * edited that row -- and the screen's own advice, "rename one of them, then
 * sync again", left everything that had been set aside behind the renamed row
 * set aside for good.
 *
 * Each record is decided exactly as it would have been on arrival, against
 * what is here now, and from the till that sent it. A record that has since
 * been overtaken loses the merge and writes nothing, which is also an answer:
 * the row here is newer, so there is nothing left to wait for.
 *
 * A record that still points at nothing is left alone without being tried. A
 * savepoint cannot catch that -- the COMMIT would -- so trying it would fail
 * every merge on this till for as long as it waited. Swept until a sweep lands
 * nothing, so a parked parent and its parked child both come out in one merge.
 */
export async function retrySetAside(
  tx: SqlDriver,
  justSetAside: ReadonlySet<string>,
  waiting: ReadonlyMap<string, string>,
): Promise<{ recovered: ChangeRecord[] }> {
  const recovered: ChangeRecord[] = []
  const tried = new Set<string>()

  for (;;) {
    const parked = await q(tx)
      .select({
        id: schema.syncQuarantine.id,
        peerDevice: schema.syncQuarantine.peerDevice,
        table: schema.syncQuarantine.tableName,
        rowId: schema.syncQuarantine.rowId,
        record: schema.syncQuarantine.record,
      })
      .from(schema.syncQuarantine)
      .orderBy(asc(schema.syncQuarantine.at))

    let landedThisSweep = 0
    for (const entry of parked) {
      const key = keyOf(entry.table, entry.rowId)
      if (justSetAside.has(key) || waiting.has(key) || tried.has(key)) continue

      let record: ChangeRecord
      try {
        record = JSON.parse(entry.record) as ChangeRecord
      } catch {
        tried.add(key)
        continue
      }
      if (await pointsAtNothing(tx, record)) continue

      const from: ChangeBatch = {
        fromDevice: entry.peerDevice,
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        records: [record],
        upTo: 0,
        complete: true,
      }
      await tx.execute(`SAVEPOINT ${RECORD}`)
      try {
        const outcome = await applyRecord(tx, record, from, new Set())
        await tx.execute(`RELEASE ${RECORD}`)
        for (const complaint of outcome.contested) {
          await q(tx).insert(schema.syncConflicts).values({
            id: newId(),
            at: clock.iso(),
            peerDevice: entry.peerDevice,
            tableName: complaint.table,
            rowId: complaint.rowId,
            winner: complaint.winner,
            explain: complaint.explain,
          })
        }
      } catch {
        await tx.execute(`ROLLBACK TO ${RECORD}`)
        await tx.execute(`RELEASE ${RECORD}`)
        // Still refused for the reason it was set aside. Left as it was,
        // unread flag and all: nothing about it is news.
        tried.add(key)
        continue
      }
      await q(tx).delete(schema.syncQuarantine).where(eq(schema.syncQuarantine.id, entry.id))
      tried.add(key)
      recovered.push(record)
      landedThisSweep += 1
    }
    if (landedThisSweep === 0) return { recovered }
  }
}

/**
 * Whether applying this record now would leave a foreign key pointing at
 * nothing: an upsert whose parent is not here, or a delete of a row something
 * still points at. Either is only refused at COMMIT, which is too late for a
 * savepoint to help.
 */
async function pointsAtNothing(tx: SqlDriver, record: ChangeRecord): Promise<boolean> {
  const shape = shapeOf(record.table)
  if (shape === undefined) return false

  if (record.op === 'delete') {
    for (const child of await referencing(tx, shape.table)) {
      /* raw: names from `PRAGMA foreign_key_list`, never the wire. */
      const held = await tx.get(
        `SELECT 1 AS held FROM "${child.table}" WHERE "${child.from}" = ? LIMIT 1`, [record.rowId],
      )
      if (held !== undefined) return true
    }
    return false
  }

  if (record.row === null) return false
  const rows: Array<[string, Record<string, SqlValue>]> = [[shape.table, record.row]]
  for (const line of shape.lines) {
    for (const row of record.lines?.[line.table] ?? []) rows.push([line.table, row])
  }
  for (const [table, row] of rows) {
    for (const key of await foreignKeys(tx, table)) {
      const value = row[key.from]
      if (value === null || value === undefined) continue
      // A line's pointer at its own document, which is written with it.
      if (key.table === shape.table && String(value) === record.rowId) continue
      /* raw: names from `PRAGMA foreign_key_list`, never the wire. */
      const found = await tx.get(
        `SELECT 1 AS found FROM "${key.table}" WHERE "${key.to}" = ? LIMIT 1`, [value],
      )
      if (found === undefined) return true
    }
  }
  return false
}

/**
 * The records among `applied` that the COMMIT would refuse, with why.
 *
 * `PRAGMA foreign_key_check` names the row that points at nothing. That row is
 * either a record this merge wrote, or a line inside one, or it was here
 * already and a *delete* this merge applied took its parent away -- and each
 * of the three is traced back to the record responsible. A violation that
 * traces back to none of them was here before this merge, is not what would
 * fail its COMMIT, and is not this merge's to set aside.
 */
export async function orphansAmong(
  tx: SqlDriver, applied: readonly ChangeRecord[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (applied.length === 0) return found

  const known = new Set(applied.map((r) => keyOf(r.table, r.rowId)))
  const owners = new Map<string, { shape: RecordShape; column: string }>()
  const tables = new Set<string>()
  for (const record of applied) {
    const shape = shapeOf(record.table)
    if (shape === undefined) continue
    owners.set(shape.table, { shape, column: shape.key })
    tables.add(shape.table)
    for (const line of shape.lines) {
      owners.set(line.table, { shape, column: line.parentKey })
      tables.add(line.table)
    }
    if (record.op === 'delete') {
      for (const child of await referencing(tx, shape.table)) tables.add(child.table)
    }
  }

  for (const table of tables) {
    /* raw: a PRAGMA. The name is `REPLICATED`'s or `PRAGMA foreign_key_list`'s. */
    const violations = await tx.query<{ table: string; rowid: number | null; parent: string; fkid: number }>(
      `PRAGMA foreign_key_check("${table}")`,
    )
    for (const v of violations) {
      if (v.rowid === null) continue

      const owner = owners.get(v.table)
      if (owner !== undefined) {
        const row = await tx.get<{ k: SqlValue }>(
          `SELECT "${owner.column}" AS k FROM "${v.table}" WHERE rowid = ?`, [v.rowid],
        )
        const key = row === undefined ? null : keyOf(owner.shape.table, String(row.k))
        if (key !== null && known.has(key)) {
          if (!found.has(key)) found.set(key, `waiting for ${v.parent}, which has not reached this till yet`)
          continue
        }
      }

      /* Not a row this merge wrote, so perhaps a row whose parent this merge
         deleted. The pointer's value is the deleted record's id. */
      const pointer = (await foreignKeys(tx, v.table)).find((k) => k.id === v.fkid)
      if (pointer === undefined) continue
      const row = await tx.get<{ k: SqlValue }>(
        `SELECT "${pointer.from}" AS k FROM "${v.table}" WHERE rowid = ?`, [v.rowid],
      )
      if (row === undefined) continue
      const key = keyOf(v.parent, String(row.k))
      if (known.has(key) && !found.has(key)) {
        found.set(key, `${v.table} on this till still points at it, so it cannot be deleted here`)
      }
    }
  }
  return found
}


/**
 * Which foreign keys a table has, asked once per table per process.
 *
 * Cached on the driver rather than globally for `localColumns`' reason: a test
 * that opens two databases in one process must not be handed the other's shape.
 */
interface ForeignKey {
  /** SQLite's number for it, which `PRAGMA foreign_key_check` reports. */
  id: number
  from: string
  table: string
  to: string
  /** Whether deleting the parent leaves this pointing at nothing. */
  dangles: boolean
}

const keysOf = new WeakMap<SqlDriver, Map<string, ForeignKey[]>>()

async function foreignKeys(tx: SqlDriver, table: string): Promise<ForeignKey[]> {
  let tables = keysOf.get(tx)
  if (!tables) { tables = new Map(); keysOf.set(tx, tables) }

  const cached = tables.get(table)
  if (cached !== undefined) return cached

  /* raw: a PRAGMA, which a query builder has no words for. The name is
     `REPLICATED`'s and never the wire's -- see the note on `upsert` in `record.ts`. */
  const rows = await tx.query<{ id: number; from: string; table: string; to: string | null; on_delete: string }>(
    `PRAGMA foreign_key_list("${table}")`,
  )
  const keys = rows.map((r) => ({
    id: r.id,
    from: r.from,
    table: r.table,
    // Every REFERENCES in the migrations names its column; `id` is the one a
    // bare REFERENCES would mean in this schema.
    to: r.to ?? 'id',
    // CASCADE and SET NULL tidy up after themselves; RESTRICT refuses at the
    // statement, where a savepoint catches it. NO ACTION waits for the COMMIT.
    dangles: r.on_delete === 'NO ACTION',
  }))
  tables.set(table, keys)
  return keys
}

const referencedBy = new WeakMap<SqlDriver, Map<string, Array<{ table: string; from: string }>>>()

/**
 * Every table with a pointer at `table` that a delete would leave dangling,
 * including tables that never travel -- `product_stock` points at `products`
 * whether or not it replicates.
 */
async function referencing(
  tx: SqlDriver, table: string,
): Promise<Array<{ table: string; from: string }>> {
  let map = referencedBy.get(tx)
  if (!map) {
    map = new Map()
    /* raw: the schema's own catalogue. Asked once per driver. */
    const all = await tx.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    for (const { name } of all) {
      for (const key of await foreignKeys(tx, name)) {
        if (!key.dangles) continue
        const list = map.get(key.table) ?? []
        list.push({ table: name, from: key.from })
        map.set(key.table, list)
      }
    }
    referencedBy.set(tx, map)
  }
  return map.get(table) ?? []
}


/** Why a record cannot land when what it points at did not, or null. */
export async function parentSetAside(
  tx: SqlDriver,
  record: ChangeRecord,
  setAside: ReadonlySet<string>,
): Promise<string | null> {
  if (setAside.size === 0 || record.row === null) return null
  const shape = shapeOf(record.table)
  if (shape === undefined) return null

  for (const key of await foreignKeys(tx, shape.table)) {
    const value = record.row[key.from]
    if (typeof value !== 'string') continue
    if (setAside.has(`${key.table}\u0000${value}`)) {
      return `parent quarantined: ${key.table} ${value}`
    }
  }
  return null
}

