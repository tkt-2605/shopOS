import type { SqlDriver } from '../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { deviceId } from '../device.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import { applyBatch, changedHere, collectChanges } from './sync.js'
import { seedFeedWithEverything } from './changefeed.js'
import { getSetting } from './bootstrap.js'
import {
  constantTimeEquals, mintPairingCode, mintSecret, verify,
} from './syncAuth.js'

/**
 * The side of a sync that answers.
 *
 * Deliberately not a server. It takes a request that has already arrived and
 * returns what to send back, so the thing that actually listens on a port —
 * Rust in the app, `node:http` in the tests — is a pipe with no opinions, and
 * the protocol has exactly one implementation.
 *
 * That split is what lets the whole of this be tested over real sockets without
 * building the app, and it is why there is no second copy of these rules written
 * in Rust to drift away from this one.
 */

export interface SyncRequest {
  path: string
  /** The raw body exactly as it arrived. The signature covers these bytes. */
  body: string
  /** The signature header, absent on `/pair` which has no secret yet. */
  auth?: string | null
}

export interface SyncResponse {
  status: number
  body: string
}

/**
 * A pairing code, live in memory only.
 *
 * Not in the database: it lives for minutes, is used once, and a code sitting in
 * a table would be one more thing to clean up, one more thing a backup carries,
 * and one more thing to leak. A restart cancelling it is correct — a code
 * somebody walked away from should not still work tomorrow.
 */
interface LiveCode {
  code: string
  expiresAt: number
}

let offered: LiveCode | null = null

export const PAIRING_WINDOW_MS = 10 * 60 * 1000

/** Shown on the till that already has the shop. */
export function offerPairing(now = Date.now()): string {
  const code = mintPairingCode()
  offered = { code, expiresAt: now + PAIRING_WINDOW_MS }
  return code
}

/** After a successful pair, and whenever the screen showing it is closed. */
export function withdrawPairing(): void {
  offered = null
}

export function pairingOnOffer(now = Date.now()): string | null {
  if (offered === null) return null
  return offered.expiresAt > now ? offered.code : null
}

export async function handleSyncRequest(
  db: SqlDriver,
  request: SyncRequest,
  now = Date.now(),
): Promise<SyncResponse> {
  if (request.path === '/pair') return handlePair(db, request, now)

  const auth = await verify(
    request.auth, request.path, request.body,
    async (id) => {
      const row = await db.get<{ secret: string | null }>(
        `SELECT secret FROM sync_peers WHERE device_id = ?`, [id],
      )
      return row?.secret ?? null
    },
    now,
  )
  if (!auth.ok) return refuse(401, auth.code)

  switch (request.path) {
    case '/hello': return handleHello(db, auth.deviceId)
    case '/fetch': return handleFetch(db, request, auth.deviceId)
    case '/offer': return handleOffer(db, request, auth.deviceId)
    default: return refuse(404, 'NO_SUCH_REQUEST')
  }
}

/**
 * Redeeming a code for a shared secret.
 *
 * The only request without a signature, because it is the one that agrees what
 * the signature will be made with. Everything that makes a short typed code safe
 * is here: it lives for minutes, it is compared without leaking how nearly right
 * a guess was, and **any attempt withdraws it** — right or wrong.
 *
 * Burning the code on a wrong guess rather than allowing retries is what makes
 * eight characters enough. Guessing becomes a matter of persuading a person to
 * read a fresh code out each time, which is not an attack on software.
 */
