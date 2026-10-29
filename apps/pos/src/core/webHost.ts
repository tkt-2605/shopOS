import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SqlDriver } from '@shopos/core'
import {
  handleWebRequest, newThrottles, whyNotServing, rememberGoogleKeys, expireUnanswered,
  forgetServingState, loadWebSettings, publicStatus,
  type Jwks, type WebRefusal,
} from '@shopos/core/web'
import { logEvent, describe } from './log'
import { deviceSetting } from './device'
import { isOff } from './switches'
import { keepShopUploaded, pushShop, stopUploading } from './cloudShop'

/**
 * Answering the storefront.
 *
 * The same arrangement as `syncHost.ts`: Rust holds a port (`web_server.rs`,
 * loopback only, reached by `cloudflared`), hands each request here, and
 * writes back what core decided (`handleWebRequest`). Photos never come here;
 * Rust serves them off the attachments folder itself.
 *
 * Only ever open on the main of a shop online orders were built for, with
 * them turned on, and not switched off from the portal (`online_orders`).
 * Checked when the app starts and after every sync round -- a round is where a
 * till learns it has become the main, or stopped being it.
 */

interface Forwarded {
  id: number
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/** The port `cloudflared` is pointed at. Set per machine, since it is the machine's tunnel. */
export const WEB_PORT_DEFAULT = 7802
const KEYS_EVERY_MS = 12 * 60 * 60 * 1000
const EXPIRE_EVERY_MS = 60 * 1000
/** How often Rust's copy of `/api/status` is renewed (`web_set_status`). */
const STATUS_EVERY_MS = 30 * 1000
/** Whether this till serves, and its web settings, reused between requests for this long. */
const SETTINGS_MS = 5 * 1000

let listening: UnlistenFn | null = null
let keys: Jwks | null = null
let timers: Array<ReturnType<typeof setInterval>> = []
const throttles = newThrottles()
/** Why the port could not be opened last time, e.g. "Port 7802 is held by OtherApp.exe". */
let portTrouble: string | null = null

export function storefrontPortTrouble(): string | null {
  return portTrouble
}

/** The tunnel as Rust keeps it (`tunnel.rs`): up, how often it has had to be restarted, and why. */
export interface TunnelState { up: boolean; restarts: number; problem: string | null; config: string }

let tunnelTrouble: string | null = null

/** Null while the till is not running the tunnel itself. */
export async function tunnelState(): Promise<TunnelState | null> {
  return (await invoke<TunnelState | null>('web_tunnel_status').catch(() => null)) ?? null
}

/** Why the tunnel could not be started, e.g. no config on this computer. */
export function tunnelProblem(): string | null {
  return tunnelTrouble
}

/**
 * The till runs the Cloudflare tunnel itself, so a PC that restarted comes back
 * online with the till. `web_tunnel` = `off` in device.json leaves it to
 * something else (a Windows service); `web_tunnel_exe` and `web_tunnel_config`
 * point at another cloudflared or config.
 */
async function startTunnel(): Promise<void> {
  if (deviceSetting('web_tunnel') === 'off') return
  try {
    const s = await invoke<TunnelState>('web_tunnel_start', {
      exe: deviceSetting('web_tunnel_exe') || null, config: deviceSetting('web_tunnel_config') || null,
    })
    tunnelTrouble = null
    logEvent('info', 'web', `tunnel ${s.up ? 'running' : 'starting'} with ${s.config}`)
  } catch (err) {
    tunnelTrouble = describe(err)
    logEvent('error', 'web', `could not start the tunnel: ${tunnelTrouble}`)
  }
}

export function webPort(): number {
  const n = Number(deviceSetting('web_port'))
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : WEB_PORT_DEFAULT
}

/** Why this till is not answering the storefront, or null when it should be. */
export async function storefrontRefusal(db: SqlDriver): Promise<WebRefusal | 'SWITCHED_OFF' | null> {
  if (isOff('online_orders')) return 'SWITCHED_OFF'
  return whyNotServing(db)
}

/** Opens or closes the storefront's door to match what this till now is. */
export async function keepTheStorefrontRight(db: SqlDriver): Promise<void> {
  const should = (await storefrontRefusal(db)) === null
  const open = await webServingOn()
  if (should && open === null) {
    await startWeb(db)
  } else if (should && listening === null) {
    // A webview reload under a port that outlived it.
    await attend(db)
  } else if (!should && open !== null) {
    /* Last word to Cloudflare first, so the storefront says closed rather than showing yesterday's shop. */
    await pushShop(db)
    await stopWeb()
    logEvent('info', 'web', 'stopped answering the storefront')
  }
}

async function startWeb(db: SqlDriver): Promise<void> {
  await attend(db)
  try {
    const port = await invoke<number>('web_serve_start', { port: webPort() })
    portTrouble = null
    logEvent('info', 'web', `answering the storefront on 127.0.0.1:${port}`)
  } catch (err) {
    portTrouble = describe(err)
    logEvent('error', 'web', `could not open the storefront port: ${portTrouble}`)
    await stopWeb()
    return
  }
  await startTunnel()
  keepShopUploaded(db)
  await refreshKeys(db)
  await refreshLiveStatus(db)
  timers = [
    setInterval(() => { void refreshKeys(db) }, KEYS_EVERY_MS),
    setInterval(() => { void expireUnanswered(db).catch(() => undefined) }, EXPIRE_EVERY_MS),
    setInterval(() => { void refreshLiveStatus(db) }, STATUS_EVERY_MS),
  ]
}

/**
 * Hands Rust what `/api/status` says now, so it answers the storefront's most
 * frequent question without waking this webview (`web_server.rs`). A till that
 * should not serve clears it, and the request comes here to be refused.
 */
async function refreshLiveStatus(db: SqlDriver): Promise<void> {
  try {
    const serving = (await storefrontRefusal(db)) === null
    const body = serving ? JSON.stringify(await publicStatus(db)) : null
    const origin = serving ? (await loadWebSettings(db)).origin : null
    await invoke('web_set_status', { body, origin })
  } catch (err) {
    await invoke('web_set_status', { body: null, origin: null }).catch(() => undefined)
    logEvent('warn', 'web', `could not renew the storefront status: ${describe(err)}`)
  }
}

/** The owner changed Settings, Online orders: phones see it on their next question, not up to half a minute later. */
export async function webSettingsChanged(db: SqlDriver): Promise<void> {
  forgetServingState(db)
  if (await webServingOn() !== null) await refreshLiveStatus(db)
}

export async function stopWeb(): Promise<void> {
  stopUploading()
  for (const t of timers) clearInterval(t)
  timers = []
  if (listening !== null) {
    listening()
    listening = null
  }
  await invoke('web_serve_stop').catch(() => undefined)
  await invoke('web_tunnel_stop').catch(() => undefined)
}

export async function webServingOn(): Promise<number | null> {
  return (await invoke<number | null>('web_serve_status').catch(() => null)) ?? null
}

async function refreshKeys(db: SqlDriver): Promise<void> {
  const text = await invoke<string | null>('web_google_keys').catch(() => null)
  keys = await rememberGoogleKeys(db, text ?? null)
  if (keys === null) logEvent('warn', 'web', 'no Google keys yet: customers cannot sign in until the line is up')
}

async function attend(db: SqlDriver): Promise<void> {
  if (listening !== null) return
  listening = await listen<Forwarded>('web-request', (event) => {
    void answer(db, event.payload)
  })
}

async function answer(db: SqlDriver, request: Forwarded): Promise<void> {
  try {
    const reply = await handleWebRequest(db, {
      method: request.method, path: request.path, headers: request.headers, body: request.body,
    }, { now: new Date(), googleKeys: keys, throttles, settingsMs: SETTINGS_MS })
    if (reply.status >= 500) logEvent('warn', 'web', `${request.method} ${request.path}: ${reply.status}`)
    await invoke('web_reply', { id: request.id, status: reply.status, headers: reply.headers, body: reply.body })
  } catch (err) {
    logEvent('error', 'web', `could not answer ${request.method} ${request.path}: ${describe(err)}`)
    await invoke('web_reply', {
      id: request.id, status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'SERVER_ERROR' }),
    }).catch(() => undefined)
  }
}

/** WhatsApp at a chat with a customer, a message ready to send. Rust builds the link (`web_open_whatsapp`). */
export async function openWhatsApp(phone: string, text: string): Promise<void> {
  await invoke('web_open_whatsapp', { phone, text })
}
