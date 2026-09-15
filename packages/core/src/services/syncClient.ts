import type { SqlDriver } from '../db/driver.js'
import { deviceId } from '../device.js'
import type { ChangeBatch } from '../domain/replicaShape.js'
import type { PeerHello, SyncTransport } from './sync.js'
import { encodeAuth, sign } from './syncAuth.js'
import { LISTEN_PORT_HEADER } from './syncServer.js'
import { clock } from '../clock.js'

/**
 * The side of a sync that asks.
 *
 * This half runs in the webview, because making a request out is something a
 * webview can do and listening on a port is not. Only the answering side needs
 * anything from Rust, which is why `syncServer.ts` is a plain function and this
 * is plain `fetch`.
 */

export interface PeerAddress {
  deviceId: string
  /** `http://192.168.1.14:7801`, as last reached. A hint, never an authority. */
  baseUrl: string
  secret: string
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
    body: JSON.stringify({ code: code.trim().toUpperCase(), deviceId: me, label }),
  })

  const text = await response.text()
  if (!response.ok) {
    let reason = `HTTP_${response.status}`
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
        reason = String((parsed as { code: unknown }).code)
      }
    } catch { /* not ours */ }
    throw new SyncHttpError(response.status, reason)
  }

  const agreed = JSON.parse(text) as PairOutcome & { secret: string }
  if (typeof agreed.secret !== 'string' || typeof agreed.deviceId !== 'string') {
    throw new SyncHttpError(502, 'MALFORMED')
  }

  await db.execute(
    `INSERT INTO sync_peers (device_id, label, secret, address, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET
       label = excluded.label, secret = excluded.secret, address = excluded.address`,
    [agreed.deviceId, agreed.label, agreed.secret, baseUrl, clock.iso()],
  )

  return {
    deviceId: agreed.deviceId,
    label: agreed.label,
    shopId: agreed.shopId,
    schemaVersion: agreed.schemaVersion,
  }
}

/** Everyone this till can reach, for the sync loop and for a screen. */
export async function pairedPeers(db: SqlDriver): Promise<PeerAddress[]> {
  const rows = await db.query<{ device_id: string; secret: string | null; address: string | null }>(
    `SELECT device_id, secret, address FROM sync_peers
      WHERE secret IS NOT NULL AND address IS NOT NULL
      ORDER BY created_at`,
  )
  return rows.map((r) => ({
    deviceId: r.device_id, secret: r.secret!, baseUrl: r.address!,
  }))
}

/** Where a peer was last reached, when a till moves or the router renumbers. */
export async function rememberAddress(
  db: SqlDriver, peerDeviceId: string, baseUrl: string,
): Promise<void> {
  await db.execute(
    `UPDATE sync_peers SET address = ? WHERE device_id = ?`, [baseUrl, peerDeviceId],
  )
}