async function handlePair(
  db: SqlDriver,
  request: SyncRequest,
  now: number,
): Promise<SyncResponse> {
  const asked = parse<{ code?: string; deviceId?: string; label?: string }>(request.body)
  if (asked === null) return refuse(400, 'MALFORMED')

  const live = offered
  const given = typeof asked.code === 'string' ? asked.code.trim().toUpperCase() : ''
  const theirDevice = typeof asked.deviceId === 'string' ? asked.deviceId.trim() : ''

  // Whatever happens next, this code is spent.
  withdrawPairing()

  if (live === null || live.expiresAt <= now) return refuse(403, 'NO_PAIRING_OFFERED')
  if (theirDevice === '') return refuse(400, 'MALFORMED')
  if (!constantTimeEquals(live.code, given)) return refuse(403, 'WRONG_CODE')

  const secret = mintSecret()
  await db.execute(
    `INSERT INTO sync_peers (device_id, label, secret, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET label = excluded.label, secret = excluded.secret`,
    [theirDevice, asked.label ?? null, secret, new Date(now).toISOString()],
  )

  /* A till that has just joined has none of the shop, and the feed only holds
     what has changed since migration 021 -- on a shop that had been selling for
     a year, two rows. Without this, pairing succeeds, syncing succeeds, and
     nothing arrives. */
  await seedFeedWithEverything(db)

  return ok({
    secret,
    deviceId: deviceId(),
    label: await getSetting(db, 'shop_name'),
    shopId: await getSetting(db, 'shop_id'),
    schemaVersion: EXPECTED_SCHEMA_VERSION,
  })
}

async function handleHello(db: SqlDriver, them: string): Promise<SyncResponse> {
  const row = await db.get<{ their_cursor: number }>(
    `SELECT their_cursor FROM sync_peers WHERE device_id = ?`, [them],
  )
  return ok({
    deviceId: deviceId(),
    label: await getSetting(db, 'shop_name'),
    shopId: await getSetting(db, 'shop_id'),
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    // How far we have read of theirs is, from where they stand, how far they
    // have been read. The two cursors are one number seen from two sides.
    yourCursorWithThem: row?.their_cursor ?? 0,
  })
}

async function handleFetch(
  db: SqlDriver,
  request: SyncRequest,
  them: string,
): Promise<SyncResponse> {
  const asked = parse<{ since?: number; limit?: number }>(request.body)
  if (asked === null) return refuse(400, 'MALFORMED')

  const since = Number.isFinite(asked.since) ? Number(asked.since) : 0
  const limit = Number.isFinite(asked.limit) ? Math.min(Number(asked.limit), 500) : 200

  /* Their cursor is recorded from what they ask for, not from what we send. A
     till asking for everything after 40 has told us it has 40, and that is the
     only claim about their progress we have any business believing. */
  await db.execute(
    `UPDATE sync_peers SET my_cursor = ? WHERE device_id = ? AND my_cursor < ?`,
    [since, them, since],
  )

  return ok(await collectChanges(db, since, limit))
}

/**
 * Taking a batch.
 *
 * Idempotent, and it has to be: a batch that we applied and acknowledged, whose
 * acknowledgement was lost on the way back, arrives again. Applying it twice
 * must be the same as applying it once — which it is, because every record is
 * decided against what is already here and an identical copy loses the tiebreak
 * and writes nothing.
 */
async function handleOffer(
  db: SqlDriver,
  request: SyncRequest,
  them: string,
): Promise<SyncResponse> {
  const batch = parse<ChangeBatch>(request.body)
  if (batch === null || !Array.isArray(batch.records)) return refuse(400, 'MALFORMED')

  if (batch.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    return refuse(409, 'SCHEMA_MISMATCH')
  }

  /* The batch says who it is from and the signature says who sent it. If those
     disagree, one of them is lying and neither is worth acting on. */
  if (batch.fromDevice !== them) return refuse(403, 'NOT_YOUR_BATCH')

  const row = await db.get<{ their_cursor: number }>(
    `SELECT their_cursor FROM sync_peers WHERE device_id = ?`, [them],
  )

  const both = await changedHere(db, row?.their_cursor ?? 0)
  await applyBatch(db, batch, both)

  await db.execute(
    `UPDATE sync_peers SET their_cursor = ?, last_agreed_at = ? WHERE device_id = ? AND their_cursor < ?`,
    [batch.upTo, new Date().toISOString(), them, batch.upTo],
  )

  return ok({ upTo: batch.upTo })
}

function ok(payload: unknown): SyncResponse {
  return { status: 200, body: JSON.stringify(payload) }
}

function refuse(status: number, code: string): SyncResponse {
  return { status, body: JSON.stringify({ code }) }
}

function parse<T>(body: string): T | null {
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}
