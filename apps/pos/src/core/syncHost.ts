import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  handleSyncRequest, listens, expectingAJoin, loadShopProfile, getSetting, type SqlDriver,
} from '@shopos/core'
import { logEvent, describe } from './log'
import { deviceSetting, setDeviceSetting } from './device'

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
 *
 * The port defaults to the one this machine had last time. See below.
 */

/**
 * The port this till had last time, so that it asks for the same one again.
 *
 * 7801 is the port a shop's firewall rule names and the one every till wants.
 * A till that could not have it takes any free one — which is right, and made
 * the address it advertises change every restart. Its peers went on dialling
 * yesterday's port and got a stranger or a closed door, and since a peer's
 * address is only re-learned from a request *that peer makes*, two tills could
 * sit holding stale addresses for each other indefinitely.
 *
 * Remembering it costs one line in `device.json` and makes the common case
 * stable: a till that ended up on 52134 asks for 52134 next time, leaving 7801
 * to whoever actually has it.
 */
const PORT_KEY = 'sync_port'
const DEFAULT_PORT = 7801

export async function startServing(
  db: SqlDriver,
  port = Number(deviceSetting(PORT_KEY)) || DEFAULT_PORT,
  shop: { name: string | null; id: string | null } = { name: null, id: null },
): Promise<ServeInfo> {
  await attend(db)

  try {
    const info = await invoke<ServeInfo>('sync_serve_start', {
      port, shop: shop.name, shopId: shop.id,
    })
    /* What it actually got, which is not always what it asked for. Only when it
       differs, so the file is not rewritten on every start. */
    if (info.port !== port) void setDeviceSetting(PORT_KEY, String(info.port))
    return info
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

/**
 * Opens the door because the shop has somebody to answer, not because anybody
 * pressed a switch.
 *
 * There used to be a "Start answering" toggle, and the reasoning behind it was
 * sound: a one-till shop should never open a port, because a port nothing uses
 * is a way in and no use to anybody. But that is a consequence of how many
 * tills the shop has, and a shopkeeper should not have to know it — the toggle
 * turned a fact into a question, and then the answer to it could be wrong. A
 * till that had been joined but never switched on was a till the shop could not
 * reach, saying nothing about why.
 *
 * So: a shop with a paired till answers whenever it is running, a shop with
 * none stays closed, and `SyncCard` opens the port for as long as it takes to
 * add one.
 */
/*
 * **Never gated on the licence, and that is load-bearing.**
 *
 * `multiTill` gates adding a till. It must not gate answering one, and this is
 * the function where the difference would be easiest to get wrong: a licence
 * check here reads like "no plan, no second till", and what it would actually
 * do is stop a shop that already has three counters from answering any of
 * them. Billing would carry on — it always does — so the shop would take money
 * on every till and merge none of it, and find out weeks later when the stock
 * and the credit book disagreed on every machine.
 *
 * A peer with a secret was let in when the shop was entitled to let it in.
 * Nothing takes that back.
 */
export async function serveIfPaired(db: SqlDriver): Promise<ServeInfo | null> {
  /* Already open, which is a webview reload under a listener that outlived it.
     Re-attend and leave the port where it is. */
  const already = await resumeServing(db)
  if (already !== null) return already

  /* The main answers; a till dials and does not. `listens` is the one place
     that knows, including the exception -- a main that has just handed over
     goes on answering the tills that still dial it. */
  if (!await listens(db)) return null

  const shop = await loadShopProfile(db)
  // No port: whatever this machine had last time, which is what its peers have
  // written down as its address.
  return await startServing(db, undefined, {
    name: shop.name, id: await getSetting(db, 'shop_id'),
  })
}

/**
 * Opens or closes the door to match what this till now is.
 *
 * Asked after every round, because a round is where a till learns that it has
 * become the main -- a handover, heard in a hello -- or that it no longer is.
 * A main that did not start answering would leave every till dialling a door
 * that never opens; an old main that kept answering would keep a port open
 * that nothing should use.
 *
 * Never closes while a pairing is on offer: that is a person standing at this
 * till adding one, and the port is open for them.
 */
export async function keepTheDoorRight(db: SqlDriver): Promise<void> {
  const open = (await servingOn()) !== null
  const should = await listens(db)
  if (should && !open) {
    await serveIfPaired(db)
    logEvent('info', 'sync', 'answering other tills: this till is the main')
  } else if (!should && open && !expectingAJoin()) {
    await stopServing()
    logEvent('info', 'sync', 'stopped answering: this till syncs through the main')
  }
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
