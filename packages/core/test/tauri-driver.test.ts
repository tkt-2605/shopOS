import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTauriDriver } from '../src/db/tauri-driver.js'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement, currentStock, recomputeStock } from '../src/services/stock.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { rupees } from '../src/money.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'
import { MERGE_BUDGET_MS } from '../src/db/driver.js'
import { applyBatch } from '../src/services/sync.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'

/** One id for a crafted record's `rowId` and its row's key, which a merge now holds to agreeing. */
const ROW_ID = newId()

/**
 * Stands in for src-tauri/src/db.rs: one connection, one transaction at a time,
 * guarded by a token. Mirroring the token rules here is what makes this a test of
 * the protocol rather than of better-sqlite3.
 */
function fakeRustLayer(backing: SqlDriver) {
  let activeToken: string | null = null
  const calls: string[] = []
  /** What each `sql_tx_begin` asked to be allowed, in order. */
  const budgets: (number | undefined)[] = []

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push(cmd)
    const sql = args['sql'] as string
    const params = (args['params'] ?? []) as never[]

    const assertToken = () => {
      if (activeToken === null) throw 'no transaction is open'
      if (args['token'] !== activeToken) throw 'a different transaction is open'
    }

    switch (cmd) {
      case 'sql_query':
        return backing.query(sql, params)
      /* The positional pair. A service on typed queries reaches the bridge
         through these and nothing else, so a fake without them is a fake of an
         older `db.rs` — which is how this test caught `billing.ts` moving onto
         Drizzle before the fake had been told. */
      case 'sql_query_values':
        return backing.queryValues(sql, params)
      case 'sql_execute':
        /* Refused while a transaction is open, as `db.rs` refuses it. There is
           one connection, so a statement outside the token would otherwise
           silently join the running transaction and share its fate. */
        if (activeToken !== null) throw 'a transaction is open'
        return backing.execute(sql, params)
      case 'sql_tx_begin':
        if (activeToken !== null) throw 'a transaction is already open'
        budgets.push(args['budgetMs'] as number | undefined)
        await backing.execute('BEGIN IMMEDIATE')
        activeToken = newId()
        return activeToken
      case 'sql_tx_query':
        assertToken()
        return backing.query(sql, params)
      case 'sql_tx_query_values':
        assertToken()
        return backing.queryValues(sql, params)
      case 'sql_tx_execute':
        assertToken()
        return backing.execute(sql, params)
      case 'sql_tx_end': {
        assertToken()
        const commit = args['commit'] === true
        try {
          await backing.execute(commit ? 'COMMIT' : 'ROLLBACK')
        } finally {
          activeToken = null
        }
        return null
      }
      default:
        throw `unknown command: ${cmd}`
    }
  }

  return { invoke, calls, budgets, isTxOpen: () => activeToken !== null }
}

let backing: SqlDriver
let rust: ReturnType<typeof fakeRustLayer>
let db: SqlDriver

beforeEach(async () => {
  backing = openMemoryDatabase()
  await migrate(backing, MIGRATIONS)
  rust = fakeRustLayer(backing)
  db = createTauriDriver(rust.invoke)
})
afterEach(async () => { await backing.close() })

