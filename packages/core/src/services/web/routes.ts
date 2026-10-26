import type { SqlDriver } from '../../db/driver.js'
import { getSetting } from '../settings.js'
import { loadWebSettings, whyNotServing } from './gate.js'
import { publishCatalog, type PublishedCatalog } from './catalog.js'
import { verifyGoogleIdToken, type Jwks } from './google.js'
import { bearer, issueSession, readSession } from './session.js'
import { loadAccount, saveContact, signIn, type WebAccount } from './accounts.js'
import { customerCancel, placeOrder, type WebOrderLineInput } from './orders.js'
import { orderForAccount, ordersForAccount, type WebOrderView } from './orderViews.js'
import { HourlyThrottle } from './throttle.js'

/*
 * The storefront's API, as one function from a request to a reply.
 *
 * Pure of any network: the Rust side (`web_server.rs`) takes the request off
 * the socket, the app hands it here, and the reply goes back the same way --
 * the shape sync already has (`handleSyncRequest`). That keeps every rule
 * about who may see what in core, where it is tested, and leaves the socket
 * code knowing nothing about orders.
 *
 * Photos (`/img/<hash>`) never come here: the Rust side serves them straight
 * off the attachments folder.
 */

export interface WebRequest {
  method: string
  /** The path and any query, as sent: `/api/orders/abc?x=1`. */
  path: string
  /** Lower-cased names. Only the few the Rust side passes on. */
  headers: Record<string, string>
  body: string
}

export interface WebReply {
  status: number
  headers: Record<string, string>
  body: string
}

export interface WebThrottles {
  /** Every API call from one address. */
  address: HourlyThrottle
  signIn: HourlyThrottle
  /** Orders placed by one account. */
  orders: HourlyThrottle
}

export function newThrottles(): WebThrottles {
  return { address: new HourlyThrottle(1200), signIn: new HourlyThrottle(30), orders: new HourlyThrottle(20) }
}

export interface WebDeps {
  now: Date
  /** Google's signing keys as last fetched, or null when they never have been. */
  googleKeys: Jwks | null
  throttles: WebThrottles
}

const NO_STORE = 'no-store'
const MANIFEST_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
const IMMUTABLE = 'public, max-age=31536000, immutable'
const CATALOG_TTL_MS = 60_000
const MAX_BODY = 64 * 1024

export async function handleWebRequest(db: SqlDriver, req: WebRequest, deps: WebDeps): Promise<WebReply> {
  const path = req.path.split('?')[0] ?? '/'

  const refusal = await whyNotServing(db)
  if (refusal !== null) return json(503, { error: refusal }, { 'cache-control': NO_STORE })

  if (path.startsWith('/catalog/')) return catalogRoute(db, req.method, path, deps.now)
  if (!path.startsWith('/api/')) return json(404, { error: 'NOT_FOUND' }, { 'cache-control': NO_STORE })

  const settings = await loadWebSettings(db)
  const cors = corsFor(req.headers['origin'], settings.origin)
  const reply = (status: number, body: unknown) => json(status, body, { 'cache-control': NO_STORE, ...cors })

  if (req.method === 'OPTIONS') return { status: 204, headers: { ...cors, 'access-control-max-age': '600' }, body: '' }
  if (req.body.length > MAX_BODY) return reply(413, { error: 'TOO_LARGE' })
  const wait = deps.throttles.address.take(req.headers['cf-connecting-ip'], deps.now)
  if (wait !== null) return reply(429, { error: 'SLOW_DOWN', retryAfter: wait })

  if (path === '/api/status' && req.method === 'GET') {
    return reply(200, {
      state: settings.open ? 'open' : 'closed',
      shop: (await getSetting(db, 'shop_name')) ?? '',
      googleClientId: settings.googleClientId,
    })
  }

  if (path === '/api/session' && req.method === 'POST') {
    const waitSignIn = deps.throttles.signIn.take(req.headers['cf-connecting-ip'], deps.now)
    if (waitSignIn !== null) return reply(429, { error: 'SLOW_DOWN', retryAfter: waitSignIn })
    const body = parse<{ idToken?: unknown }>(req.body)
    if (!body || typeof body.idToken !== 'string') return reply(400, { error: 'BAD_REQUEST' })
    if (!settings.googleClientId || !deps.googleKeys) return reply(503, { error: 'SIGN_IN_NOT_READY' })
    const verdict = await verifyGoogleIdToken(body.idToken, deps.googleKeys, settings.googleClientId, deps.now)
    if (!verdict.ok) return reply(401, { error: verdict.code })
    const account = await signIn(db, verdict.identity, deps.now)
    return reply(200, { session: await issueSession(db, account.id, deps.now), account: accountOut(account) })
  }

  /* Everything below is a signed-in customer's own business. */
  const session = await readSession(db, bearer(req.headers['authorization']), deps.now)
  const account = session ? await loadAccount(db, session.accountId) : null
  if (!account) return reply(401, { error: 'SIGN_IN' })

  if (path === '/api/me') {
    if (req.method === 'GET') return reply(200, { account: accountOut(account) })
    if (req.method === 'POST') {
      const body = parse<{ name?: unknown; phone?: unknown }>(req.body)
      if (!body || typeof body.name !== 'string' || typeof body.phone !== 'string') return reply(400, { error: 'BAD_REQUEST' })
      const saved = await saveContact(db, account.id, { name: body.name, phone: body.phone }, deps.now)
      return saved.ok ? reply(200, { account: accountOut(saved.account) }) : reply(400, { error: saved.code })
    }
  }

  if (path === '/api/orders') {
    if (req.method === 'GET') return reply(200, { orders: (await ordersForAccount(db, account.id)).map(orderOut) })
    if (req.method === 'POST') {
      if (!settings.open) return reply(409, { error: 'SHOP_CLOSED' })
      const waitOrder = deps.throttles.orders.take(account.id, deps.now)
      if (waitOrder !== null) return reply(429, { error: 'SLOW_DOWN', retryAfter: waitOrder })
      const body = parse<{ clientOrderId?: unknown; lines?: unknown; catalogHash?: unknown; note?: unknown }>(req.body)
      if (!body || typeof body.clientOrderId !== 'string' || !Array.isArray(body.lines)) return reply(400, { error: 'BAD_REQUEST' })
      const placed = await placeOrder(db, {
        accountId: account.id,
        clientOrderId: body.clientOrderId,
        lines: body.lines as WebOrderLineInput[],
        catalogHash: typeof body.catalogHash === 'string' ? body.catalogHash : null,
        note: typeof body.note === 'string' ? body.note : null,
      }, deps.now)
      return placed.ok ? reply(201, { order: orderOut(placed.order) }) : reply(400, placed)
    }
  }

  const one = /^\/api\/orders\/([A-Za-z0-9-]{1,64})(\/cancel)?$/.exec(path)
  if (one) {
    const [, id, cancel] = one
    if (!cancel && req.method === 'GET') {
      const order = await orderForAccount(db, account.id, id!)
      return order ? reply(200, { order: orderOut(order) }) : reply(404, { error: 'NOT_FOUND' })
    }
    if (cancel && req.method === 'POST') {
      const done = await customerCancel(db, { accountId: account.id, orderId: id!, now: deps.now })
      return done.ok ? reply(200, { order: orderOut(done.order) }) : reply(done.code === 'NOT_FOUND' ? 404 : 409, { error: done.code })
    }
  }

  return reply(404, { error: 'NOT_FOUND' })
}

