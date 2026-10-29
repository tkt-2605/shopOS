import { describe, it, expect } from 'vitest'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap } from '../src/services/bootstrap.js'
import { MIN_PEER_SCHEMA_VERSION } from '../src/db/migrationKinds.js'
import { newId } from '../src/ids.js'

/* 082: a zero credit limit turns from "no limit" into "no credit". */
describe('migration 082', () => {
  async function shopBefore82() {
    const db = openMemoryDatabase()
    await migrate(db, MIGRATIONS.filter((m) => m.version < 82))
    await bootstrap(db, { shopName: 'Khata Shop' })
    const now = new Date().toISOString()
    const make = async (name: string, limit: number, enforcement: string) => {
      const id = newId()
      await db.execute(
        `INSERT INTO customers (id, name, credit_limit, credit_enforcement, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, limit, enforcement, now, now],
      )
      return id
    }
    return {
      db,
      zeroHard: await make('Zero hard', 0, 'hard'),
      zeroSoft: await make('Zero soft', 0, 'soft'),
      zeroNone: await make('Zero none', 0, 'none'),
      limited: await make('Limited', 50000, 'hard'),
    }
  }
  const enforcement = async (db: Awaited<ReturnType<typeof shopBefore82>>['db'], id: string) =>
    (await db.get<{ e: string; rev: number }>(`SELECT credit_enforcement AS e, rev FROM customers WHERE id = ?`, [id]))!

  it('keeps everyone who could buy on credit yesterday able to today', async () => {
    const shop = await shopBefore82()
    await migrate(shop.db, MIGRATIONS)
    expect((await enforcement(shop.db, shop.zeroHard)).e).toBe('none')
    expect((await enforcement(shop.db, shop.zeroSoft)).e).toBe('none')
    expect((await enforcement(shop.db, shop.zeroNone)).e).toBe('none')
    await shop.db.close()
  })

  it('leaves a customer with a real limit exactly as they were', async () => {
    const shop = await shopBefore82()
    const before = await enforcement(shop.db, shop.limited)
    await migrate(shop.db, MIGRATIONS)
    expect(await enforcement(shop.db, shop.limited)).toEqual(before)
    await shop.db.close()
  })

  it('feeds nothing to sync, since every till works out the same change', async () => {
    const shop = await shopBefore82()
    const before = (await shop.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_feed WHERE table_name = 'customers'`))!.n
    await migrate(shop.db, MIGRATIONS)
    const after = (await shop.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_feed WHERE table_name = 'customers'`))!.n
    expect(after).toBe(before)
    await shop.db.close()
  })

  it('raises each changed row by exactly one revision, the same on every till', async () => {
    const shop = await shopBefore82()
    const was = (await enforcement(shop.db, shop.zeroHard)).rev
    await migrate(shop.db, MIGRATIONS)
    expect((await enforcement(shop.db, shop.zeroHard)).rev).toBe(was + 1)
    await shop.db.close()
  })

  it('is breaking: a till below 082 cannot sync with one above it', () => {
    expect(MIN_PEER_SCHEMA_VERSION).toBe(82)
  })
})
