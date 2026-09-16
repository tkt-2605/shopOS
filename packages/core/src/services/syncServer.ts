import type { SqlDriver } from '../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../db/migrationKinds.js'
import { deviceId } from '../device.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import { applyBatch, changedHere, collectChanges } from './sync.js'
import { seedFeedWithEverything } from './changefeed.js'
import { resolveDeviceRegister } from './registers.js'
import { getSetting } from './bootstrap.js'
import {
  constantTimeEquals, mintPairingCode, mintSecret, verify,
} from './syncAuth.js'
import { clock } from '../clock.js'

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
  /**
   * The IP the request came from, as the listener saw it, and the port the
   * caller says it is listening on — together, where to reach that till.
   *
   * Supplied by whatever is holding the socket (`sync_server.rs` in the app,
   * `node:http` in the bench), because it is the only thing that knows. This is
   * how the answering till learns an address at all: before this, a till that
   * had been *joined* had a peer row with a secret and no address, and
   * `pairedPeers` filters on `address IS NOT NULL` — so the front counter had
   * zero peers it could reach and could receive a sync but never start one.
   *
   * The port is taken from an unsigned header, so a peer could lie about it.
   * That buys nothing: the address is only ever used to open a connection that
   * must then authenticate with the shared secret, so a wrong one is a failed
   * round and not a disclosure.
   */
  remoteAddress?: string | null
  listenPort?: number | null
}

/** The header a till advertises its own listening port in. */
export const LISTEN_PORT_HEADER = 'x-shopos-port'

/**
 * Where a till that just contacted us can be reached, or null if we cannot say.
 *
 * Both halves are required. An IP with no port is not an address, and a port
 * with no IP would have to be guessed — and a guessed address that happens to
 * resolve is worse than none, because it points the shop's sync at a stranger.
 */
export function peerAddressFrom(request: SyncRequest): string | null {
  const host = request.remoteAddress?.trim()
  const port = request.listenPort
  if (!host || typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return null
  // IPv6 needs brackets in a URL, and `::ffff:127.0.0.1` is how a dual-stack
  // listener reports a plain IPv4 caller.
  const plain = host.startsWith('::ffff:') ? host.slice(7) : host
  const bracketed = plain.includes(':') ? `[${plain}]` : plain
  return `http://${bracketed}:${port}`
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

/**
 * Which counter this till sits at, told to us by the app at startup.
 *
 * The answering side has no way to ask `device.json` — that is the webview's —
 * so it is handed in. Null means never chosen, and `resolveDeviceRegister` then
 * falls back to the first active counter, which is exactly the case the asking
 * side refuses.
 */
let servingRegister: string | null = null
let servingRegisterSource: (() => string | null) | null = null

export function serveAs(registerId: string | null): void {
  servingRegister = registerId
}

/**
 * For a host serving more than one till from one process — `tools/virtual-till`.
 *
 * Same reasoning as `setDeviceIdSource`, and the same failure if it is missing:
 * two tills sharing this global answer `/hello` with one another's counter, so
 * the `SAME_REGISTER` refusal that `same-register.test.ts` exists to prove
 * either never fires or fires against the wrong till. The app never calls this.
 */
export function setServingRegisterSource(fn: (() => string | null) | null): void {
  servingRegisterSource = fn
}

function currentServingRegister(): string | null {
  return servingRegisterSource ? servingRegisterSource() : servingRegister
}

export const PAIRING_WINDOW_MS = 10 * 60 * 1000

/** Shown on the till that already has the shop. */
export function offerPairing(now = clock.now()): string {
  const code = mintPairingCode()
  offered = { code, expiresAt: now + PAIRING_WINDOW_MS }
  return code
}

/** After a successful pair, and whenever the screen showing it is closed. */
export function withdrawPairing(): void {
  offered = null
}

export function pairingOnOffer(now = clock.now()): string | null {
  if (offered === null) return null
  return offered.expiresAt > now ? offered.code : null
}

export async function handleSyncRequest(
  db: SqlDriver,
  request: SyncRequest,
  now = clock.now(),
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

  /* On every accepted request, not only on pairing. A till moves desks, the
     router hands out a new lease overnight, the shop swaps the switch — and
     the address recorded the day they paired stops working, with nothing to
     re-record it. The request that just authenticated is proof of where that
     till is *now*, and it is the cheapest possible place to learn it.

     Only after `auth.ok`, so an unauthenticated caller cannot move a peer's
     address and make the shop's next sync dial them instead. */
  const seenAt = peerAddressFrom(request)
  if (seenAt !== null) {
    await db.execute(
      `UPDATE sync_peers SET address = ? WHERE device_id = ? AND (address IS NOT ? OR address IS NULL)`,
      [seenAt, auth.deviceId, seenAt],
    )
  }

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
  /* The address, here, at the one moment both tills are certainly talking.
     Without it the joining till is recorded as a peer that cannot be reached,
     which reads on every later screen as a till that is paired and quiet. */
  const address = peerAddressFrom(request)
  await db.execute(
    `INSERT INTO sync_peers (device_id, label, secret, address, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET
       label = excluded.label, secret = excluded.secret,
       address = COALESCE(excluded.address, sync_peers.address)`,
    [theirDevice, asked.label ?? null, secret, address, new Date(now).toISOString()],
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
    minPeerSchema: MIN_PEER_SCHEMA_VERSION,
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
    minPeerSchema: MIN_PEER_SCHEMA_VERSION,
    /* Which counter this till bills on. Two tills on one counter mint invoice
       numbers from the same series, so the asking side refuses before a bill
       crosses and collides. */
    registerId: await resolveDeviceRegister(db, currentServingRegister()),
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

  /* The same floor the handshake applies, applied again to the batch itself.
     Equality here would have undone Phase 2c entirely: the asking till would
     agree at `hello` and then have every batch it pushed refused, which is a
     shop that reports a successful sync and moves nothing in one direction. */
  if (batch.schemaVersion < MIN_PEER_SCHEMA_VERSION) {
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
    [batch.upTo, clock.iso(), them, batch.upTo],
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
