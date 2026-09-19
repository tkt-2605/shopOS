import { eq, ne, and, isNotNull } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { deviceId } from '../device.js'
import { myFingerprint } from './syncAuth.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import type { PeerHello, SyncTransport } from './sync.js'
import { encodeAuth, sign } from './syncAuth.js'
import { LISTEN_PORT_HEADER } from './syncServer.js'
import { clock } from '../clock.js'

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

    const text = await response.text()
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
    hello: () => ask<PeerHello>('/hello', {}),
    fetch: (since, limit) => ask<ChangeBatch>('/fetch', { since, limit }),
    offer: (batch) => ask<{ upTo: number }>('/offer', batch),
  }
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
      code: code.trim().toUpperCase(), deviceId: me, label,
      // Symmetric, so that when there is one to send neither side has to be
      // the one that was upgraded first.
      fingerprint: myFingerprint(),
    }),
  })

  const text = await response.text()
  if (!response.ok) throw new SyncHttpError(response.status, codeIn(text, response.status))

  const outcome = agreed(JSON.parse(text) as Record<string, unknown>)
  await rememberTheShop(db, baseUrl, outcome)
  return justTheShop(outcome)
}

/* The secret is written to `sync_peers` and goes no further. A caller that had
   it in hand would eventually put it on a screen or in a log. */
function justTheShop(o: PairOutcome & { secret: string }): PairOutcome {
  return {
    deviceId: o.deviceId, label: o.label, shopId: o.shopId,
    schemaVersion: o.schemaVersion, fingerprint: o.fingerprint ?? null,
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

/** What a shop says about itself when it lets a till in, checked before use. */
function agreed(said: Record<string, unknown> | (Partial<PairOutcome> & { secret?: string })): PairOutcome & { secret: string } {
  const it = said as PairOutcome & { secret: string }
  if (typeof it.secret !== 'string' || typeof it.deviceId !== 'string') {
    throw new SyncHttpError(502, 'MALFORMED')
  }
  return it
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

  const answer = await knock(baseUrl, { deviceId: me, label }, fetchImpl, self)
  /* A shop that answers the very first knock with ALLOWED is not one this
     asked — there has been nobody to press anything yet. Treated as the
     protocol being wrong rather than as a pairing. */
  if (answer.state === 'ALLOWED') throw new SyncHttpError(502, 'MALFORMED')
  return answer
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

  const answer = await knock(baseUrl, { deviceId: me, requestId }, fetchImpl, self)
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
  fetchImpl: typeof fetch,
  self: SelfAddress,
): Promise<Knocked> {
  const response = await fetchImpl(`${baseUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(typeof self.listenPort === 'number'
        ? { [LISTEN_PORT_HEADER]: String(self.listenPort) }
        : {}),
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) throw new SyncHttpError(response.status, codeIn(text, response.status))

  const said = JSON.parse(text) as Partial<PairOutcome> & {
    state?: string; requestId?: string; digits?: string; secret?: string
  }
  switch (said.state) {
    case 'PENDING':
      if (typeof said.requestId !== 'string' || typeof said.digits !== 'string') {
        throw new SyncHttpError(502, 'MALFORMED')
      }
      return { state: 'PENDING', requestId: said.requestId, digits: said.digits }
    case 'REFUSED': return { state: 'REFUSED' }
    case 'LAPSED': return { state: 'LAPSED' }
    case 'ALLOWED': return { state: 'ALLOWED', full: agreed(said) }
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
