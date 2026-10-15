import { invoke } from '@tauri-apps/api/core'
import { entitlement, findDiscrepancies, getSetting, loadShopProfile, type SqlDriver } from '@shopos/core'
import { deviceStore, deviceTrouble } from './device'
import { onSyncRound, type LoopReport } from './syncLoop'
import { outOfDate } from './outOfDate'
import { lastHookRun } from './backup'
import { lastCopyRun } from './backupFolder'
import { lastPackRun, plain } from './reportOut'

/*
 * The shop's health, for its supplier: why a sync failed, why a licence will
 * not verify, what the app's own checks have flagged. Rust adds the database
 * checks and the logs (`health.rs`) and sends it the way reports go.
 *
 * Held to the same rule as `health.rs`: no customer, no amount and no
 * credential. So a discrepancy travels as its kind, area, date and document
 * numbers -- never its title or detail, which can name a customer -- and a
 * licence as its state and problem, never the code itself.
 */

export interface HealthSent {
  name: string
  bytes: number
  mail: 'off' | 'sent' | 'queued'
  mailError: string | null
  telegram: 'off' | 'sent' | 'queued'
  telegramError: string | null
  /** The vendor's portal (`portal_out.rs`): `off` when this build has none. */
  portal: 'off' | 'sent' | 'queued'
  portalError: string | null
}

/** The last round of sync, as the loop reported it, kept from the moment the schedule starts. */
let lastRound: { at: string; reports: LoopReport[] } | null = null
let watching: (() => void) | null = null

export function watchSyncForHealth(): () => void {
  watching ??= onSyncRound((reports) => { lastRound = { at: new Date().toISOString(), reports } })
  return () => { watching?.(); watching = null }
}

/** What the app knows about itself that the database alone cannot say. */
export async function appHealth(db: SqlDriver): Promise<Record<string, unknown>> {
  const settle = async <T>(work: () => Promise<T>): Promise<T | { failed: string }> => {
    try { return await work() } catch (err) { return { failed: err instanceof Error ? err.message : String(err) } }
  }

  const licence = await settle(async () => {
    const e = await entitlement(db, { device: deviceStore() })
    return {
      tier: e.tier, state: e.state, paidThrough: e.paidThrough, graceUntil: e.graceUntil,
      tills: e.tills, clockUnreliable: e.clockUnreliable, shopId: e.shopId, problem: e.problem,
      grants: e.grants.map((g) => ({ tier: g.tier, state: g.state, paidThrough: g.paidThrough, tills: g.tills })),
    }
  })

  const discrepancies = await settle(async () =>
    (await findDiscrepancies(db)).map((d) => ({ kind: d.kind, area: d.area, at: d.at, refs: d.refs.slice(0, 20) })))

  return {
    shopId: await getSetting(db, 'shop_id'),
    clock: { now: new Date().toISOString(), offsetMinutes: -new Date().getTimezoneOffset() },
    licence,
    discrepancies,
    lastSyncRound: lastRound,
    outOfDate: outOfDate(),
    device: deviceTrouble(),
    // Whether they worked and when, not their output: a hook's output is a
    // command's, and can carry whatever that command prints.
    backup: { hook: brief(lastHookRun()), copy: brief(lastCopyRun()) },
    reports: lastPackRun(),
  }
}

function brief(run: { ok: boolean; at: string } | null): { ok: boolean; at: string } | null {
  return run === null ? null : { ok: run.ok, at: run.at }
}

/**
 * The moment in the shop's own time, with its offset: `2026-10-12T01:00:00+05:30`.
 * Rust names the file from its digits, and a name in UTC files an evening's
 * report under the wrong day.
 */
export function localStamp(at: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    + `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/** One line for the caption: what someone opening the chat should see first. */
export function healthLine(app: Record<string, unknown>): string {
  const parts: string[] = []
  const licence = app['licence'] as { state?: string; problem?: string | null } | undefined
  if (licence?.problem) parts.push(`licence: ${licence.problem}`)
  else if (licence?.state) parts.push(`licence: ${licence.state}`)
  const found = app['discrepancies']
  if (Array.isArray(found)) parts.push(found.length === 0 ? 'no problems flagged' : `${found.length} problem(s) flagged`)
  const round = app['lastSyncRound'] as { reports: LoopReport[] } | null
  if (round) {
    const failed = round.reports.filter((r) => !r.ok)
    const setAside = round.reports.reduce((n, r) => n + r.quarantined, 0)
    parts.push(failed.length > 0 ? `sync failing: ${failed.map((r) => r.error ?? 'error').join('; ')}` : 'sync ok')
    if (setAside > 0) parts.push(`${setAside} record(s) set aside`)
  }
  return parts.join(' | ')
}

export async function sendHealth(db: SqlDriver): Promise<HealthSent> {
  const [profile, shopId, app] = await Promise.all([loadShopProfile(db), getSetting(db, 'shop_id'), appHealth(db)])
  const id = (shopId ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || 'noid'
  const label = `${plain(profile.name) || 'Shop'} (${id})`
  return invoke<HealthSent>('health_send', {
    now: localStamp(new Date()),
    label,
    summary: `${label}\n${healthLine(app)}`,
    // The shop's own name, so the vendor's console can say which shop this is.
    extra: { ...app, shopName: plain(profile.name) || null },
  })
}