// ---------------------------------------------------------------- catalogue

interface Held extends PublishedCatalog {
  builtAt: number
  /** When this content was first published, which is what "prices as of" means. */
  since: string
}

const held = new WeakMap<SqlDriver, Held>()

/**
 * The catalogue as last published, rebuilt at most once a minute. Cloudflare
 * holds the manifest for a minute too, so however many people browse, the
 * main builds it about once a minute and only while somebody is looking.
 */
export async function currentCatalog(db: SqlDriver, now: Date): Promise<Held> {
  const last = held.get(db)
  if (last && now.getTime() - last.builtAt < CATALOG_TTL_MS) return last
  const fresh = await publishCatalog(db, now)
  const next: Held = {
    ...fresh,
    builtAt: now.getTime(),
    since: last && last.hash === fresh.hash ? last.since : now.toISOString(),
  }
  held.set(db, next)
  return next
}

async function catalogRoute(db: SqlDriver, method: string, path: string, now: Date): Promise<WebReply> {
  const open = { 'access-control-allow-origin': '*' }
  if (method !== 'GET') return json(405, { error: 'GET_ONLY' }, { 'cache-control': NO_STORE, ...open })
  const catalog = await currentCatalog(db, now)
  if (path === '/catalog/manifest.json') {
    return json(200, { hash: catalog.hash, since: catalog.since, items: catalog.itemCount }, { 'cache-control': MANIFEST_CACHE, ...open })
  }
  const named = /^\/catalog\/([0-9a-f]{64})\.json$/.exec(path)
  if (named && named[1] === catalog.hash) {
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': IMMUTABLE, ...open }, body: catalog.body }
  }
  /* An older catalogue is gone from the till. Cloudflare may still hold it,
     which is fine: its name says what it is. */
  return json(404, { error: 'NOT_FOUND' }, { 'cache-control': NO_STORE, ...open })
}

// ---------------------------------------------------------------- shapes

function accountOut(a: WebAccount) {
  return { name: a.name, phone: a.phone, email: a.email, phoneVerified: a.phoneVerified }
}

function orderOut(o: WebOrderView) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    status: o.status,
    lines: o.lines,
    seenTotal: o.seenTotal,
    tillTotal: o.tillTotal,
    note: o.note,
    reason: o.reason,
    cancelRequested: o.cancelRequested,
    placedAt: o.placedAt,
    answeredAt: o.answeredAt,
    readyAt: o.readyAt,
  }
}

function corsFor(origin: string | undefined, allowed: string | null): Record<string, string> {
  if (!origin || !allowed || origin !== allowed) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  }
}

function json(status: number, body: unknown, headers: Record<string, string>): WebReply {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function parse<T>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as T) : null
  } catch {
    return null
  }
}
