import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { is } from 'drizzle-orm'
import { SQLiteTable as TableClass } from 'drizzle-orm/sqlite-core'
import { openMemoryDatabase, openDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import * as schema from '../src/db/schema.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * `schema.ts` says what the database looks like. This says whether it is right.
 *
 * The schema file was seeded once by `drizzle-kit pull` and is owned by hand
 * from then on: every migration edits it in the same commit as the SQL, and
 * `drizzle-kit generate` and `push` are never run, because the numbered
 * migrations are the only thing allowed to change a shop's schema. That rule
 * needs something holding it, or the file drifts quietly and a typed query
 * starts selecting a column that is not there any more — or worse, keeps
 * reading one whose meaning changed underneath it.
 *
 * So: for every table declared here, `PRAGMA table_info` must agree on the name,
 * the type, whether it is nullable, its default and whether it is part of the
 * primary key; every table in the database must be declared; and every foreign
 * key the database enforces must be declared too.
 *
 * Modelled on `replicaShape.test.ts`, which does the same job for what sync is
 * allowed to carry.
 */

interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface ForeignKeyInfo {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
}

/** Every `sqliteTable` exported from `schema.ts`, by its SQL name. */
function declaredTables(): Map<string, SQLiteTable> {
  const found = new Map<string, SQLiteTable>()
  for (const value of Object.values(schema)) {
    if (is(value, TableClass)) found.set(getTableConfig(value).name, value)
  }
  return found
}

/**
 * A default as SQLite records it, from what Drizzle was told.
 *
 * `PRAGMA table_info` gives the text of the DDL — `0`, `'sale'` — and Drizzle
 * holds the JavaScript value. Strings are quoted on the way back so the two are
 * comparable without unquoting the pragma, which would make `'0'` and `0` look
 * the same when they are not.
 */
function asSqlDefault(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') return `'${value}'`
  return String(value)
}

let db: SqlDriver

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
})
afterAll(async () => { await db.close() })

describe('every table this repo declares', () => {
  it('declares one for every table the migrations build', async () => {
    const built = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    const declared = declaredTables()

    const missing = built.map((t) => t.name).filter((name) => !declared.has(name))
    expect(missing, 'tables in the database that schema.ts does not declare').toEqual([])
  })

  it('declares none the migrations do not build', async () => {
    const built = new Set(
      (await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )).map((t) => t.name),
    )

    const invented = [...declaredTables().keys()].filter((name) => !built.has(name))
    expect(invented, 'tables schema.ts declares that do not exist').toEqual([])
  })

  it('has more than forty of them, so an empty scan cannot pass', () => {
    expect(declaredTables().size).toBeGreaterThan(40)
  })
})

describe('every column', () => {
  it('matches the database on name, type, nullability, default and key', async () => {
    const wrong: string[] = []

    for (const [name, table] of declaredTables()) {
      const actual = await db.query<ColumnInfo>(`PRAGMA table_info(${name})`)
      const byName = new Map(actual.map((c) => [c.name, c]))
      const config = getTableConfig(table)

      /* A key over two columns is declared in the table's extras rather than on
         either column, so `column.primary` is false for both. */
      const composite = new Set(
        config.primaryKeys.flatMap((key) => key.columns.map((c) => c.name)),
      )
      const keyWidth = actual.filter((c) => c.pk > 0).length

      for (const column of config.columns) {
        const real = byName.get(column.name)
        if (!real) {
          wrong.push(`${name}.${column.name} — declared, not in the database`)
          continue
        }
        byName.delete(column.name)

        if (real.type.toLowerCase() !== column.getSQLType().toLowerCase()) {
          wrong.push(`${name}.${column.name} — ${column.getSQLType()} declared, ${real.type} in the database`)
        }
        /* `INTEGER PRIMARY KEY` on its own is the rowid under another name, and
           SQLite reports it as nullable however it was declared — a quirk kept
           for files written before 3.0. It cannot hold a null: an insert that
           leaves it out is given the next integer. So the pragma has nothing to
           say about this one column, and asking it would fail `change_feed.seq`
           for being what it is. */
        const rowidAlias = real.pk === 1 && keyWidth === 1 && real.type.toUpperCase() === 'INTEGER'
        if (!rowidAlias && (real.notnull === 1) !== column.notNull) {
          wrong.push(`${name}.${column.name} — notNull ${column.notNull}, database says ${real.notnull === 1}`)
        }

        const declaredPrimary = column.primary || composite.has(column.name)
        if ((real.pk > 0) !== declaredPrimary) {
          wrong.push(`${name}.${column.name} — primary ${declaredPrimary}, database says ${real.pk > 0}`)
        }

        const declaredDefault = asSqlDefault(column.default)
        if (declaredDefault !== real.dflt_value) {
          wrong.push(`${name}.${column.name} — default ${declaredDefault}, database says ${real.dflt_value}`)
        }
      }

      for (const left of byName.keys()) {
        wrong.push(`${name}.${left} — in the database, not declared`)
      }
    }

    expect(wrong).toEqual([])
  })

  it('is being read from a real database, so an empty list means something', async () => {
    const columns = await db.query<ColumnInfo>(`PRAGMA table_info(bills)`)
    expect(columns.length).toBeGreaterThan(20)
    expect(columns.map((c) => c.name)).toContain('grand_total')
  })
})