describe('bridge protocol', () => {
  it('reads and writes through invoke', async () => {
    await db.execute(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`, ['a', 'b', 'now'])
    const rows = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, ['a'])
    expect(rows[0]?.value).toBe('b')
  })

  it('returns undefined from get when nothing matches', async () => {
    expect(await db.get(`SELECT value FROM settings WHERE key = 'missing'`)).toBeUndefined()
  })

  it('commits a transaction and releases the token', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
    })
    expect(await db.query(`SELECT key FROM settings WHERE key = 'k'`)).toHaveLength(1)
    expect(rust.isTxOpen()).toBe(false)
  })

  it('rolls back and releases the token when the body throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await db.query(`SELECT key FROM settings WHERE key = 'k'`)).toHaveLength(0)
    // The critical property: a thrown body must not strand the transaction, or
    // every later query blocks until the watchdog fires.
    expect(rust.isTxOpen()).toBe(false)
  })

  it('can start a new transaction straight after a failed one', async () => {
    await expect(db.transaction(async () => { throw new Error('first') })).rejects.toThrow('first')
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('after', 'ok', 'now')`)
    })
    expect(await db.query(`SELECT key FROM settings WHERE key = 'after'`)).toHaveLength(1)
  })

  it('routes statements inside a transaction through the token commands', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
      await tx.query(`SELECT key FROM settings`)
    })
    expect(rust.calls).toContain('sql_tx_execute')
    expect(rust.calls).toContain('sql_tx_query')
    expect(rust.calls.filter((c) => c === 'sql_tx_begin')).toHaveLength(1)
  })

  it('joins the open transaction rather than nesting a second one', async () => {
    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('n', 'v', 'now')`)
      })
    })
    expect(rust.calls.filter((c) => c === 'sql_tx_begin')).toHaveLength(1)
    expect(await db.query(`SELECT key FROM settings WHERE key = 'n'`)).toHaveLength(1)
  })

  it('surfaces a Rust error as a SqlError', async () => {
    await expect(db.query(`SELECT * FROM does_not_exist`)).rejects.toThrow(/does_not_exist/)
  })
})

describe('services run unchanged over the bridge', () => {
  it('bills end to end through invoke', async () => {
    const seed = await bootstrap(db, { shopName: 'Bridge Test' })
    const adminId = newId()
    const now = new Date().toISOString()
    await db.execute(
      `INSERT INTO users (id, username, role_id, password_hash, created_at, updated_at)
       VALUES (?, 'admin', ?, 'x', ?, ?)`,
      [adminId, seed.roleIds['Admin']!, now, now],
    )

    const productId = newId()
    await db.execute(
      `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
       VALUES (?, 'Bridge Pencil', ?, 1800, ?, ?)`,
      [productId, rupees(118), now, now],
    )
    await db.transaction(async (tx) => {
      await postMovement(tx, {
        productId, qtyChange: fromUnits(20), unitCost: rupees(60),
        voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    const draft = await createBill(db, {
      registerId: seed.registerId,
      lines: [{ productId, qty: fromUnits(3) }],
      actorId: adminId,
    })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    expect(draft.grandTotal).toBe(rupees(354))

    const submitted = await submitBill(db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: adminId,
    })
    expect(submitted.ok).toBe(true)
    expect(toUnits(await currentStock(db, productId))).toBe(17)
    expect(await recomputeStock(db)).toEqual([])
    expect(rust.isTxOpen()).toBe(false)
  })
})


describe('what a transaction is allowed to take', () => {
  it('asks for nothing in particular when the work is a bill', async () => {
    /* Undefined rather than fifteen thousand: the default belongs in one place,
       in Rust next to the watchdog that reads it, not written down twice. */
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
    })
    expect(rust.budgets).toEqual([undefined])
  })

  it('asks for ninety seconds when the work is a merge', async () => {
    /* A merge is one transaction on purpose — half a merge is not a state any
       reconciliation rule can describe — and on a till a week behind it can
       legitimately run for a minute. Under a bill's fifteen seconds the
       watchdog rolls it back, the next round starts again from the beginning,
       and a till far enough behind never catches up. */
    await applyBatch(db, {
      fromDevice: '2222bbbb-2222-4222-8222-222222222222',
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      records: [{
        table: 'customers',
        rowId: ROW_ID,
        op: 'upsert',
        row: {
          id: ROW_ID, code: null, name: 'Someone', phone: null, email: null, gstin: null,
          address: null, state_code: '33', price_list_id: null, credit_limit: 0,
          credit_enforcement: 'hard', is_active: 1, rev: 1, origin_id: null,
          created_at: '2026-03-01T10:00:00.000Z', updated_at: '2026-03-01T10:00:00.000Z',
          deleted_at: null,
        },
      }],
      upTo: 1,
      complete: true,
    })

    expect(rust.budgets).toEqual([MERGE_BUDGET_MS])
  })

  it('does not re-negotiate from inside one already running', async () => {
    /* A helper deep inside a merge must not be able to shorten the merge's own
       deadline by opening a nested transaction with a bill's budget. */
    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
      }, { budgetMs: 1000 })
    }, { budgetMs: 90_000 })

    expect(rust.budgets).toEqual([90_000])
  })
})

describe('a write that is not part of the transaction', () => {
  it('is refused rather than allowed to join it', async () => {
    /* The bug this closes. `db.execute` and `tx.execute` reach the same
       connection, so before this a setting saved during a long merge joined the
       merge's transaction — and if the merge rolled back the setting was gone,
       with the screen having already said it was saved. */
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('mine', 'v', 'now')`)

      await expect(
        db.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('joined', 'v', 'now')`),
      ).rejects.toThrow('a transaction is open')
    })

    expect(await db.query(`SELECT key FROM settings WHERE key = 'joined'`)).toHaveLength(0)
    expect(await db.query(`SELECT key FROM settings WHERE key = 'mine'`)).toHaveLength(1)
  })

  it('works again the moment the transaction ends', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
    })
    await db.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('after', 'v', 'now')`)
    expect(await db.query(`SELECT key FROM settings WHERE key = 'after'`)).toHaveLength(1)
  })

  it('leaves reads alone', async () => {
    /* The other half of the same decision: a merge can hold the connection for
       a minute, and a counter that cannot read for a minute is a counter that
       has stopped. */
    await db.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('before', 'v', 'now')`)

    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
      expect(await db.query(`SELECT key FROM settings WHERE key = 'before'`)).toHaveLength(1)
    })
  })
})
