import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { createTauriDriver } from '../src/db/tauri-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { newId } from '../src/ids.js'
import type { SqlDriver, SqlValue, Row } from '../src/db/driver.js'

/**
 * Rows of values, in the order the statement asked for its columns.
 *
 * This exists for Drizzle, which is handed positional rows through its proxy
 * and maps them onto the columns it asked for. Every read in ShopOS until now
 * has taken rows as objects and looked columns up by name, so the order of the
 * keys has never mattered — and it cannot be relied on. `db.rs` builds each row
 * as a `serde_json::Map`, which without the `preserve_order` feature is a
 * `BTreeMap`: the keys come back sorted alphabetically, whatever the SELECT
 * said. Handed those, Drizzle would read `SELECT b, a` as `[a, b]` and put
 * every value in the wrong field — plausible values, no error, wrong invoice.
 *
 * So the point of this file is the *order*, on both drivers, against a fake
 * Rust layer that sorts its keys the way the real one does.
 */

/**
 * As `serde_json::Map` hands a row back: keys sorted, not in SELECT order.
 *
 * Mirrored here so the hazard is present in the test rather than described in
 * it. The real `run_query` in `db.rs` inserts by column name into a map that is
 * a `BTreeMap` in this build, and a `BTreeMap` is sorted by construction.
 */
function sortedLikeSerde(rows: Row[]): Row[] {
  return rows.map((row) => {
    const sorted: Row = {}
    for (const key of Object.keys(row).sort()) sorted[key] = row[key] as SqlValue
    return sorted
  })
}

/** The commands `db.rs` exposes, with the two positional ones. */
function fakeRustLayer(backing: SqlDriver) {
  let activeToken: string | null = null
  const calls: string[] = []

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push(cmd)
    const sql = args['sql'] as string
    const params = (args['params'] ?? []) as SqlValue[]

    const assertToken = () => {
      if (activeToken === null) throw 'no transaction is open'
      if (args['token'] !== activeToken) throw 'a different transaction is open'
    }

    switch (cmd) {
      case 'sql_query':
        return sortedLikeSerde(await backing.query(sql, params))
      case 'sql_query_values':
        return backing.queryValues(sql, params)
      case 'sql_execute':
        if (activeToken !== null) throw 'a transaction is open'
        return backing.execute(sql, params)
      case 'sql_tx_begin':
        await backing.execute('BEGIN IMMEDIATE')
        activeToken = newId()
        return activeToken
      case 'sql_tx_query':
        assertToken()
        return sortedLikeSerde(await backing.query(sql, params))
      case 'sql_tx_query_values':
        assertToken()
        return backing.queryValues(sql, params)
      case 'sql_tx_execute':
        assertToken()
        return backing.execute(sql, params)
      case 'sql_tx_end': {
        assertToken()
        try {
          await backing.execute(args['commit'] === true ? 'COMMIT' : 'ROLLBACK')
        } finally {
          activeToken = null
        }
        return null
      }
      default:
        throw `unknown command: ${cmd}`
    }
  }

  return { invoke, calls }
}

let backing: SqlDriver
let rust: ReturnType<typeof fakeRustLayer>
let tauri: SqlDriver

beforeEach(async () => {
  backing = openMemoryDatabase()
  await migrate(backing, MIGRATIONS)
  rust = fakeRustLayer(backing)
  tauri = createTauriDriver(rust.invoke)
  await backing.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ('shop_name', 'Kumar Stores', '2026-09-16T10:00:00+05:30')`,
  )
})
afterEach(async () => { await backing.close() })

/** Declared `(key, value, updated_at)`; asked for in the opposite order. */
const BACKWARDS = `SELECT value, key FROM settings WHERE key = 'shop_name'`

describe('the node driver', () => {
  it('returns a row of values in the order the SELECT names them', async () => {
    expect(await backing.queryValues(BACKWARDS)).toEqual([['Kumar Stores', 'shop_name']])
  })

  it('returns one array per row', async () => {
    await backing.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ('shop_state_code', '33', '2026-09-16T10:00:00+05:30')`,
    )
    const rows = await backing.queryValues(
      `SELECT key FROM settings WHERE key LIKE 'shop_%' ORDER BY key`,
    )
    expect(rows).toEqual([['shop_name'], ['shop_state_code']])
  })

  it('returns nothing, rather than a row of nothings, for a query that matches nothing', async () => {
    expect(await backing.queryValues(`SELECT key FROM settings WHERE key = 'absent'`)).toEqual([])
  })

  it('carries nulls and numbers as themselves', async () => {
    const rows = await backing.queryValues(`SELECT 1, NULL, 'x', 2.5`)
    expect(rows).toEqual([[1, null, 'x', 2.5]])
  })

  it('does not leave the statement in raw mode for the next caller', async () => {
    /* better-sqlite3 keeps `raw` on the prepared statement. Nothing here caches
       them, so the object read after a positional read is still an object — but
       that is a property of the driver and worth pinning, because a statement
       cache added later would break it silently and in one direction only. */
    await backing.queryValues(BACKWARDS)
    expect(await backing.get<Row>(BACKWARDS)).toEqual({ value: 'Kumar Stores', key: 'shop_name' })
  })

  it('says which statement failed', async () => {
    await expect(backing.queryValues(`SELECT nope FROM settings`)).rejects.toMatchObject({
      name: 'SqlError',
      sql: `SELECT nope FROM settings`,
    })
  })
})

describe('the Tauri driver', () => {
  it('returns values in SELECT order, where objects would be sorted', async () => {
    /* Both halves matter. The object read is what the shop has always done and
       it comes back sorted — `key` before `value`, the reverse of what was
       asked for. The positional read is the one Drizzle gets. */
    const asObject = await tauri.get<Row>(BACKWARDS)
    expect(Object.keys(asObject ?? {})).toEqual(['key', 'value'])

    expect(await tauri.queryValues(BACKWARDS)).toEqual([['Kumar Stores', 'shop_name']])
  })

  it('goes through sql_query_values outside a transaction', async () => {
    await tauri.queryValues(BACKWARDS)
    expect(rust.calls).toEqual(['sql_query_values'])
  })

  it('goes through sql_tx_query_values inside one', async () => {
    /* The one the spec asks to be proved. A Drizzle read that went out through
       `sql_query_values` while a transaction was open would be reading around
       the transaction it believes it is in. */
    await tauri.transaction(async (tx) => {
      await tx.queryValues(BACKWARDS)
    })
    expect(rust.calls).toEqual(['sql_tx_begin', 'sql_tx_query_values', 'sql_tx_end'])
  })

  it('sees what the transaction has written but not committed', async () => {
    await tauri.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('till_name', 'Counter 2', '2026-09-16T10:00:00+05:30')`,
      )
      expect(await tx.queryValues(`SELECT value FROM settings WHERE key = 'till_name'`))
        .toEqual([['Counter 2']])
    })
  })

  it('reports a failure as a SqlError carrying the statement', async () => {
    await expect(tauri.queryValues(`SELECT nope FROM settings`)).rejects.toMatchObject({
      name: 'SqlError',
      sql: `SELECT nope FROM settings`,
    })
  })
})

describe('the two drivers', () => {
  it('agree, column for column, on the same statement', async () => {
    /* The parity that matters: a query written once must mean the same thing on
       the shop's till and in every test in this repo. */
    const sql = `SELECT value, key, updated_at FROM settings ORDER BY key`
    expect(await tauri.queryValues(sql)).toEqual(await backing.queryValues(sql))
  })
})
