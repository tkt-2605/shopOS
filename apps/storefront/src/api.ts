/*
 * Talking to the shop.
 *
 * Two places. What anyone may see -- the item list, photos, the shop's status
 * and settings -- the main till uploads to Cloudflare (`DATA`), so it is there
 * with the till off. Orders, sign-in and order status go to the till itself
 * (`API`), through the tunnel, and wait for it. With the till off the
 * storefront says the shop is closed and goes on letting people browse.
 */

declare const __SHOP_API__: string
declare const __SHOP_DATA__: string
export const API = __SHOP_API__
export const DATA = __SHOP_DATA__

/** Buy at least `minQty` and pay `price` each. */
export interface CatalogTier { minQty: number; price: number }
export interface CatalogUnit { unit: string; price: number; mrp: number | null; tiers?: CatalogTier[] }
export interface CatalogItem {
  id: string; name: string; brand: string | null; categoryId: string | null
  units: CatalogUnit[]; available: boolean; thumb: string | null; photo: string | null
}
export interface CatalogCategory { id: string; name: string; parentId: string | null }
export interface Catalog { shop: string; categories: CatalogCategory[]; items: CatalogItem[] }
export interface Manifest { hash: string; since: string; items: number }

export interface Account { name: string | null; phone: string | null; email: string | null; phoneVerified: boolean }
export type OrderStatus = 'pending' | 'accepted' | 'packing' | 'ready' | 'collected' | 'rejected' | 'cancelled'
export interface OrderLine { productId: string; name: string; unit: string; qty: number; seenPrice: number }
export interface Order {
  id: string; orderNo: number; status: OrderStatus; lines: OrderLine[]
  seenTotal: number; tillTotal: number | null; note: string | null; reason: string | null
  cancelRequested: boolean; placedAt: string; answeredAt: string | null; packingAt?: string | null; readyAt: string | null
  /** A changed list the shop sent back, waiting for this customer's answer. */
  proposal?: { lines: OrderLine[]; note: string | null; at: string; total: number } | null
  /** When this customer took the shop's changes. */
  agreedAt?: string | null
}

/** What the bar at the top says. */
export type ShopState = 'checking' | 'open' | 'closed' | 'asleep' | 'unreachable' | 'offline'

export interface About { address: string | null; phone: string | null; email?: string | null; hours: string | null }
export interface Status {
  state: 'open' | 'closed'; shop: string; googleClientId: string | null; about?: About
  /** The shop's WhatsApp number, digits with the country, while it offers WhatsApp at all. */
  whatsapp?: string | null
  offers?: { whatsappChat: boolean; whatsappCart: boolean }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

const TIMEOUT_MS = 8000

async function call<T>(path: string, init: RequestInit & { session?: string | null; timeout?: number } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body) headers['content-type'] = 'application/json'
  if (init.session) headers['authorization'] = `Bearer ${init.session}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeout ?? TIMEOUT_MS)
  try {
    const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { ...init, headers, signal: controller.signal })
    const text = await res.text()
    const body = text ? JSON.parse(text) as Record<string, unknown> : {}
    if (!res.ok) throw new ApiError(res.status, typeof body['error'] === 'string' ? body['error'] : `HTTP_${res.status}`)
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the shop can take an order right now, and why not when it cannot. */
export async function checkShop(): Promise<{ state: ShopState; status: Status | null }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { state: 'offline', status: null }
  try {
    const status = await call<Status>('/api/status', { timeout: 5000 })
    return { state: status.state === 'open' ? 'open' : 'closed', status }
  } catch {
    /* The till is off. What it last uploaded still says who the shop is and
       when it opens: closed, not "cannot reach". */
    try {
      return { state: 'asleep', status: await call<Status>(`${DATA}/status.json`, { timeout: 5000, cache: 'no-cache' }) }
    } catch {
      // Not uploaded yet, or this phone is offline: tell those apart below.
    }
    /* No answer at all. Either this phone has no internet after all, or the
       shop's till is off; a page the phone can still reach tells them apart. */
    const online = await fetch('/manifest.webmanifest', { cache: 'no-store' }).then(() => true, () => false)
    return { state: online ? 'unreachable' : 'offline', status: null }
  }
}

/* `no-cache`: always asked again (of Cloudflare, which holds it a minute), never
   the browser's own copy served stale while it checks in the background. */
/** `fresh` asks past Cloudflare's short-lived copy: only when a person asked, or the phone has nothing. */
export const fetchManifest = (fresh = false) => {
  const q = fresh ? `?at=${Date.now()}` : ''
  return call<Manifest>(`${DATA}/manifest.json${q}`, { cache: 'no-cache' })
    .catch(() => call<Manifest>(`/catalog/manifest.json${q}`, { cache: 'no-cache' }))
}
export const fetchCatalog = (hash: string) =>
  call<Catalog>(`${DATA}/catalog/${hash}.json`, { timeout: 30_000 })
    .catch(() => call<Catalog>(`/catalog/${hash}.json`, { timeout: 30_000 }))
export const imageUrl = (hash: string) => `${DATA}/img/${hash}`

export const signIn = (idToken: string) =>
  call<{ session: string; account: Account }>('/api/session', { method: 'POST', body: JSON.stringify({ idToken }) })
export const me = (session: string) => call<{ account: Account }>('/api/me', { session })
export const saveContact = (session: string, name: string, phone: string) =>
  call<{ account: Account }>('/api/me', { method: 'POST', session, body: JSON.stringify({ name, phone }) })

export const myOrders = (session: string) => call<{ orders: Order[] }>('/api/orders', { session })
export const myOrder = (session: string, id: string) => call<{ order: Order }>(`/api/orders/${id}`, { session })
/** Takes (or refuses) the changed list the shop sent back. Refusing cancels the order. */
export const answerChanges = (session: string, id: string, take: boolean) =>
  call<{ order: Order }>(`/api/orders/${id}/changes`, { method: 'POST', session, body: JSON.stringify({ take }) })
export const cancelOrder = (session: string, id: string) =>
  call<{ order: Order }>(`/api/orders/${id}/cancel`, { method: 'POST', session })

export const placeOrder = (session: string, input: {
  clientOrderId: string; catalogHash: string | null; note: string
  lines: { productId: string; unit: string; qty: number; price: number }[]
}) => call<{ order: Order }>('/api/orders', { method: 'POST', session, body: JSON.stringify(input) })
