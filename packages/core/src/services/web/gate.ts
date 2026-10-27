import type { SqlDriver } from '../../db/driver.js'
import { getSetting, setSetting } from '../settings.js'
import { requirePermission } from '../../integrity/permissions.js'
import { tillRole } from '../sync/layout.js'
import { shortShopId } from '../../domain/updateTarget.js'

/*
 * Whether this till answers the web, and the settings that shape what it says.
 *
 * Three locks, all of which must be open. The shop has to be one of the shops
 * online orders were built for -- a list in the code, not a setting, so no
 * shop can turn this on by accident or by sync. The owner has to have turned
 * it on. And this till has to be the main: an order accepted by two tills is
 * two sales orders for one customer, and the main is the one till every other
 * till already defers to (`sync/layout.ts`).
 *
 * Closing the shop for the evening (`web_open`) is not one of the locks. A
 * closed shop still answers, so a customer can see their orders and the
 * storefront can say "closed" instead of "unreachable".
 */

/** The shops online orders are for, by the short id on their reports and Licence screen. */
export const ONLINE_ORDER_SHOPS: readonly string[] = ['01a122eb']

export const WEB_SETTINGS = {
  /** `on` when the owner has turned online orders on. */
  enabled: 'web_orders',
  /** `on` while the shop is taking new orders. */
  open: 'web_open',
  /** The categories whose items are listed, as a JSON array of ids. Their children are listed too. */
  categories: 'web_categories',
  /** Where the storefront is served from, e.g. `https://shop.example.in`. The only origin the API answers. */
  origin: 'web_origin',
  /** The storefront's Google OAuth client id, which every sign-in token must be addressed to. */
  googleClientId: 'google_client_id',
  /** Minutes a pending order waits for an answer before it is turned away. */
  answerMinutes: 'web_answer_minutes',
  /** Business days an accepted order may wait to be collected before it is listed as overdue. */
  collectDays: 'web_collect_days',
  /** Opening hours as the shop writes them, shown on the storefront: "9 am to 9 pm, closed Sunday". */
  hours: 'web_hours',
} as const

export interface WebSettings {
  enabled: boolean
  open: boolean
  categoryIds: string[]
  origin: string | null
  googleClientId: string | null
  answerMinutes: number
  collectDays: number
  hours: string | null
}

const ANSWER_MINUTES_DEFAULT = 30
const COLLECT_DAYS_DEFAULT = 3

export async function loadWebSettings(db: SqlDriver): Promise<WebSettings> {
  const get = (key: string) => getSetting(db, key)
  return {
    enabled: (await get(WEB_SETTINGS.enabled)) === 'on',
    open: (await get(WEB_SETTINGS.open)) === 'on',
    categoryIds: parseIds(await get(WEB_SETTINGS.categories)),
    origin: (await get(WEB_SETTINGS.origin))?.trim().replace(/\/+$/, '') || null,
    googleClientId: (await get(WEB_SETTINGS.googleClientId))?.trim() || null,
    answerMinutes: whole(await get(WEB_SETTINGS.answerMinutes), ANSWER_MINUTES_DEFAULT),
    collectDays: whole(await get(WEB_SETTINGS.collectDays), COLLECT_DAYS_DEFAULT),
    hours: (await get(WEB_SETTINGS.hours))?.trim() || null,
  }
}

/** Whether this shop is one online orders were built for. */
export async function isOnlineOrderShop(db: SqlDriver): Promise<boolean> {
  const shopId = await getSetting(db, 'shop_id')
  return shopId !== null && ONLINE_ORDER_SHOPS.includes(shortShopId(shopId))
}

export type WebRefusal = 'NOT_THIS_SHOP' | 'TURNED_OFF' | 'NOT_THE_MAIN'

/** Why this till may not answer the web, or null when it may. */
export async function whyNotServing(db: SqlDriver): Promise<WebRefusal | null> {
  if (!await isOnlineOrderShop(db)) return 'NOT_THIS_SHOP'
  if ((await getSetting(db, WEB_SETTINGS.enabled)) !== 'on') return 'TURNED_OFF'
  if (!await answersOnlineOrders(db)) return 'NOT_THE_MAIN'
  return null
}

/**
 * Whether this till is the one that answers online orders: the main, or a
 * till on its own, which is its own main and has nobody to disagree with.
 *
 * Accepting, turning away and every change of status is the main's alone, as
 * answering the storefront is. Two tills that could each accept an order
 * would raise two sales orders for one customer. Every till still sees the
 * orders and any counter can bill one.
 */
export async function answersOnlineOrders(db: SqlDriver): Promise<boolean> {
  const role = await tillRole(db)
  return role === 'main' || role === 'alone'
}

export async function onlineOrdersAllowed(db: SqlDriver): Promise<boolean> {
  return (await whyNotServing(db)) === null
}

/**
 * The owner changing how the storefront behaves, under `settings` `write` like
 * every other setting. Only what is given is changed.
 */
export async function saveWebSettings(
  db: SqlDriver, actorId: string, changes: Partial<WebSettings>,
): Promise<WebSettings> {
  await requirePermission(db, actorId, 'settings', 'write')
  const put = (key: string, value: string) => setSetting(db, key, value)
  if (changes.enabled !== undefined) await put(WEB_SETTINGS.enabled, changes.enabled ? 'on' : 'off')
  if (changes.open !== undefined) await put(WEB_SETTINGS.open, changes.open ? 'on' : 'off')
  if (changes.categoryIds !== undefined) await put(WEB_SETTINGS.categories, JSON.stringify(changes.categoryIds))
  if (changes.origin !== undefined) await put(WEB_SETTINGS.origin, changes.origin?.trim().replace(/\/+$/, '') ?? '')
  if (changes.googleClientId !== undefined) await put(WEB_SETTINGS.googleClientId, changes.googleClientId?.trim() ?? '')
  if (changes.answerMinutes !== undefined) await put(WEB_SETTINGS.answerMinutes, String(Math.max(1, Math.round(changes.answerMinutes))))
  if (changes.collectDays !== undefined) await put(WEB_SETTINGS.collectDays, String(Math.max(1, Math.round(changes.collectDays))))
  if (changes.hours !== undefined) await put(WEB_SETTINGS.hours, changes.hours?.trim().slice(0, 120) ?? '')
  return loadWebSettings(db)
}

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function whole(raw: string | null, fallback: number): number {
  const n = Number(raw)
  return raw !== null && Number.isInteger(n) && n > 0 ? n : fallback
}
