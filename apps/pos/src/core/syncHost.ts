import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { handleSyncRequest, type SqlDriver } from '@shopos/core'

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
}

let listening: UnlistenFn | null = null

/**
 * Starts answering, and keeps answering until told to stop.
 *
 * The event subscription goes up *before* the port does, so a request that
 * arrives in the first millisecond has somebody to answer it rather than timing
 * out against a webview that is not listening yet.
 */
export async function startServing(db: SqlDriver, port = 7801): Promise<ServeInfo> {
  if (listening === null) {
    listening = await listen<Forwarded>('sync-request', (event) => {
      void answer(db, event.payload)
    })
  }

  try {
    return await invoke<ServeInfo>('sync_serve_start', { port })
  } catch (err) {
    // The port is taken, or the firewall said no. Stop pretending to listen.
    await stopServing()
    throw err
  }
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

async function answer(db: SqlDriver, request: Forwarded): Promise<void> {
  try {
    const reply = await handleSyncRequest(db, {
      path: request.path,
      body: request.body,
      auth: request.auth,
    })
    await invoke('sync_reply', { id: request.id, status: reply.status, body: reply.body })
  } catch (err) {
    /* Every expected refusal is already a status from `handleSyncRequest`, so
       reaching here means something genuinely broke — a database that will not
       open, a disk that is full. The other till is told plainly rather than left
       holding a connection until it times out. */
    console.error('Could not answer the other till:', err)
    await invoke('sync_reply', {
      id: request.id,
      status: 500,
      body: JSON.stringify({ code: 'SERVER_ERROR' }),
    }).catch(() => undefined)
  }
}
