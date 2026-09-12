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
