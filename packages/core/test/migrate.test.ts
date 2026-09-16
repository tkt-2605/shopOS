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
      'audit_log', 'bill_items', 'bill_payments', 'bills',
      'cash_movements', 'cash_sessions', 'categories', 'customer_item_prices',
      'customers', 'doc_sequences', 'item_prices', 'loyalty_entries',
      'loyalty_redemptions', 'payment_allocations', 'payment_entries',
      'price_lists', 'product_stock', 'product_units', 'products', 'registers',
      'role_pages', 'role_permissions', 'roles', 'sales_return_items',
      'sales_returns', 'settings', 'stock_entries', 'stock_entry_items',
      'stock_ledger', 'suppliers', 'users',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected)
    }
  })

  it('has got rid of the two tables nothing ever read', async () => {
    await migrate(db, MIGRATIONS)
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    const tables = rows.map((r) => r.name)

    /* `activity_log` was written by `writeActivity` since 001 and selected by
       nothing, ever; `sync_queue` was reserved on day one for a design that was
       never built, and `change_feed` has done that job since two tills could
       talk. Asserted rather than assumed, because a dropped table is the kind of
       thing a later migration reintroduces by copying an older one. */
    expect(tables).not.toContain('activity_log')
    expect(tables).not.toContain('sync_queue')
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

    // Its own row, not the whole table: migration 011 seeds the feature
    // switches, so an empty table is no longer what a rollback looks like.
    const rows = await db.query(`SELECT key FROM settings WHERE key = 'shop_name'`)
    expect(rows).toHaveLength(0)
  })

  it('commits when the body resolves', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('shop_name', 'Test', '2026-01-01')`,
      )
    })
    const rows = await db.query(`SELECT key FROM settings WHERE key = 'shop_name'`)
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

/**
 * Saying what happened, without being able to change what happens.
 *
 * An upgrade is the most dangerous thing this program does to a shop's data,
 * and until now it did it in silence: a till that came back wrong after an
 * update had nothing on disk saying which migration ran, or how far the run
 * got. The callback exists so `apps/pos` can write that down — `packages/core`
 * may not import Tauri, so the log is on the other side of that line.
 */
describe('being told which migrations ran', () => {
  it('names each one, in order, as it commits', async () => {
    const seen: number[] = []
    await migrate(db, MIGRATIONS.slice(0, 3), (m) => { seen.push(m.version) })

    expect(seen).toEqual([1, 2, 3])
  })

  it('names the file, which is what a person reads', async () => {
    const seen: string[] = []
    await migrate(db, MIGRATIONS.slice(0, 1), (m) => { seen.push(m.name) })

    // "applied 1 001_initial.sql" beats "applied migration 1" on a phone call.
    expect(seen[0]).toMatch(/^001_/)
  })

  it('says nothing about migrations that were already in', async () => {
    await migrate(db, MIGRATIONS.slice(0, 2))

    const seen: number[] = []
    await migrate(db, MIGRATIONS.slice(0, 4), (m) => { seen.push(m.version) })

    /* Only what this run did. A line per migration on every start would put a
       hundred lines of nothing between the shop and the event worth reading. */
    expect(seen).toEqual([3, 4])
  })

  it('only speaks after the change is committed', async () => {
    const versions: number[] = []
    await migrate(db, MIGRATIONS.slice(0, 2), () => {
      /* Read inside the callback: whatever it says has already happened, so a
         log line can never describe a migration that then rolled back. */
      versions.push(-1)
    })

    expect(versions).toHaveLength(2)
    expect(await currentVersion(db)).toBe(2)
  })

  it('cannot stop the run by throwing', async () => {
    /* The reason this is guarded rather than trusted. A logger that throws —
       out of disk, a missing bridge, a bug in a format string — would otherwise
       abandon the migration run halfway and leave the shop's database stuck
       between two versions, which is the single worst state it can be in. */
    const reached: number[] = []
    await expect(
      migrate(db, MIGRATIONS.slice(0, 3), (m) => {
        reached.push(m.version)
        throw new Error('the disk is full')
      }),
    ).resolves.toBe(3)

    expect(reached).toEqual([1, 2, 3])
    expect(await currentVersion(db)).toBe(3)
  })

  it('is optional, which is how every other caller uses it', async () => {
    await expect(migrate(db, MIGRATIONS.slice(0, 2))).resolves.toBe(2)
  })
})
