import type { Alert } from './alerts.js'

/*
 * The morning message to the vendor: what needs looking at today.
 *
 * P1 and P2 only. A P3 is on the console for whoever looks, and a morning
 * message that lists every shop with a till switched off is one that stops
 * being read by the second week.
 */

/** Telegram refuses a message longer than this. */
const TELEGRAM_MAX = 4096
/** The hour, shop time, the digest goes after. */
export const DIGEST_HOUR_IST = 8
const IST_OFFSET_MS = 330 * 60_000

export function digestText(
  alerts: readonly Alert[],
  fleet: { shops: number; tills: number; names: ReadonlyMap<string, string | null> },
): string {
  const urgent = alerts.filter((a) => a.severity !== 'P3')
  const later = alerts.length - urgent.length
  const head = `ShopOS: ${fleet.shops} shop(s), ${fleet.tills} till(s).`
  if (urgent.length === 0) {
    return `${head} Nothing urgent.${later > 0 ? ` ${later} smaller thing(s) on the console.` : ''}`
  }

  const lines = [head, `${urgent.length} to look at today:`]
  let shop: string | null = null
  for (const a of urgent) {
    if (a.shopId !== shop) {
      shop = a.shopId
      const name = fleet.names.get(a.shopId)
      lines.push('', `${name ?? 'Shop'} (${a.shopId.slice(0, 8)})`)
    }
    lines.push(`${a.severity} ${a.deviceId === null ? 'shop' : `till ${a.deviceId.slice(0, 8)}`}: ${a.text}`)
  }
  if (later > 0) lines.push('', `And ${later} smaller thing(s) on the console.`)

  const text = lines.join('\n')
  return text.length <= TELEGRAM_MAX ? text : `${text.slice(0, TELEGRAM_MAX - 40)}\n… more on the console.`
}

/** The shop's day in India, `2026-10-16`, for "has today's gone yet". */
export function istDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** Whether the digest should go now, given the day it last went. */
export function digestDue(now: Date, lastSentDay: string | null): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  return ist.getUTCHours() >= DIGEST_HOUR_IST && istDay(now) !== lastSentDay
}

export interface DigestBot {
  token: string
  chat: string
  /** Telegram's address; a test points it at itself. */
  api?: string
}

export async function sendToTelegram(
  bot: DigestBot, text: string, fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetcher(`${bot.api ?? 'https://api.telegram.org'}/bot${bot.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: bot.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) return { ok: true }
    return { ok: false, error: `Telegram said ${res.status}: ${(await res.text()).slice(0, 200)}` }
  } catch (cause) {
    // The token is in the address, and an error that quotes the address quotes the token.
    return { ok: false, error: String(cause).split(bot.token).join('...') }
  }
}
