import { eq, and, lt, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../db/migrationKinds.js'
import { deviceId } from '../device.js'
import { newId } from '../ids.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import type { SigningKey } from '../domain/licence.js'
import { applyBatch, changedHere, collectChanges } from './sync.js'
import { seedFeedWithEverything, feedHead } from './changefeed.js'
import { resolveDeviceRegister } from './registers.js'
import { getSetting } from './bootstrap.js'
import { entitled } from './licence.js'
import {
  constantTimeEquals, mintPairingCode, mintSecret, verify, myFingerprint,
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
 * A till standing at the door, waiting to be let in.
 *
 * The typed code exists because a till had no other way to prove it was the one
 * the shopkeeper meant. It is a poor way: eight characters read off one screen
 * and typed into another, spent whether the guess was right or wrong, dead in
 * ten minutes. A person who mistypes it walks back to the other machine.
 *
 * So the joining till asks instead, and the till that already has the shop is
 * the one that says yes — the pattern a phone and a speaker have used for
 * years. What authenticates is a person pressing Allow on the machine that is
 * already trusted, which is the thing the code was standing in for all along.
 *
 * The digits are **not** a secret and nothing is checked against them. They
 * exist so the person at this till can tell that the machine asking is the
 * machine they are standing next to, the way Bluetooth shows the same number on
 * both screens. Bluetooth derives its number from a key exchange, which makes
 * comparing it proof that nobody is in the middle; that would be ceremony here,
 * over a wire that already carries bills in the clear and says so on this same
 * screen. Two digits, and honest about what they are for.
 *
 * Only ever while the shop is expecting somebody — see `expectJoin`. A till
 * that accepted requests all day would let anybody on the wifi raise a prompt
 * on the shopkeeper's screen, which is an attack on the person rather than on
 * the software and is no less effective for it.
 */
interface PendingJoin {
  requestId: string
  deviceId: string
  label: string | null
  digits: string
  expiresAt: number
  decided: 'allowed' | 'refused' | null
  /** Minted once, on the first poll after Allow, and handed back to every poll
   *  after it. A reply that goes missing must leave the joining till able to
   *  ask again rather than holding half a pairing. */
  secret: string | null
}

let pending: PendingJoin | null = null
let watching: ((join: JoinRequest | null) => void) | null = null

/** What a screen needs to show about the till at the door. */
export interface JoinRequest {
  requestId: string
  deviceId: string
  label: string | null
  digits: string
}

function announce(): void {
  watching?.(pendingJoin())
}

/**
 * A screen watching the door.
 *
 * `handleSyncRequest` runs in the webview — Rust holds the socket and forwards
 * the bytes — so the request that wants to join is already on the same side of
 * the wall as the screen that has to ask about it. No event plumbing needed.
 */
export function onJoinRequest(fn: ((join: JoinRequest | null) => void) | null): void {
  watching = fn
}

export function pendingJoin(now = clock.now()): JoinRequest | null {
  if (pending === null || pending.expiresAt <= now || pending.decided !== null) return null
  const { requestId, deviceId: device, label, digits } = pending
  return { requestId, deviceId: device, label, digits }
}

export function allowJoin(requestId: string): void {
  if (pending?.requestId === requestId) pending.decided = 'allowed'
  announce()
}

export function refuseJoin(requestId: string): void {
  if (pending?.requestId === requestId) pending.decided = 'refused'
  announce()
}

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

/**
 * Shown on the till that already has the shop.
 *
 * Also what opens the door: the same call that mints a code is the one that
 * says the shop is expecting somebody, so both ways in — a till that asks, and
 * a till that was typed a code — are open for exactly as long as a person is
 * standing there adding one, and shut the rest of the time.
 */
export function offerPairing(now = clock.now()): string {
  const code = mintPairingCode()
  offered = { code, expiresAt: now + PAIRING_WINDOW_MS }
  return code
}

/** Whether a till asking to come in would be heard at all. */
export function expectingAJoin(now = clock.now()): boolean {
  return offered !== null && offered.expiresAt > now
}

/** After a successful pair, and whenever the screen showing it is closed. */
export function withdrawPairing(): void {
  offered = null
  pending = null
  announce()
}

export function pairingOnOffer(now = clock.now()): string | null {
  if (offered === null) return null
  return offered.expiresAt > now ? offered.code : null
}

/**
 * What the answering side needs told rather than looked up.
 *
 * Only the licence keys, and only so that a test can pair two tills. The build
 * ships one real public key and no test can mint a token for it, so without
 * this seam every sync test would have to carry the production *private* key —
 * which is the one thing that must never be in this repository.
 */
export interface SyncServerOptions {
  /** Defaults to the build's own `LICENCE_KEYS`. Tests pass their own. */
  keys?: readonly SigningKey[]
}

export async function handleSyncRequest(
  db: SqlDriver,
  request: SyncRequest,
  now = clock.now(),
  opts: SyncServerOptions = {},
): Promise<SyncResponse> {
  if (request.path === '/pair') return handlePair(db, request, now, opts)

  const auth = await verify(
    request.auth, request.path, request.body,
    async (id) => {
      const [row] = await q(db)
        .select({ secret: schema.syncPeers.secret })
        .from(schema.syncPeers)
        .where(eq(schema.syncPeers.deviceId, id))
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
    /* `IS NOT` rather than `<>`, because the column is nullable and a peer
       recorded without an address has NULL in it -- which `<>` answers NULL
       for, and the row is never updated. */
    await q(db).update(schema.syncPeers)
      .set({ address: seenAt })
      .where(and(
        eq(schema.syncPeers.deviceId, auth.deviceId),
        sql`${schema.syncPeers.address} IS NOT ${seenAt}`,
      ))
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
  opts: SyncServerOptions,
): Promise<SyncResponse> {
  const asked = parse<{
    code?: string; deviceId?: string; label?: string; requestId?: string
    fingerprint?: string
  }>(request.body)
  if (asked === null) return refuse(400, 'MALFORMED')

  const theirDevice = typeof asked.deviceId === 'string' ? asked.deviceId.trim() : ''
  if (theirDevice === '') return refuse(400, 'MALFORMED')

  /* Three messages arrive on this one path, because they are three turns of one
     conversation and a shop's firewall should not need a fourth port opened to
     hold it: a till asking to come in, that till asking whether it may yet, and
     the old way — a till that was read a code. */
  if (typeof asked.requestId === 'string') {
    return await pollingAJoin(db, request, asked.requestId.trim(), theirDevice, now, opts)
  }
  if (typeof asked.code !== 'string') {
    return askingToJoin(theirDevice, asked.label ?? null, now)
  }

  const live = offered
  const given = asked.code.trim().toUpperCase()

  // Whatever happens next, this code is spent.
  withdrawPairing()

  if (live === null || live.expiresAt <= now) return refuse(403, 'NO_PAIRING_OFFERED')
  if (!constantTimeEquals(live.code, given)) return refuse(403, 'WRONG_CODE')

  return await letThemIn(
    db, request, theirDevice, asked.label ?? null, mintSecret(), now, opts,
    typeof asked.fingerprint === 'string' ? asked.fingerprint : null,
  )
}

/**
 * A till at the door, and a shop that has to be expecting one to hear it.
 *
 * Refused outside the window rather than queued. A prompt a shopkeeper did not
 * go looking for is one they will press to make go away, and the press is the
 * whole of the security here.
 */
function askingToJoin(
  theirDevice: string,
  label: string | null,
  now: number,
): SyncResponse {
  if (!expectingAJoin(now)) return refuse(403, 'NO_PAIRING_OFFERED')

  /* One at a time. Two prompts that swap under a shopkeeper's hand is how the
     wrong till gets let in, and a shop adds a second counter about as often as
     it buys one. */
  const live = pendingJoin(now)
  if (live !== null && live.deviceId !== theirDevice) return refuse(409, 'ANOTHER_TILL_IS_ASKING')

  /* Asking again — a reply that went missing, or a till restarted mid-walk —
     is the same request, not a new one. Re-minting would change the digits
     under a shopkeeper who is already looking at them. */
  if (live !== null && live.deviceId === theirDevice) {
    return ok({ state: 'PENDING', requestId: live.requestId, digits: live.digits })
  }

  pending = {
    requestId: newId(),
    deviceId: theirDevice,
    label,
    digits: mintDigits(),
    expiresAt: now + PAIRING_WINDOW_MS,
    decided: null,
    secret: null,
  }
  announce()
  return ok({ state: 'PENDING', requestId: pending.requestId, digits: pending.digits })
}

/** "May I yet?", asked every second or so by a till that is waiting. */
async function pollingAJoin(
  db: SqlDriver,
  request: SyncRequest,
  requestId: string,
  theirDevice: string,
  now: number,
  opts: SyncServerOptions,
): Promise<SyncResponse> {
  const live = pending
  /* Answering about somebody else's request would tell a stranger on the wifi
     whether a shop is mid-pairing. It is also simply not their conversation. */
  if (live === null || live.requestId !== requestId || live.deviceId !== theirDevice) {
    return ok({ state: 'LAPSED' })
  }
  if (live.decided === 'refused') return ok({ state: 'REFUSED' })
  if (live.expiresAt <= now) return ok({ state: 'LAPSED' })
  if (live.decided === null) return ok({ state: 'PENDING', requestId, digits: live.digits })

  /* Allowed. The secret is minted on the first poll that gets here and kept, so
     that a reply lost on the way back is a poll that can be repeated rather
     than a shop holding half a pairing. */
  live.secret ??= mintSecret()
  return await letThemIn(db, request, theirDevice, live.label, live.secret, now, opts)
}

/**
 * Everything that is true however a till got in: it becomes a peer with a
 * secret and an address, and it is given the shop.
 */
async function letThemIn(
  db: SqlDriver,
  request: SyncRequest,
  theirDevice: string,
  label: string | null,
  secret: string,
  now: number,
  opts: SyncServerOptions,
  /** Kept and never consulted. Migration 047 says why it is taken now. */
  fingerprint: string | null = null,
): Promise<SyncResponse> {
  /* The one place a till becomes a peer, whichever way it got here, and so the
     one place the multi-till plan is checked. The button on the other screen
     checks too, and that check is the one a person sees — but a UI gate is a
     suggestion to anyone who can post to this port, and this is the row that
     matters.

     Deliberately *not* checked anywhere rows move: `handleHello`, `handleFetch`
     and `handleOffer` never ask. A lapsed shop keeps every till it has and
     goes on merging, because billing never stops and two counters that take
     money without merging would corrupt the books in a way nobody notices for
     weeks. See the note above GATED in `domain/licence.ts`. */
  if (!await entitled(db, 'multiTill', opts)) return refuse(403, 'NEEDS_MULTI_TILL')

  /* The address, here, at the one moment both tills are certainly talking.
     Without it the joining till is recorded as a peer that cannot be reached,
     which reads on every later screen as a till that is paired and quiet. */
  const address = peerAddressFrom(request)
  await q(db).insert(schema.syncPeers)
    .values({
      deviceId: theirDevice,
      label,
      secret,
      address,
      fingerprint,
      createdAt: new Date(now).toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.syncPeers.deviceId,
      set: {
        label,
        secret,
        /* The address only if this pairing learned one. A till re-pairing over
           a request that carried no port would otherwise forget where the
           other one is and go quiet with nothing saying why. */
        address: sql`COALESCE(${address ?? null}, ${schema.syncPeers.address})`,
        // Same reasoning: a re-pair that carried none must not forget one.
        fingerprint: sql`COALESCE(${fingerprint ?? null}, ${schema.syncPeers.fingerprint})`,
      },
    })

  /* A till that has just joined has none of the shop, and the feed only holds
     what has changed since migration 021 -- on a shop that had been selling for
     a year, two rows. Without this, pairing succeeds, syncing succeeds, and
     nothing arrives. */
  await seedFeedWithEverything(db)

  return ok({
    state: 'ALLOWED',
    secret,
    /* Ours, so the joining till has it too. Null today, and the exchange is
       symmetric so that when there is one to send neither side has to be the
       one that was upgraded first. */
    fingerprint: myFingerprint(),
    deviceId: deviceId(),
    label: await getSetting(db, 'shop_name'),
    shopId: await getSetting(db, 'shop_id'),
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    minPeerSchema: MIN_PEER_SCHEMA_VERSION,
  })
}

/**
 * Two digits, for a person to compare — not a secret, and nothing is ever
 * checked against them. `PendingJoin` says why that is the honest design here.
 */
function mintDigits(): string {
  return String(Math.floor(Math.random() * 100)).padStart(2, '0')
}

async function handleHello(db: SqlDriver, them: string): Promise<SyncResponse> {
  const [row] = await q(db)
    .select({ theirCursor: schema.syncPeers.theirCursor })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, them))
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
    yourCursorWithThem: row?.theirCursor ?? 0,
    /* And how far ours goes, which is the half that was missing. Without it the
       asking till can work out what it owes us and cannot work out what we owe
       it — so its screen says "everything sent" while it is ninety-five bills
       short, and every total it prints is short with them. */
    head: await feedHead(db),
    /* Answering this request is the proof. A peer that cannot be dialled never
       reaches this code, so the value is always true here — and it is sent
       anyway, because the field is how a client that *cannot* answer says so
       when it is the one holding the conversation. */
    answers: true,
    /* This till's own clock. Nothing secret — the request that got here was
       signed with a timestamp of the caller's, so both machines already know
       each other's idea of the time. What it buys is the shop being told while
       the two are still talking, rather than at the moment every round starts
       failing with `STALE`. */
    now: clock.now(),
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
  /* Never backwards. A request that arrives out of order carries an older
     cursor, and moving it back would send everything between twice. */
  await q(db).update(schema.syncPeers)
    .set({ myCursor: since })
    .where(and(
      eq(schema.syncPeers.deviceId, them),
      lt(schema.syncPeers.myCursor, since),
    ))

  return ok(await collectChanges(db, since, limit, them))
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
export async function handleOffer(
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

  const [row] = await q(db)
    .select({
      theirCursor: schema.syncPeers.theirCursor,
      myCursor: schema.syncPeers.myCursor,
    })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, them))

  /* `my_cursor`, and the distinction is the whole of it. `changedHere` asks
     which of *this* till's rows have moved since a point in *this* till's feed,
     and the two cursors count in different feeds: `their_cursor` is how far this
     till has read into theirs. They sit at the same number only while both tills
     have written the same amount, and they run apart the moment one counter is
     busier than the other — the feed is a set, so an edit replaces an entry and
     still burns a seq.
 
     Handed `their_cursor`, this asked "what have we changed since a point that
     means nothing here". Too high and every genuine clash goes unreported: the
     losing edit is dropped and `sync_conflicts` stays empty, which is the one
     failure this table exists to prevent. Too low and the shop is told about
     conflicts it does not have. */
  const both = await changedHere(db, row?.myCursor ?? 0, batch.records)
  await applyBatch(db, batch, both)

  await q(db).update(schema.syncPeers)
    .set({ theirCursor: batch.upTo, lastAgreedAt: clock.iso() })
    .where(and(
      eq(schema.syncPeers.deviceId, them),
      lt(schema.syncPeers.theirCursor, batch.upTo),
    ))

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
