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
export async function migrate(
  db: SqlDriver,
  migrations: Migration[],
  /**
   * Told about each migration as it commits.
   *
   * A callback rather than a log call, because `packages/core` may not import
   * Tauri and the log lives on the other side of that line. The detail is worth
   * carrying: if the eleventh of twelve migrations throws, the error names that
   * one, and only this says the ten before it went in. On a support call that
   * is the difference between "the upgrade failed" and "the upgrade failed
   * here, and the database is at 33 not 22".
   */
  onApplied?: (applied: { version: number; name: string }) => void,
): Promise<number> {
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

    /* Guarded, and after the commit. A caller that wants to be told what
       happened must not be able to stop it happening — an exception thrown by a
       logger would abandon a migration run halfway, which is the single worst
       thing that can happen to a shop's database. */
    try {
      onApplied?.({ version: m.version, name: m.name })
    } catch {
      // Whatever it was, it is not worth a database stuck between versions.
    }
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

/**
 * The migrations this database has run whose text has changed since, by
 * version -- normally none.
 *
 * Keeps a SHA-256 of each migration's statements (`migration_sums`, 084) the
 * first time it is seen here, and compares every later run against it.
 * Comments and line endings are left out of the sum, so a reworded comment or
 * a checkout with CRLF is not a change; a changed statement is. A database
 * that has not reached 084 answers none. It only reports: the caller logs it,
 * and the till goes on billing.
 */
export async function checkMigrationSums(db: SqlDriver, migrations: Migration[], now: Date = new Date()): Promise<number[]> {
  const table = await db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_sums'`,
  )
  if (!table) return []
  const current = await currentVersion(db)
  // raw: a local bookkeeping table, read by the migration runner before anything else is trusted.
  const held = new Map((await db.query<{ version: number; sum: string }>('SELECT version, sum FROM migration_sums'))
    .map((r) => [r.version, r.sum]))
  const changed: number[] = []
  for (const m of migrations) {
    if (m.version > current) continue
    const sum = await migrationSum(m.sql)
    const was = held.get(m.version)
    if (was === undefined) {
      await db.execute('INSERT OR IGNORE INTO migration_sums (version, sum, recorded_at) VALUES (?, ?, ?)',
        [m.version, sum, now.toISOString()])
    } else if (was !== sum) {
      changed.push(m.version)
    }
  }
  return changed
}

/** A migration's statements, without comments or line endings, as SHA-256 hex. */
export async function migrationSum(sql: string): Promise<string> {
  const text = splitStatements(sql.replace(/\r/g, '')).join('\n')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
