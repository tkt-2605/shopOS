import { eq, ne, and, isNotNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { deviceId, replacedDevice } from '../device.js'
import { myFingerprint, keyCommitment, codeProof, codeConfirmation, constantTimeEquals } from './syncAuth.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import type { PeerHello, SyncTransport } from './sync.js'
import {
  encodeAuth, sign, replyIsGenuine, pairingKey, agreeSecret, comparisonDigits, isPairingPublicKey,
  type PairingKey,
} from './syncAuth.js'
import { LISTEN_PORT_HEADER } from './syncServer.js'
import { clock } from '../clock.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../db/migrationKinds.js'
import { assertSafeToSpeak } from './sync/reach.js'
import { joinedMain } from './sync/layout.js'

/**
 * The side of a sync that asks.
 *
 * Written against `fetch`, and given one rather than reaching for the global,
 * because who can actually make the request differs by host. The bench passes
 * Node's, over real sockets. The app cannot pass its own: a webview may not
 * listen on a port, and under this app's CSP -- `connect-src` inherited from
 * `default-src 'self'` -- it may not call another till either. The request is
 * refused before a packet leaves, and it surfaces as "Failed to fetch", which
 * reads exactly like a till that is switched off. So the app passes a fetch
 * shaped like this one that hands the parts to Rust; `syncFetch.ts` is it.
 *
 * Which is to say both halves of a sync end up in Rust in the app, and this
 * file cares about neither: it is the protocol, and the socket is the host's.
 */

export interface PeerAddress {
  deviceId: string
  /** `http://192.168.1.14:7801`, as last reached. A hint, never an authority. */
  baseUrl: string
  secret: string
  /** `lan` or `cloud`; a `none` peer never appears here. See migration 044. */
  reach: string
}

export class SyncHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The other till refused: ${code}`)
    this.name = 'SyncHttpError'
  }
}

/**
 * Talks to a till that this one has already paired with.
 *
 * Every request is signed with the shared secret over its own body, so nothing
 * that arrives at the far side can have been altered on the way and nothing
 * captured can be sent again. The secret itself is never in a request.
 */
/**
 * The port this till is listening on, told to whoever it contacts.
 *
 * Passed rather than read from a global because the webview does not own the
 * socket — Rust does, and it reports the port back. Null when this till is not
 * listening at all, which is every single-device shop and is not an error.
 */
export interface SelfAddress {
  listenPort?: number | null
}

export function httpTransport(
  peer: PeerAddress,
  fetchImpl: typeof fetch = fetch,
  self: SelfAddress = {},
): SyncTransport {
  async function ask<T>(path: string, payload: unknown): Promise<T> {
    const me = deviceId()
    if (me === null) throw new Error('This machine does not know which machine it is')

    const body = JSON.stringify(payload)
    const signed = await sign(peer.secret, me, path, body)

    assertSafeToSpeak(peer.baseUrl)
    const response = await fetchImpl(`${peer.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopos-auth': encodeAuth(signed),
        ...(typeof self.listenPort === 'number'
          ? { [LISTEN_PORT_HEADER]: String(self.listenPort) }
          : {}),
      },
      body,
    })

    const text = await opened(await response.text(), response.status, peer.secret, signed.nonce)
    if (!response.ok) {
      let code = `HTTP_${response.status}`
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
          code = String((parsed as { code: unknown }).code)
        }
      } catch { /* a body that is not ours; the status is what matters */ }
      throw new SyncHttpError(response.status, code)
    }
    return JSON.parse(text) as T
  }

  return {
    /* Our version, so a till we ask that is behind us learns it is. A build
       from before this sends nothing and the far side reads nothing into it. */
    hello: (main) => ask<PeerHello>('/hello', {
      schemaVersion: EXPECTED_SCHEMA_VERSION, minPeerSchema: MIN_PEER_SCHEMA_VERSION,
      /* Who we believe is the main. An old main that came back is dialled by
         nobody and hears it only here, from a till that asks it something. */
      ...(main === undefined ? {} : { mainDevice: main.device, mainEpoch: main.epoch }),
    }),
    fetch: (since, limit) => ask<ChangeBatch>('/fetch', { since, limit }),
    offer: (batch) => ask<{ upTo: number }>('/offer', batch),
  }
}

/**
 * The body of an answer, once its signature has checked out.
 *
 * Every answer to a signed request comes back signed over its status, its body
 * and the nonce of the request it answers (`sealed` on the far side). One that
 * is not, or does not check, is refused -- except a refusal given before the
 * far side knew who was asking, which it had no secret to sign and which can
 * do no more than stop this round.
 */
