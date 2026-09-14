import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { bootstrap, type BootstrapResult } from '../src/services/bootstrap.js'
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
