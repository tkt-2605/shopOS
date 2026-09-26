import { eq, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../../db/migrationKinds.js'
import { deviceId } from '../../device.js'
import { newId } from '../../ids.js'
import { seedFeedWithEverything } from '../changefeed.js'
import { getSetting } from '../settings.js'
import { entitled } from '../licence.js'
import {
  mintPairingCode, myFingerprint, pairingKey, agreeSecret, comparisonDigits, type PairingKey,
} from '../syncAuth.js'
import { clock } from '../../clock.js'
import { type SyncRequest, type SyncResponse, type SyncServerOptions, ok, peerAddressFrom, refuse } from './wire.js'

/*
 * Letting a new till in: the code on offer, the join a person has to allow,
 * and the secret the two tills share afterwards -- agreed by ECDH, never sent.
 *
 * The state is module-level and lives here with everything that changes it --
 * an ES module can read another's `let` but never assign it.
 */

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

export let offered: LiveCode | null = null

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
 * The digits are **not** a secret, and they are worth comparing. Each till
 * sends a public key; the digits are taken from both (`comparisonDigits`), and
 * the joining till works them out for itself rather than reading ours. A
 * machine in the middle of the wifi has to swap in keys of its own to learn
 * the secret, and then the two screens show different numbers -- which is how
 * Bluetooth pairing works, and why it is worth a person's glance. The secret
 * is agreed from the same keys and never crosses the wire.
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
  /** The joining till's public key, as it asked with it. */
  joinerKey: string
  /** Ours for this pairing, made when the till first asked. */
  hostKey: PairingKey
  /** Agreed once, on the first poll after Allow, and the same for every poll
   *  after it. A reply that goes missing must leave the joining till able to
   *  ask again rather than holding half a pairing. */
  secret: string | null
  /** See `letThemIn`. */
  replaces: string | null
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
 * A till at the door, and a shop that has to be expecting one to hear it.
 *
 * Refused outside the window rather than queued. A prompt a shopkeeper did not
 * go looking for is one they will press to make go away, and the press is the
 * whole of the security here.
 */
export async function askingToJoin(
  theirDevice: string,
  label: string | null,
  joinerKey: string,
  now: number,
  /** The identity this till had before a restore, if it says so. */
  replaces: string | null = null,
): Promise<SyncResponse> {
  if (!expectingAJoin(now)) return refuse(403, 'NO_PAIRING_OFFERED')

  /* One at a time. Two prompts that swap under a shopkeeper's hand is how the
     wrong till gets let in, and a shop adds a second counter about as often as
     it buys one. */
  const live = pendingJoin(now)
  if (live !== null && live.deviceId !== theirDevice) return refuse(409, 'ANOTHER_TILL_IS_ASKING')

  /* Asking again — a reply that went missing, or a till restarted mid-walk —
     is the same request, not a new one. Re-minting would change the digits
     under a shopkeeper who is already looking at them. */
  if (live !== null && live.deviceId === theirDevice && pending !== null) {
    /* A till that restarted mid-walk asks with a new key. The digits follow
       the keys, so they change -- on both screens, since the joining till
       works its own out -- and the prompt is shown again with the new ones. */
    if (pending.joinerKey !== joinerKey) {
      pending.joinerKey = joinerKey
      pending.digits = await comparisonDigits(joinerKey, pending.hostKey.publicKey)
      announce()
    }
    return pendingAnswer(pending)
  }

  const hostKey = await pairingKey()
  pending = {
    requestId: newId(),
    deviceId: theirDevice,
    label,
    digits: await comparisonDigits(joinerKey, hostKey.publicKey),
    expiresAt: now + PAIRING_WINDOW_MS,
    decided: null,
    joinerKey,
    hostKey,
    secret: null,
    replaces,
  }
  announce()
  return pendingAnswer(pending)
}

/* Our public key goes back with every PENDING, so the joining till can work
   out the digits before anybody presses anything. */
function pendingAnswer(join: PendingJoin): SyncResponse {
  return ok({
    state: 'PENDING', requestId: join.requestId, digits: join.digits, publicKey: join.hostKey.publicKey,
  })
}

/** "May I yet?", asked every second or so by a till that is waiting. */
export async function pollingAJoin(
  db: SqlDriver,
  request: SyncRequest,
  requestId: string,
  theirDevice: string,
  joinerKey: string,
  now: number,
  opts: SyncServerOptions,
): Promise<SyncResponse> {
  const live = pending
  /* Answering about somebody else's request would tell a stranger on the wifi
     whether a shop is mid-pairing. It is also simply not their conversation.
     A different key is a different conversation too: the digits the person
     compared were worked out from the key that asked. */
  if (live === null || live.requestId !== requestId || live.deviceId !== theirDevice
    || live.joinerKey !== joinerKey) {
    return ok({ state: 'LAPSED' })
  }
  if (live.decided === 'refused') return ok({ state: 'REFUSED' })
  if (live.expiresAt <= now) return ok({ state: 'LAPSED' })
  if (live.decided === null) return pendingAnswer(live)

  /* Allowed. The secret is agreed on the first poll that gets here and kept,
     so that a reply lost on the way back is a poll that can be repeated rather
     than a shop holding half a pairing. */
  live.secret ??= await agreeSecret(live.hostKey, live.joinerKey, live.joinerKey, live.hostKey.publicKey)
  return await letThemIn(
    db, request, theirDevice, live.label, live.secret, live.hostKey.publicKey, now, opts,
    null, live.replaces,
  )
}

/**
 * Everything that is true however a till got in: it becomes a peer with a
 * secret and an address, and it is given the shop.
 */
export async function letThemIn(
  db: SqlDriver,
  request: SyncRequest,
  theirDevice: string,
  label: string | null,
  secret: string,
  /** Ours, so the joining till can agree the same secret. The secret is not sent. */
  publicKey: string,
  now: number,
  opts: SyncServerOptions,
  /** Kept and never consulted. Migration 047 says why it is taken now. */
  fingerprint: string | null = null,
  /**
   * The identity the joining till had before it was restored from a backup.
   * A restore gives a machine a new id (see `restore.rs`), and a till that
   * already knew the old one should swap it for the new rather than keep a
   * peer that will never answer again -- which pins the change feed and reads
   * as a counter that has gone quiet. Honoured only when it names a peer this
   * till holds.
   */
  replaces: string | null = null,
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
  /* Taking the place of a till this shop already has is not adding one, so
     the multi-till plan is not asked: a lapse must never stop a restored
     counter getting back in step with the till beside it. */
  const succeeding = replaces !== null && await isPeer(db, replaces)
  if (!succeeding && !await entitled(db, 'multiTill', opts)) return refuse(403, 'NEEDS_MULTI_TILL')

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
  if (succeeding) await handOver(db, replaces, theirDevice)

  await seedFeedWithEverything(db)

  return ok({
    state: 'ALLOWED',
    publicKey,
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

async function isPeer(db: SqlDriver, id: string): Promise<boolean> {
  const [row] = await q(db)
    .select({ id: schema.syncPeers.deviceId })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, id))
  return row !== undefined
}

/**
 * The old identity's counters pass to the new one, and the old peer goes.
 *
 * Its change-feed entries stay, still marked as having come from the old id --
 * which is what sends them to the new one: the bills that till rang up between
 * its backup and its restore are the ones it no longer has.
 */
async function handOver(db: SqlDriver, was: string, now: string): Promise<void> {
  await db.transaction(async (tx) => {
    const at = clock.iso()
    await q(tx).update(schema.registers)
      .set({ claimedBy: now, claimedAt: at, updatedAt: at })
      .where(eq(schema.registers.claimedBy, was))
    await q(tx).delete(schema.syncPeers).where(eq(schema.syncPeers.deviceId, was))
  })
}