async function opened(text: string, status: number, secret: string, nonce: string): Promise<string> {
  let envelope: { reply?: unknown; mac?: unknown } | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') envelope = parsed as { reply?: unknown; mac?: unknown }
  } catch { /* not JSON at all */ }

  if (envelope !== null && typeof envelope.reply === 'string' && typeof envelope.mac === 'string') {
    if (!await replyIsGenuine(secret, nonce, status, envelope.reply, envelope.mac)) {
      throw new SyncHttpError(502, 'BAD_REPLY_SIGNATURE')
    }
    return envelope.reply
  }
  if (status >= 200 && status < 300) throw new SyncHttpError(502, 'UNSIGNED_REPLY')
  return text
}

export interface PairOutcome {
  deviceId: string
  label: string | null
  shopId: string | null
  schemaVersion: number
  /**
   * The other till's certificate fingerprint, if it had one to give.
   *
   * Null on every build today, and kept rather than checked. Migration 047 sets
   * out why it is taken now: pairing is the only exchange two tills have before
   * they trust each other, a shop performs it once by hand, and a build that
   * adds the field later cannot ask a shop to re-pair every till it owns.
   */
  fingerprint?: string | null
  /**
   * Which till this one now syncs through, and at which epoch. Absent from a
   * shop paired before there was a main. See `sync/layout.ts`.
   */
  mainDevice?: string | null
  mainEpoch?: number
}

/**
 * Joining a shop, once, with a code read off the other till's screen.
 *
 * The only request made without a signature, because it is the one that settles
 * what the signature will be made with. Everything after it is signed.
 *
 * The secret is written here before anything is synced, so a pairing that
 * succeeds on the far side and then fails on the way back leaves this till able
 * to try again rather than holding a code the other side has already spent.
 */
