import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  libsqlDriver,
  type LibsqlClient, type LibsqlResult, type LibsqlStatement, type LibsqlTransaction,
} from '../src/db/libsql-driver.js'
import type { SqlDriver } from '../src/db/driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { createUser } from '../src/services/auth.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { listBills } from '../src/repos/catalog.js'
import { newId } from '../src/ids.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

/**
 * The Turso driver, proved the only way that means anything: by running the
 * product through it.
 *
 * A test that hands this driver a mock and checks the mock was called would
 * pass on a driver that returns rows in the wrong order, or that swallows a
 * rollback, or that hands back `bigint` where the rest of the product expects
 * `number`. What it has to answer is "does a bill submitted through this come
 * out the same as a bill submitted through the node driver", and the only way
 * to ask that is to submit one.
 *
 * So the client below is the real libSQL shape backed by a real SQLite file.
 * What is being tested is the translation -- `{sql, args}` in, columns and
 * positional rows out, a transaction that commits or rolls back -- which is
 * exactly the part `@libsql/client` does over a network and this does over a
 * function call. The network is not mocked because the network is not what this
 * file gets wrong.
 *
 * `@libsql/client` itself is not a dependency; see the note in the driver.
 */

/** libSQL's interface, answered by better-sqlite3. */
function fakeTurso(db: Database.Database, intMode: 'number' | 'bigint' = 'number') {
  const calls: string[] = []

  function run(statement: LibsqlStatement): LibsqlResult {
    calls.push(statement.sql)
    const stmt = db.prepare(statement.sql)
    if (!stmt.reader) {
      const info = stmt.run(...statement.args)
      return { columns: [], rows: [], rowsAffected: info.changes }
    }
    /* Positional, with the names beside them -- which is what the wire format
       carries, and why this driver never has to guess at key order. */
    const rows = stmt.raw(true).all(...statement.args) as unknown[][]
    return {
      columns: stmt.columns().map((c) => c.name),
      rows: intMode === 'bigint' ? rows.map((r) => r.map(asBigint)) : rows,
      rowsAffected: 0,
    }
  }

  const client: LibsqlClient = {
    execute: (statement) => Promise.resolve(run(statement)),
    transaction: (mode) => {
      expect(mode).toBe('write')
      db.exec('BEGIN IMMEDIATE')
      const tx: LibsqlTransaction = {
        execute: (statement) => Promise.resolve(run(statement)),
        commit: async () => { db.exec('COMMIT') },
        rollback: async () => { db.exec('ROLLBACK') },
      }
      return Promise.resolve(tx)
    },
    close: () => { db.close() },
  }

  return { client, calls }
}

/** What a client created with `intMode: 'bigint'` gives back. */
function asBigint(value: unknown): unknown {
  return typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value
}

let raw: Database.Database
let db: SqlDriver

beforeEach(async () => {
  raw = new Database(':memory:')
  raw.pragma('foreign_keys = ON')
  db = libsqlDriver(fakeTurso(raw).client)
  await migrate(db, MIGRATIONS)
})

afterEach(async () => { await db.close() })

describe('a shop running on Turso', () => {
  it('migrates, sets itself up and sells something', async () => {
    const seed = await bootstrap(db, { shopName: 'Remote Stores' })
    const admin = await createUser(db, {
      username: 'admin', password: 'secret123', roleId: seed.roleIds['Admin']!,
    })
    if (!admin.ok) throw new Error(admin.code)

    const productId = newId()
    const now = new Date().toISOString()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Ball Pen', ?, 0, ?, ?)`,
      [productId, rupees(10), now, now],
    )

    const draft = await createBill(db, {
      registerId: seed.registerId,
      lines: [{ productId, qty: fromUnits(3) }],
      actorId: admin.userId,
    })
    if (!draft.ok) throw new Error('the draft failed')

    const done = await submitBill(db, {
      billId: draft.billId,
      actorId: admin.userId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
    })
    expect(done.ok).toBe(true)

    const [bill] = await listBills(db, {})
    expect(bill?.grandTotal).toBe(rupees(30))
  })

  it('rolls the whole transaction back when the body throws', async () => {
    /* The failure this guards against is a driver that commits anyway: half a
       bill -- lines without a header, stock moved for goods nobody paid for --
       is the state no reconciliation rule can describe. */
    const before = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM categories`)

    await expect(db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Gone', ?, ?)`,
        [newId(), '2026-01-01', '2026-01-01'],
      )
      throw new Error('no')
    })).rejects.toThrow('no')

    const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM categories`)
    expect(after?.n).toBe(before?.n)
  })

  it('joins the transaction already open rather than starting a second', async () => {
    /* Every service in the product is written as though it owns the
       transaction -- `submitBill` calls `postMovement`, which opens one of its
       own -- so a nested call that really began a second transaction would
       deadlock on the first write against the same connection. */
    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.execute(
          `INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, 'Nested', ?, ?)`,
          [newId(), '2026-01-01', '2026-01-01'],
        )
      })
    })

    const row = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM categories WHERE name = 'Nested'`,
    )
    expect(row?.n).toBe(1)
  })

  it('reads columns by position, in the order the SELECT asked for them', async () => {
    /* The same property `positionalRows.test.ts` pins for the other two
       drivers. Drizzle maps positionally, so a driver that quietly sorted its
       columns would put plausible values in the wrong fields. */
    await db.execute(
      `INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', 'Stationery', ?, ?)`,
      ['2026-01-01', '2026-01-01'],
    )

    expect(await db.queryValues(`SELECT name, id FROM categories WHERE id = 'c1'`))
      .toEqual([['Stationery', 'c1']])
    expect(await db.queryValues(`SELECT id, name FROM categories WHERE id = 'c1'`))
      .toEqual([['c1', 'Stationery']])
  })
})

describe('a client someone configured for bigints', () => {
  it('still gives the rest of the product numbers', async () => {
    /* `intMode: 'bigint'` is a legal way to create a libSQL client, and money
       here is an integer number of paise. A `bigint` where a `number` is
       expected does not throw at the boundary -- it propagates, and the first
       arithmetic that mixes the two throws somewhere with no connection to the
       cause. */
    const wide = new Database(':memory:')
    wide.pragma('foreign_keys = ON')
    const wideDb = libsqlDriver(fakeTurso(wide, 'bigint').client)
    await migrate(wideDb, MIGRATIONS)

    await wideDb.execute(
      `INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', 'Tools', ?, ?)`,
      ['2026-01-01', '2026-01-01'],
    )
    await wideDb.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES ('p1', 'Hammer', ?, 1800, ?, ?)`,
      [rupees(250), '2026-01-01', '2026-01-01'],
    )

    const row = await wideDb.get<{ base_rate: number; tax_rate_bp: number }>(
      `SELECT base_rate, tax_rate_bp FROM products WHERE id = 'p1'`,
    )
    expect(typeof row?.base_rate).toBe('number')
    expect(row?.base_rate).toBe(rupees(250))
    expect(row?.tax_rate_bp).toBe(1800)

    const [values] = await wideDb.queryValues(`SELECT base_rate FROM products WHERE id = 'p1'`)
    expect(values).toEqual([rupees(250)])

    await wideDb.close()
  })
})