describe('every foreign key the database enforces', () => {
  it('is declared, to the same table and column', async () => {
    const missing: string[] = []

    for (const [name, table] of declaredTables()) {
      const enforced = await db.query<ForeignKeyInfo>(`PRAGMA foreign_key_list(${name})`)
      const config = getTableConfig(table)

      /* Both shapes count: `references(() => other.id)` on the column, and the
         `foreignKey({ columns, foreignColumns })` block a self-reference needs. */
      const declared = new Set(
        config.foreignKeys.map((fk) => {
          const ref = fk.reference()
          const from = ref.columns.map((c) => c.name).join(',')
          const to = ref.foreignColumns.map((c) => c.name).join(',')
          return `${from} -> ${getTableConfig(ref.foreignTable).name}.${to}`
        }),
      )

      /* One `PRAGMA foreign_key_list` row per column of a composite key, all
         sharing an id. `to` is null when the key points at the other table's
         primary key without naming it. */
      const byId = new Map<number, ForeignKeyInfo[]>()
      for (const row of enforced) {
        byId.set(row.id, [...(byId.get(row.id) ?? []), row])
      }

      for (const rows of byId.values()) {
        const ordered = [...rows].sort((a, b) => a.seq - b.seq)
        const target = ordered[0]!.table
        const targetPk = ordered[0]!.to
          ? ordered.map((r) => r.to).join(',')
          : (await db.query<ColumnInfo>(`PRAGMA table_info(${target})`))
              .filter((c) => c.pk > 0)
              .sort((a, b) => a.pk - b.pk)
              .map((c) => c.name)
              .join(',')

        const key = `${ordered.map((r) => r.from).join(',')} -> ${target}.${targetPk}`
        if (!declared.has(key)) missing.push(`${name}: ${key}`)
      }
    }

    expect(missing).toEqual([])
  })
})

/**
 * The same three questions against a real shop's database, when there is one.
 *
 * `tools/fixtures/` is gitignored, so this is silent in CI and on a machine
 * that has never run `pull-shop-db`. Where the file is present it is the
 * stronger check: the in-memory database above is built by replaying every
 * migration from nothing, and a shop's is built by replaying the later ones
 * onto whatever the earlier ones actually left behind.
 */
const FIXTURE = 'tools/fixtures/real-shop.db'

describe.runIf(existsSync(FIXTURE))('a real shop migrated to head', () => {
  it('has the columns schema.ts declares', async () => {
    const { copyFileSync, rmSync } = await import('node:fs')
    const copy = `${FIXTURE}.parity.tmp`
    copyFileSync(FIXTURE, copy)
    const shop = openDatabase(copy)
    try {
      await migrate(shop, MIGRATIONS)
      const wrong: string[] = []

      for (const [name, table] of declaredTables()) {
        const actual = await shop.query<ColumnInfo>(`PRAGMA table_info(${name})`)
        const byName = new Map(actual.map((c) => [c.name, c]))
        for (const column of getTableConfig(table).columns) {
          const real = byName.get(column.name)
          if (!real) { wrong.push(`${name}.${column.name} — missing`); continue }
          if (real.type.toLowerCase() !== column.getSQLType().toLowerCase()) {
            wrong.push(`${name}.${column.name} — ${column.getSQLType()} vs ${real.type}`)
          }
          byName.delete(column.name)
        }
        for (const left of byName.keys()) wrong.push(`${name}.${left} — not declared`)
      }

      expect(wrong).toEqual([])
    } finally {
      await shop.close()
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(copy + suffix)) rmSync(copy + suffix)
      }
    }
  })
})