export async function pairWith(
  db: SqlDriver,
  baseUrl: string,
  code: string,
  label: string | null = null,
  fetchImpl: typeof fetch = fetch,
  self: SelfAddress = {},
): Promise<PairOutcome> {
  const me = deviceId()
  if (me === null) throw new Error('This machine does not know which machine it is')
  const key = await pairingKey()

  assertSafeToSpeak(baseUrl)
  const response = await fetchImpl(`${baseUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // So the till being joined can record where to reach this one. Without
      // it the far side keeps a peer row with a secret and no address, and a
      // sync it starts has nowhere to go.
      ...(typeof self.listenPort === 'number'
        ? { [LISTEN_PORT_HEADER]: String(self.listenPort) }
        : {}),
    },
    body: JSON.stringify({
      /* Not the code: a proof of it, bound to our key. See `codeProof`. */
      proof: await codeProof(code, me, key.publicKey), deviceId: me, label, publicKey: key.publicKey,
      // Symmetric, so that when there is one to send neither side has to be
      // the one that was upgraded first.
      fingerprint: myFingerprint(),
      ...succeeding(),
    }),
  })

  const text = await response.text()
  if (!response.ok) throw new SyncHttpError(response.status, codeIn(text, response.status))

  const said = JSON.parse(text) as Record<string, unknown>
  /* The shop proves it knows the code too, over both keys, before anything it
     said is believed. A key swapped in the middle fails here. */
  if (typeof said['publicKey'] !== 'string' || typeof said['confirm'] !== 'string'
    || !constantTimeEquals(await codeConfirmation(code, me, key.publicKey, said['publicKey']), said['confirm'])) {
    throw new SyncHttpError(502, 'NOT_THE_SHOP')
  }
  const outcome = await agreed(said, key)
  await rememberTheShop(db, baseUrl, outcome)
  return justTheShop(outcome)
}

/* The secret is written to `sync_peers` and goes no further. A caller that had
   it in hand would eventually put it on a screen or in a log. */
function justTheShop(o: PairOutcome & { secret: string }): PairOutcome {
  return {
    deviceId: o.deviceId, label: o.label, shopId: o.shopId,
    schemaVersion: o.schemaVersion, fingerprint: o.fingerprint ?? null,
    mainDevice: o.mainDevice ?? null, mainEpoch: o.mainEpoch ?? 0,
  }
}

/** The refusal code out of a body, without trusting it to be ours or to be JSON. */
function codeIn(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
      return String((parsed as { code: unknown }).code)
    }
  } catch { /* not ours */ }
  return `HTTP_${status}`
}

/**
 * What a shop says about itself when it lets a till in, checked before use,
 * with the secret worked out here from its public key and ours. The shop never
 * sends the secret; a reply that tried to would be ignored.
 */
async function agreed(
  said: Record<string, unknown> | (Partial<PairOutcome> & { publicKey?: string }),
  mine: PairingKey,
): Promise<PairOutcome & { secret: string }> {
  const it = said as PairOutcome & { publicKey?: unknown }
  if (!isPairingPublicKey(it.publicKey) || typeof it.deviceId !== 'string') {
    throw new SyncHttpError(502, 'MALFORMED')
  }
  const secret = await agreeSecret(mine, it.publicKey, mine.publicKey, it.publicKey)
  return {
    deviceId: it.deviceId, label: it.label ?? null, shopId: it.shopId ?? null,
    schemaVersion: it.schemaVersion, fingerprint: it.fingerprint ?? null, secret,
    mainDevice: typeof it.mainDevice === 'string' ? it.mainDevice : null,
    mainEpoch: typeof it.mainEpoch === 'number' ? it.mainEpoch : 0,
  }
}

async function rememberTheShop(
  db: SqlDriver,
  baseUrl: string,
  outcome: PairOutcome & { secret: string },
): Promise<void> {
  const peer = {
    label: outcome.label,
    secret: outcome.secret,
    address: baseUrl,
    fingerprint: typeof outcome.fingerprint === 'string' ? outcome.fingerprint : null,
  }
  await q(db).insert(schema.syncPeers)
    .values({ deviceId: outcome.deviceId, ...peer, createdAt: clock.iso() })
    .onConflictDoUpdate({ target: schema.syncPeers.deviceId, set: peer })
  // After the peer row, so `joinedMain` can tell whether this till has others.
  await joinedMain(db, outcome.deviceId, { device: outcome.mainDevice, epoch: outcome.mainEpoch })
}

/**
 * The key this till is asking to join with, kept between asking and being let
 * in. In memory only: a restart makes a new one, which the shop notices and
 * shows fresh digits for, and nothing about a pairing half done survives the
 * process that was doing it.
 */
let joining: PairingKey | null = null

/**
 * The shop's key as it was heard *before* this till showed its own. Every later
 * answer must carry the same one: a key that changed after ours was shown is a
 * key chosen to fit it. See `keyCommitment`.
 */
let heard: string | null = null

async function joiningKey(): Promise<PairingKey> {
  joining ??= await pairingKey()
  return joining
}

export type JoinProgress =
  | { state: 'PENDING'; requestId: string; digits: string }
  | { state: 'ALLOWED'; outcome: PairOutcome }
  | { state: 'REFUSED' }
  | { state: 'LAPSED' }

/**
 * Asking a shop to let this machine in, with nobody typing anything.
 *
 * Two calls rather than one held connection: what happens between them is a
 * person walking to the other counter and reading a screen, and no sensible
 * request timeout is that long. `ANSWER_TIMEOUT` in the app's listener is sixty
 * seconds, and a shopkeeper is not.
 *
 * Nothing here is authenticated, because nothing here grants anything. The
 * shop's answer does, and the thing that decides it is a person pressing Allow
 * on the till that already has the books.
 */
export async function askToJoin(
  baseUrl: string,
  label: string | null = null,
  fetchImpl: typeof fetch = fetch,
  self: SelfAddress = {},
): Promise<JoinProgress> {
  const me = deviceId()
  if (me === null) throw new Error('This machine does not know which machine it is')

  const key = await joiningKey()
  /* Two turns. First a commitment to our key, which the shop answers with its
     own; then our key, which the shop checks against the commitment and only
     then works out its digits from. The order is the security: neither side
     could choose its key after seeing the other's. */
  heard = null
  const asked = await knock(
    baseUrl, { deviceId: me, label, commitment: await keyCommitment(key.publicKey), ...succeeding() },
    key, fetchImpl, self, false,
  )
  /* A shop that answers the very first knock with ALLOWED is not one this
     asked — there has been nobody to press anything yet. Treated as the
     protocol being wrong rather than as a pairing. */
  if (asked.state === 'ALLOWED') throw new SyncHttpError(502, 'MALFORMED')
  if (asked.state !== 'PENDING') return asked

  const shown = await knock(baseUrl, { deviceId: me, requestId: asked.requestId, ...succeeding() }, key, fetchImpl, self)
  if (shown.state === 'ALLOWED') throw new SyncHttpError(502, 'MALFORMED')
  return shown
}

/** "May I yet?" — the same conversation, asked again until it has an answer. */
export async function pollJoin(
  db: SqlDriver,
  baseUrl: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
  self: SelfAddress = {},
): Promise<JoinProgress> {
  const me = deviceId()
  if (me === null) throw new Error('This machine does not know which machine it is')

  const answer = await knock(baseUrl, { deviceId: me, requestId, ...succeeding() }, await joiningKey(), fetchImpl, self)
  /* The key is kept after being let in, not dropped: if this answer was lost
     on the way back, the till asks again, and asking with a new key would be
     a different conversation that the shop turns away. */
  if (answer.state !== 'ALLOWED') return answer

  /* The secret is written down before anything is synced, so a pairing that
     succeeded on the far side and then failed on the way back leaves this till
     able to carry on rather than holding half of one. */
  await rememberTheShop(db, baseUrl, answer.full)
  return { state: 'ALLOWED', outcome: justTheShop(answer.full) }
}

type Knocked =
  | Exclude<JoinProgress, { state: 'ALLOWED' }>
  | { state: 'ALLOWED'; full: PairOutcome & { secret: string } }

async function knock(
  baseUrl: string,
  body: Record<string, unknown>,
  key: PairingKey,
  fetchImpl: typeof fetch,
  self: SelfAddress,
  /** False only for the first turn, which commits to the key without it. */
  showKey = true,
): Promise<Knocked> {
  assertSafeToSpeak(baseUrl)
  const response = await fetchImpl(`${baseUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(typeof self.listenPort === 'number'
        ? { [LISTEN_PORT_HEADER]: String(self.listenPort) }
        : {}),
    },
    body: JSON.stringify(showKey ? { ...body, publicKey: key.publicKey } : body),
  })

  const text = await response.text()
  if (!response.ok) throw new SyncHttpError(response.status, codeIn(text, response.status))

  const said = JSON.parse(text) as Partial<PairOutcome> & {
    state?: string; requestId?: string; digits?: string; publicKey?: string
  }
  switch (said.state) {
    case 'PENDING':
      if (typeof said.requestId !== 'string' || !isPairingPublicKey(said.publicKey)) {
        throw new SyncHttpError(502, 'MALFORMED')
      }
      if (!showKey) {
        heard = said.publicKey
        // No digits yet: the shop has not seen our key, and neither have we shown it.
        return { state: 'PENDING', requestId: said.requestId, digits: '' }
      }
      if (heard === null || said.publicKey !== heard) throw new SyncHttpError(502, 'KEY_CHANGED')
      /* The digits are worked out here from the two keys, not read off the
         answer. A machine in the middle chooses what it sends; it cannot make
         these match the shop's screen without the shop's key. */
      return {
        state: 'PENDING', requestId: said.requestId,
        digits: await comparisonDigits(key.publicKey, said.publicKey),
      }
    case 'REFUSED': joining = null; return { state: 'REFUSED' }
    case 'LAPSED': joining = null; return { state: 'LAPSED' }
    case 'ALLOWED':
      if (heard === null || said.publicKey !== heard) throw new SyncHttpError(502, 'KEY_CHANGED')
      return { state: 'ALLOWED', full: await agreed(said, key) }
    default: throw new SyncHttpError(502, 'MALFORMED')
  }
}

