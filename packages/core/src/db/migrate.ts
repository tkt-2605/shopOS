import type { SqlDriver } from './driver.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * The database is newer than this build of ShopOS.
 *
 * Unreachable until a backup can be restored, and the first thing a restore hits:
 * an owner who copies last month's file onto a machine that was since downgraded,
 * or restores a backup from a newer install onto an older one. `migrate` would
 * otherwise find nothing pending, return happily, and run every query against a
 * schema it does not know — silent wrong answers rather than a stopped till.
 */
export class SchemaTooNewError extends Error {
  readonly code = 'SCHEMA_TOO_NEW'
  constructor(readonly found: number, readonly supported: number) {
    super(
      `This database was written by a newer ShopOS (schema ${found}; this build understands ${supported}). ` +
        'Update ShopOS, or restore a backup taken by this version.',
    )
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Our tables are present but `user_version` says zero.
 *
 * Guessing v1 and replaying the migrations would run 002's ALTER TABLE against a
 * column that may already exist, so refuse and say so. The honest cause is a file
 * that was copied rather than vacuumed, or one edited by another tool.
 */
export class SchemaUnversionedError extends Error {
  readonly code = 'SCHEMA_UNVERSIONED'
  constructor(readonly sample: string) {
    super(
      `This database has ShopOS tables (${sample}) but no schema version, so there is no safe way ` +
        'to tell which migrations it has already had. Restore a backup taken by ShopOS instead.',
    )
    this.name = 'SchemaUnversionedError'
  }
}

/**
 * Tables that only ShopOS creates. Probed rather than counted so an empty
 * database — every test fixture, and every first run — finds nothing and passes.
 */
const SENTINEL_TABLES = ['bills', 'bill_items', 'products', 'registers', 'doc_sequences']

/**
 * Migrations are immutable once released. Editing a shipped migration means two
 * shops with the same user_version have different schemas — the exact drift the
 * previous system died of. Add a new file instead.
 */
export async function migrate(db: SqlDriver, migrations: Migration[]): Promise<number> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  assertContiguous(ordered)

  const row = await db.get<{ user_version: number }>('PRAGMA user_version')
  const current = row?.user_version ?? 0

  // Both guards sit above the early return on purpose: a database that is too new
  // has nothing pending, which is exactly the case being caught.
  const supported = ordered[ordered.length - 1]?.version ?? 0
  if (current > supported) throw new SchemaTooNewError(current, supported)
  if (current === 0) {
    const found = await findSentinelTable(db)
    if (found) throw new SchemaUnversionedError(found)
  }

  const pending = ordered.filter((m) => m.version > current)
  if (pending.length === 0) return current

  for (const m of pending) {
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(m.sql)) {
        await tx.execute(statement)
      }
      // PRAGMA will not bind a parameter, and the value is a validated integer.
      await tx.execute(`PRAGMA user_version = ${m.version}`)
    })
  }

  return pending[pending.length - 1]?.version ?? current
}

export async function currentVersion(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version')
  return row?.user_version ?? 0
}

async function findSentinelTable(db: SqlDriver): Promise<string | null> {
  const placeholders = SENTINEL_TABLES.map(() => '?').join(', ')
  const row = await db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name LIMIT 1`,
    SENTINEL_TABLES,
  )
  return row?.name ?? null
}

function assertContiguous(ordered: Migration[]): void {
  ordered.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`migration version must be a positive integer: ${m.name}`)
    }
    if (m.version !== i + 1) {
      throw new Error(`migration versions must be contiguous from 1; found ${m.version} at position ${i + 1}`)
    }
  })
}

/**
 * Splits on semicolons at statement level, keeping CREATE TRIGGER bodies intact —
 * their inner statements end in semicolons too.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buffer = ''
  let inBlock = false

  for (const rawLine of sql.split('\n')) {
    const line = rawLine.replace(/--.*$/, '')
    if (line.trim() === '') {
      if (buffer.trim() !== '') buffer += '\n'
      continue
    }

    buffer += line + '\n'

    if (/\bBEGIN\b/i.test(line) && /\bCREATE\s+TRIGGER\b/i.test(buffer)) inBlock = true

    if (inBlock) {
      if (/\bEND\s*;/i.test(line)) {
        out.push(buffer.trim())
        buffer = ''
        inBlock = false
      }
      continue
    }

    if (line.trimEnd().endsWith(';')) {
      out.push(buffer.trim())
      buffer = ''
    }
  }

  if (buffer.trim() !== '') out.push(buffer.trim())
  return out.filter((s) => s !== '' && s !== ';')
}
