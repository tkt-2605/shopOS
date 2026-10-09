import type { SigningKey } from '../../domain/licence.js'
import type { CopyMaker } from '../sync/copy.js'

/*
 * The shape of what arrives and what goes back, and the three ways an answer
 * is written.
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

export interface SyncServerOptions {
  /** Defaults to the build's own `LICENCE_KEYS`. Tests pass their own. */
  keys?: readonly SigningKey[]
  /**
   * How this host takes a copy of the shop for a joining till: a `VACUUM INTO`
   * in Rust in the app, a file on disk in a test. Absent, `/copy` is refused
   * and a joining till takes the shop through the feed as before.
   */
  copies?: CopyMaker
}

export function ok(payload: unknown): SyncResponse {
  return { status: 200, body: JSON.stringify(payload) }
}

export function refuse(status: number, code: string): SyncResponse {
  return { status, body: JSON.stringify({ code }) }
}

export function parse<T>(body: string): T | null {
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}
