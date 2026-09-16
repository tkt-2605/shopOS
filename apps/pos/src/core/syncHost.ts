import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { handleSyncRequest, type SqlDriver } from '@shopos/core'
import { logEvent, describe } from './log'

/**
 * Answering the other till.
 *
 * The port is held open by Rust, which knows nothing about replication: it
 * accepts a request, hands the bytes here, and writes back whatever this
 * returns. Every rule about what a request means lives in `packages/core`, in
 * one copy, tested over real sockets — so there is no second implementation in
 * Rust to drift away from the first.
 *
 * Nothing listens until a shop turns it on. A single till never opens a port,
 * which is the right default for most shops: a port nothing uses is a way in and
 * no use to anybody.
 */

export interface ServeInfo {
  port: number
  /** `192.168.1.11:7801`, for a person to read out. Null off a network. */
  address: string | null
}

interface Forwarded {
  id: number
  path: string
  body: string
  auth: string | null
  /** The caller's IP, from the socket rather than any header it sent. */
  remoteAddress: string | null
  /** The port the caller says it listens on, from `x-shopos-port`. */
  listenPort: number | null
}

let listening: UnlistenFn | null = null

export interface FoundTill {
  /** `192.168.1.11:7801`, ready to be handed straight to `pairWith`. */
  address: string
  device: string
  label: string
  shop: string | null
  shopId: string | null
  port: number
}

/**
 * Asks the network whether any other till is answering.
 *
 * A shopkeeper should not have to know what 192.168.1.11 is, and the address
 * changes whenever the router feels like it — so typing it turns a one-off setup
 * into a thing that breaks on a Tuesday for no visible reason.
 *
 * Finding a till grants nothing. It says where to knock; pairing still needs a
 * code read off that till's screen, and every request after that is signed.
 */
export async function lookAround(waitMs = 1200): Promise<FoundTill[]> {
  return invoke<FoundTill[]>('sync_look_around', { waitMs })
}

/**
 * Starts answering, and keeps answering until told to stop.
 *
 * The event subscription goes up *before* the port does, so a request that
 * arrives in the first millisecond has somebody to answer it rather than timing
 * out against a webview that is not listening yet.
 *
 * `shop` is what this till says about itself when another one shouts on the
 * network. It is only a name and an opaque id — enough for a person to tell two
 * shops apart on one wire, and no use to anybody without a pairing code.
 */
export async function startServing(
  db: SqlDriver,
  port = 7801,
  shop: { name: string | null; id: string | null } = { name: null, id: null },
): Promise<ServeInfo> {
  await attend(db)

  try {
    return await invoke<ServeInfo>('sync_serve_start', {
      port, shop: shop.name, shopId: shop.id,
    })
  } catch (err) {
    // The port is taken, or the firewall said no. Stop pretending to listen.
    await stopServing()
    throw err
  }
}

/**
 * Picks the port back up after the webview has reloaded underneath it.
 *
 * The listener lives in the Rust process and the subscription lives in the
 * webview, and those two do not have the same lifetime. A reload — a refresh
 * while developing, a webview that crashed and came back — leaves the port open
 * with nobody behind it, and every request from the other till then waits the
 * full minute and gets a 503. The screen would say "Listening on 192.168.1.11",
 * the port would genuinely be open, and nothing would work: a switch that is on
 * and does nothing, which is this product's own worst failure.
 *
 * Called at startup, so the window between a reload and the first request is as
 * small as it can be.
 */
export async function resumeServing(db: SqlDriver): Promise<ServeInfo | null> {
  const info = await servingOn()
  if (info === null) return null
  await attend(db)
  return info
}

async function attend(db: SqlDriver): Promise<void> {
  if (listening !== null) return
  listening = await listen<Forwarded>('sync-request', (event) => {
    void answer(db, event.payload)
  })
}

export async function stopServing(): Promise<void> {
  if (listening !== null) {
    listening()
    listening = null
  }
  await invoke('sync_serve_stop')
}

export async function servingOn(): Promise<ServeInfo | null> {
  return (await invoke<ServeInfo | null>('sync_serve_status')) ?? null
}

/** The refusal code out of a reply body, without trusting it to be JSON. */
function codeIn(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object' && 'code' in parsed) {
      return String((parsed as { code: unknown }).code)
    }
  } catch {
    // Not JSON. The status on its own is still worth the line.
  }
  return 'no code'
}

async function answer(db: SqlDriver, request: Forwarded): Promise<void> {
  try {
    const reply = await handleSyncRequest(db, {
      path: request.path,
      body: request.body,
      auth: request.auth,
      /* Where the caller is, as Rust's socket saw it, and the port it says it
         answers on. Without these the peer row for a till that joined us has a
         secret and no address — and `pairedPeers` filters those out, so this
         till could receive a sync for ever and never start one. */
      remoteAddress: request.remoteAddress ?? null,
      listenPort: request.listenPort ?? null,
    })
    /* Refusals, from the side that did the refusing.

       This is the half that was invisible. A till that turns its partner away —
       wrong schema, wrong shop, same counter, a secret that does not match —
       said so over HTTP and wrote nothing down, so the machine that knew the
       reason kept it and the machine that got the sentence could not always
       show it. Two tills that will not talk is a support call, and it used to
       arrive with evidence on neither end. */
    if (reply.status >= 400) {
      logEvent('warn', 'sync', `refused ${request.path}: ${reply.status} ${codeIn(reply.body)}`)
    }
    await invoke('sync_reply', { id: request.id, status: reply.status, body: reply.body })
  } catch (err) {
    /* Every expected refusal is already a status from `handleSyncRequest`, so
       reaching here means something genuinely broke — a database that will not
       open, a disk that is full. The other till is told plainly rather than left
       holding a connection until it times out. */
    logEvent('error', 'sync', `could not answer ${request.path}: ${describe(err)}`)
    console.error('Could not answer the other till:', err)
    await invoke('sync_reply', {
      id: request.id,
      status: 500,
      body: JSON.stringify({ code: 'SERVER_ERROR' }),
    }).catch(() => undefined)
  }
}
