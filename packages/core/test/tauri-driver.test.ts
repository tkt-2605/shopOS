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

/**
 * Stands in for src-tauri/src/db.rs: one connection, one transaction at a time,
 * guarded by a token. Mirroring the token rules here is what makes this a test of
 * the protocol rather than of better-sqlite3.
 */
function fakeRustLayer(backing: SqlDriver) {
  let activeToken: string | null = null
  const calls: string[] = []

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
      case 'sql_execute':
        return backing.execute(sql, params)
      case 'sql_tx_begin':
        if (activeToken !== null) throw 'a transaction is already open'
        await backing.execute('BEGIN IMMEDIATE')
        activeToken = newId()
        return activeToken
      case 'sql_tx_query':
        assertToken()
        return backing.query(sql, params)
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

  return { invoke, calls, isTxOpen: () => activeToken !== null }
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
    expect(await db.query(`SELECT key FROM settings`)).toHaveLength(1)
    expect(rust.isTxOpen()).toBe(false)
  })

  it('rolls back and releases the token when the body throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 'now')`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await db.query(`SELECT key FROM settings`)).toHaveLength(0)
    // The critical property: a thrown body must not strand the transaction, or
    // every later query blocks until the watchdog fires.
    expect(rust.isTxOpen()).toBe(false)
  })

  it('can start a new transaction straight after a failed one', async () => {
    await expect(db.transaction(async () => { throw new Error('first') })).rejects.toThrow('first')
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('after', 'ok', 'now')`)
    })
    expect(await db.query(`SELECT key FROM settings`)).toHaveLength(1)
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
    expect(await db.query(`SELECT key FROM settings`)).toHaveLength(1)
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