/**
 * Everyone this till can dial, for the sync loop and for a screen.
 *
 * `reach` is asked rather than inferred. This used to be "has an address", which
 * happened to exclude a phone — no port, so no address was ever recorded — and
 * happened to *include* a cloud peer that a shop behind NAT cannot dial either.
 * A peer that says it cannot answer is left out, and the loop stops spending a
 * timeout on it every round and stops reporting the shop as unreachable over a
 * machine that was never going to pick up. It still converges: a peer that
 * cannot be dialled is one that does the dialling.
 */
export async function pairedPeers(db: SqlDriver): Promise<PeerAddress[]> {
  const rows = await q(db)
    .select({
      deviceId: schema.syncPeers.deviceId,
      secret: schema.syncPeers.secret,
      address: schema.syncPeers.address,
      reach: schema.syncPeers.reach,
    })
    .from(schema.syncPeers)
    .where(and(
      isNotNull(schema.syncPeers.secret),
      isNotNull(schema.syncPeers.address),
      ne(schema.syncPeers.reach, 'none'),
    ))
    .orderBy(schema.syncPeers.createdAt)

  /* Both columns are nullable in the table -- a peer that is half set up has
     one or the other -- and the query has just asked for the rows where
     neither is. The non-null assertions say that, and the `where` above is
     what makes them true. */
  return rows.map((r) => ({
    deviceId: r.deviceId, secret: r.secret!, baseUrl: r.address!, reach: r.reach,
  }))
}

/** Where a peer was last reached, when a till moves or the router renumbers. */
export async function rememberAddress(
  db: SqlDriver, peerDeviceId: string, baseUrl: string,
): Promise<void> {
  await q(db).update(schema.syncPeers)
    .set({ address: baseUrl })
    .where(eq(schema.syncPeers.deviceId, peerDeviceId))
}

/**
 * Whose place this till is taking, when it has been restored from a backup.
 * See `setReplacedDevice`; absent on every ordinary pairing.
 */
function succeeding(): { replaces?: string } {
  const was = replacedDevice()
  return was === null ? {} : { replaces: was }
}
