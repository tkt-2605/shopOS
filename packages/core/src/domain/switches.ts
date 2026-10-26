import type { SigningKey } from './licence.js'
import { verifySigned, type SignedFailure } from './signed.js'
import { shortShopId } from './updateTarget.js'

/*
 * Turning a broken feature off at a shop without shipping a release.
 *
 * A release that turns out to break one feature -- the catching-up screen
 * stuck on a shop's slow line, a nightly recount that runs for an hour on a
 * big catalogue -- would otherwise stay broken at every shop that installed
 * it until the next release is built, tried and taken. A switch board is a
 * signed list of features that are off, at some shops or all, until a date;
 * the portal hands the latest to every till that asks.
 *
 * Only the features below can be switched, and nothing that takes money ever
 * can: a board naming one is refused whole, not half obeyed. Signed with the
 * vendor's repair key (`config/repairs.ts`), so a server broken into cannot
 * switch a shop's till off. A board older than the one a till already holds
 * is ignored, so an old "off" cannot be sent again to undo a newer "on".
 *
 * Pure and DB-free.
 */

export const SWITCHES = {
  startup_sync: 'The catching-up screen when a till opens',
  stock_check: 'The weekly stock recount at night',
  daily_reports: 'Reports sent out by themselves each evening',
  needs_attention_banner: 'The Needs Attention banner across the top of the screen',
  online_orders: 'The storefront: the main stops answering it, and the counter is untouched',
} as const

export type Switch = keyof typeof SWITCHES

/** Never switchable. Named so a board that tries is refused rather than ignored. */
export const NEVER_SWITCHED = ['billing', 'payments', 'returns', 'cash', 'sign_in', 'sync'] as const

export interface SwitchedOff {
  feature: Switch
  /** Short shop ids. Absent: every shop. */
  shops?: string[]
  /** An instant. Absent: until a newer board says otherwise. */
  until?: string
  /** Said in the log and to support; never shown at the counter. */
  why: string
}

export interface SwitchBoard {
  format: 1
  kind: 'switches'
  kid: string
  issuedAt: string
  off: SwitchedOff[]
}

export type BoardResult =
  | { ok: true; board: SwitchBoard }
  | { ok: false; code: SignedFailure; cause?: string }

export async function verifyBoard(raw: string, keys: readonly SigningKey[]): Promise<BoardResult> {
  const signed = await verifySigned(raw, keys, 'config/repairs.ts')
  if (!signed.ok) return signed
  const board = parseBoard(signed.payload)
  return board === null ? { ok: false, code: 'MALFORMED' } : { ok: true, board }
}

/** Whether `next` may replace `held`: only a newer board does. */
export function newer(next: SwitchBoard, held: SwitchBoard | null): boolean {
  return held === null || Date.parse(next.issuedAt) > Date.parse(held.issuedAt)
}

/** Whether a feature is off for this shop now, and why. */
export function switchedOff(
  board: SwitchBoard | null, feature: Switch, shopId: string | null, now: Date,
): { off: false } | { off: true; why: string } {
  if (board === null) return { off: false }
  const mine = shopId === null ? null : shortShopId(shopId)
  for (const entry of board.off) {
    if (entry.feature !== feature) continue
    if (entry.until !== undefined && Date.parse(entry.until) <= now.getTime()) continue
    if (entry.shops !== undefined && (mine === null || !entry.shops.map(shortShopId).includes(mine))) continue
    return { off: true, why: entry.why }
  }
  return { off: false }
}

function parseBoard(v: Record<string, unknown>): SwitchBoard | null {
  if (v['format'] !== 1 || v['kind'] !== 'switches') return null
  const kid = v['kid']
  const issuedAt = v['issuedAt']
  if (typeof kid !== 'string' || typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) return null
  if (!Array.isArray(v['off']) || v['off'].length > 50) return null
  const off: SwitchedOff[] = []
  for (const raw of v['off'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null
    const e = raw as Record<string, unknown>
    if (typeof e['feature'] !== 'string' || !(e['feature'] in SWITCHES)) return null
    if (typeof e['why'] !== 'string') return null
    const entry: SwitchedOff = { feature: e['feature'] as Switch, why: e['why'].slice(0, 300) }
    if (e['shops'] !== undefined) {
      if (!Array.isArray(e['shops']) || e['shops'].length === 0 || !e['shops'].every((s) => typeof s === 'string' && s !== '')) return null
      entry.shops = e['shops'] as string[]
    }
    if (e['until'] !== undefined) {
      if (typeof e['until'] !== 'string' || Number.isNaN(Date.parse(e['until']))) return null
      entry.until = e['until']
    }
    off.push(entry)
  }
  return { format: 1, kind: 'switches', kid, issuedAt, off }
}
