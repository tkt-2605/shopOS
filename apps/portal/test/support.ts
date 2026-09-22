import { openMemoryDatabase } from '@shopos/core/node'
import type { SqlDriver } from '@shopos/core'
import type { SigningKey } from '@shopos/core/licence'
import { migratePortal } from '../src/store.js'
import { generateKeypair, loadSigningKey } from '../src/keys.js'
import { memoryChannel } from '../src/otp/channels.js'
import type { PortalDeps } from '../src/http.js'

/**
 * A whole portal in memory: its database, a real signing key, and a channel
 * that keeps the codes instead of sending them.
 *
 * Real Ed25519 throughout. A fake signer would make every test here pass
 * against a verifier that accepts anything, which is the one outcome these
 * tests exist to rule out.
 */

export interface TestPortal extends PortalDeps {
  db: SqlDriver
  channel: ReturnType<typeof memoryChannel>
  /** What a shop's build would carry in `config/licensing.ts`. */
  publicKeys: SigningKey[]
  close: () => Promise<void>
}

export async function testPortal(
  opts: { adminToken?: string | null; now?: () => Date; kid?: string } = {},
): Promise<TestPortal> {
  const db = openMemoryDatabase()
  await migratePortal(db)

  const pair = await generateKeypair(opts.kid ?? 'test-key')
  const channel = memoryChannel()

  return {
    db,
    channel,
    signingKey: await loadSigningKey(pair.privateKey),
    kid: pair.kid,
    adminToken: opts.adminToken === undefined ? 'admin-secret' : opts.adminToken,
    publicKeys: [{ kid: pair.kid, publicKey: pair.publicKey }],
    ...(opts.now === undefined ? {} : { now: opts.now }),
    close: () => db.close(),
  }
}

/** A shop database, migrated and bootstrapped, standing in for a till. */
export async function testTill(shopId: string): Promise<SqlDriver> {
  const { migrate } = await import('@shopos/core')
  const { MIGRATIONS } = await import('@shopos/core/migrations')
  const db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ('shop_id', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [shopId, new Date().toISOString()],
  )
  return db
}

/** A device store that keeps what it is given, for the clock high-water mark. */
export function testDevice(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    has: (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
      return true
    },
    all: () => Object.fromEntries(store),
  }
}
