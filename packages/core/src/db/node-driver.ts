import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { type SqlDriver, type SqlValue, type Row, type ExecResult, SqlError } from './driver.js'

/**
 * Node driver — tests, seeds and CLI tooling only. Never bundled into the app;
 * the Vite config aliases better-sqlite3 to an empty module so a stray import
 * fails loudly at build time instead of silently at runtime.
 */

export interface NodeDriverOptions {
  readonly: boolean
}

export function openDatabase(path: string, opts?: Partial<NodeDriverOptions>): SqlDriver {
  const db = new Database(path, { readonly: opts?.readonly ?? false })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return new NodeDriver(db)
}

export function openMemoryDatabase(): SqlDriver {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return new NodeDriver(db)
}

class NodeDriver implements SqlDriver {
  #inTransaction = false

  constructor(private readonly db: Db) {}

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    try {
      return this.db.prepare(sql).all(...params) as T[]
    } catch (cause) {
      throw new SqlError(describe(cause), sql, cause)
    }
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    try {
      return this.db.prepare(sql).get(...params) as T | undefined
    } catch (cause) {
      throw new SqlError(describe(cause), sql, cause)
    }
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<ExecResult> {
    try {
      const info = this.db.prepare(sql).run(...params)
      return { rowsAffected: info.changes }
    } catch (cause) {
      throw new SqlError(describe(cause), sql, cause)
    }
  }

  /**
   * `TxOptions` is accepted and ignored. There is no watchdog here: tests run in
   * one process against a file nobody else holds, and a transaction that hangs
   * hangs the test, which is the report you want.
   */
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)

    this.db.exec('BEGIN IMMEDIATE')
    this.#inTransaction = true
    try {
      const result = await fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; surface the original failure.
      }
      throw err
    } finally {
      this.#inTransaction = false
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
