import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap, setSetting, type BootstrapResult } from '../src/services/bootstrap.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

export interface Fixture {
  db: SqlDriver
  seed: BootstrapResult
  adminId: string
}

export async function freshDb(): Promise<Fixture> {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  const seed = await bootstrap(db, { shopName: 'Test Shop' })

  /* A registered shop, because almost every test here is about tax and a shop
     that charges GST is registered for it.

     This used to be left unset, and the fixture was then a shop collecting CGST
     and SGST with no registration to collect it under -- which is not a shop,
     it is an offence, and it is the exact state the owner's real database
     turned out to be in (`findings-real-shop.md`, finding 2). Phase 1b's tax
     scheme reads this: with no GSTIN a shop derives to `unregistered` and the
     till stops adding tax, which is correct and which every tax test here would
     otherwise fail against. Saying it out loud in the fixture is better than a
     default that quietly makes the tests pass. */
  await setSetting(db, 'shop_gstin', '33ALNPJ1906G1ZC')
  /* And in a state, which is the other half of being able to issue an invoice
     at all: `supplyTypeFor(null, anything)` answers `intra_state`, so a shop
     with no state code taxes every sale as a local one including the ones that
     are not. Phase 1c refuses to submit a bill in that condition, and this
     fixture was in it -- a registered shop, nowhere. */
  await setSetting(db, 'shop_state_code', '33')

  const adminId = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO users (id, username, full_name, role_id, password_hash, created_at, updated_at)
     VALUES (?, 'admin', 'Administrator', ?, 'x', ?, ?)`,
    [adminId, seed.roleIds['Admin']!, now, now],
  )

  return { db, seed, adminId }
}

/**
 * A till that has been installed and not set up: migrated, and holding nothing.
 *
 * This is what a second till in a shop actually is. It must *not* be
 * bootstrapped — a till that sets itself up has created a second shop, with its
 * own Admin role and its own counter carrying the same names and different ids,
 * and no merge rule can reconcile two things that are not two versions of one
 * thing. Migration 024 is the whole story.
 */
export async function emptyDb(): Promise<SqlDriver> {
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  return db
}

export async function makeProduct(
  db: SqlDriver,
  overrides: Partial<{
    id: string; name: string; baseRate: number; taxRateBp: number; barcode: string
    discountBlocked: boolean; loyaltyBlocked: boolean
  }> = {},
): Promise<string> {
  const id = overrides.id ?? newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO products
       (id, name, base_rate, tax_rate_bp, barcode, discount_blocked, loyalty_blocked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, overrides.name ?? 'Test Product', overrides.baseRate ?? 10000,
      overrides.taxRateBp ?? 1800, overrides.barcode ?? null,
      overrides.discountBlocked ? 1 : 0, overrides.loyaltyBlocked ? 1 : 0, now, now,
    ],
  )
  // The scanner reads product_barcodes; a product with a printed code and no row
  // here is not findable, which is exactly the bug this mirrors in the app.
  if (overrides.barcode) {
    await db.execute(
      `INSERT INTO product_barcodes (id, product_id, barcode, is_primary, created_at) VALUES (?, ?, ?, 1, ?)`,
      [newId(), id, overrides.barcode, now],
    )
  }
  return id
}

export async function makeCustomer(db: SqlDriver, name = 'Test Customer'): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  await db.execute(
    `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [id, name, now, now],
  )
  return id
}

/**
 * Runs a hand edit of a submitted document, which the database refuses since
 * 059, with that table's guard lifted for the length of it.
 *
 * For tests that set up a situation the product can no longer make: a bill
 * back-dated to build a statement window, a copy of a document altered on a
 * till from before 059 to prove the merge still refuses it. The guard is put
 * back exactly as it was, whatever the edit does.
 */
export async function editingSubmitted<T>(db: SqlDriver, table: string, edit: () => Promise<T>): Promise<T> {
  const name = `${table}_submitted_is_final`
  const row = await db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`, [name])
  if (!row) throw new Error(`no guard called ${name}`)
  await db.execute(`DROP TRIGGER ${name}`)
  try {
    return await edit()
  } finally {
    await db.execute(row.sql)
  }
}
