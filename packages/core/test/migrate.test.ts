import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate, currentVersion } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import type { SqlDriver } from '../src/db/driver.js'

let db: SqlDriver

beforeEach(async () => {
  db = openMemoryDatabase()
})

afterEach(async () => {
  await db.close()
})

describe('migrations', () => {
  it('applies cleanly from empty', async () => {
    const version = await migrate(db, MIGRATIONS)
    expect(version).toBe(MIGRATIONS.length)
    expect(await currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('is idempotent', async () => {
    await migrate(db, MIGRATIONS)
    const again = await migrate(db, MIGRATIONS)
    expect(again).toBe(MIGRATIONS.length)
  })

  it('creates every expected table', async () => {
    await migrate(db, MIGRATIONS)
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    const tables = rows.map((r) => r.name)

    for (const expected of [
      'activity_log', 'audit_log', 'bill_items', 'bill_payments', 'bills',
      'cash_movements', 'cash_sessions', 'categories', 'customer_item_prices',
      'customers', 'doc_sequences', 'item_prices', 'loyalty_entries',
      'loyalty_redemptions', 'payment_allocations', 'payment_entries',
      'price_lists', 'product_stock', 'product_units', 'products', 'registers',
      'role_pages', 'role_permissions', 'roles', 'sales_return_items',
      'sales_returns', 'settings', 'stock_entries', 'stock_entry_items',
      'stock_ledger', 'suppliers', 'sync_queue', 'users',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected)
    }
  })

  it('rejects non-contiguous versions', async () => {
    await expect(
      migrate(db, [{ version: 2, name: 'gap.sql', sql: 'SELECT 1;' }]),
    ).rejects.toThrow(/contiguous/)
  })

  it('enforces foreign keys', async () => {
    await migrate(db, MIGRATIONS)
    await expect(
      db.execute(
        `INSERT INTO users (id, username, role_id, password_hash, created_at, updated_at)
         VALUES ('u1', 'ghost', 'no-such-role', 'x', '2026-01-01', '2026-01-01')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })

  it('refuses money columns that are not integers', async () => {
    await migrate(db, MIGRATIONS)
    await expect(
      db.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('a', 'b', 'c')`),
    ).resolves.toBeTruthy()
    // STRICT tables reject a float where INTEGER is declared.
    await expect(
      db.execute(
        `INSERT INTO price_lists (id, name, created_at, updated_at, is_default)
         VALUES ('p1', 'Retail', '2026-01-01', '2026-01-01', 0.5)`,
      ),
    ).rejects.toThrow()
  })
})

describe('audit_log immutability', () => {
  beforeEach(async () => {
    await migrate(db, MIGRATIONS)
    await db.execute(
      `INSERT INTO audit_log (id, entity, entity_id, action, at)
       VALUES ('a1', 'bills', 'b1', 'create', '2026-01-01T00:00:00Z')`,
    )
  })

  it('rejects UPDATE', async () => {
    await expect(
      db.execute(`UPDATE audit_log SET action = 'delete' WHERE id = 'a1'`),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects DELETE', async () => {
    await expect(db.execute(`DELETE FROM audit_log WHERE id = 'a1'`)).rejects.toThrow(/append-only/)
  })
})

describe('transactions', () => {
  beforeEach(async () => {
    await migrate(db, MIGRATIONS)
  })

  it('rolls back every write when the body throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO settings (key, value, updated_at) VALUES ('shop_name', 'Test', '2026-01-01')`,
        )
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const rows = await db.query(`SELECT key FROM settings`)
    expect(rows).toHaveLength(0)
  })

  it('commits when the body resolves', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('shop_name', 'Test', '2026-01-01')`,
      )
    })
    const rows = await db.query(`SELECT key FROM settings`)
    expect(rows).toHaveLength(1)
  })
})

describe('refusing a schema this build cannot run', () => {
  /* Unreachable until restore exists, and the first thing restore will hit. */
  it('refuses a database newer than the app', async () => {
    await migrate(db, MIGRATIONS)
    await db.execute(`PRAGMA user_version = ${MIGRATIONS.length + 3}`)

    await expect(migrate(db, MIGRATIONS)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
      found: MIGRATIONS.length + 3,
      supported: MIGRATIONS.length,
    })
  })

  /* The guard has to sit above the `nothing pending` early return, or it is dead
     code — a too-new database is precisely the one with nothing to apply. */
  it('refuses rather than returning happily with nothing pending', async () => {
    await migrate(db, MIGRATIONS)
    await db.execute('PRAGMA user_version = 99')

    let threw = false
    try {
      await migrate(db, MIGRATIONS)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('refuses a database with our tables but no version stamp', async () => {
    await migrate(db, MIGRATIONS)
    await db.execute('PRAGMA user_version = 0')

    await expect(migrate(db, MIGRATIONS)).rejects.toMatchObject({ code: 'SCHEMA_UNVERSIONED' })
  })

  it('leaves an empty database alone — that is a first run, not a damaged file', async () => {
    expect(await currentVersion(db)).toBe(0)
    await expect(migrate(db, MIGRATIONS)).resolves.toBe(MIGRATIONS.length)
  })

  it('still migrates a database one version behind', async () => {
    await migrate(db, MIGRATIONS.slice(0, 1))
    expect(await currentVersion(db)).toBe(1)
    await expect(migrate(db, MIGRATIONS)).resolves.toBe(MIGRATIONS.length)
  })
})
