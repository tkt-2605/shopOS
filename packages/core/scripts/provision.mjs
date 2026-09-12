#!/usr/bin/env node
/**
 * Provisions a ShopOS database file: schema, roles, admin user, and optionally a
 * demo catalogue. Used for demo builds and for standing up a shop without
 * clicking through the wizard.
 *
 *   node scripts/provision.mjs --db <path> --shop "Name" --password <pw> [--demo]
 */
import { openDatabase } from '../src/db/node-driver.ts'
import { migrate } from '../src/db/migrate.ts'
import { MIGRATIONS } from '../src/db/migrations.ts'
import { firstRun, seedDemoData, isFirstRun } from '../src/services/seed.ts'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dbPath = arg('db')
if (!dbPath) {
  console.error('usage: provision.mjs --db <path> --shop "Name" --password <pw> [--demo]')
  process.exit(1)
}

const shopName = arg('shop', 'My Shop')
const password = arg('password', 'counter123')
const withDemo = process.argv.includes('--demo')

const db = openDatabase(dbPath)

try {
  const version = await migrate(db, MIGRATIONS)
  console.log(`schema at version ${version}`)

  if (!(await isFirstRun(db))) {
    console.log('already provisioned — nothing to do')
    process.exit(0)
  }

  const { adminId } = await firstRun(db, { shopName, adminPassword: password })
  console.log(`created shop "${shopName}" with admin user`)

  if (withDemo) {
    const seeded = await seedDemoData(db, adminId)
    console.log(`seeded ${seeded.products} products and ${seeded.customers} customers`)
  }
} finally {
  await db.close()
}
