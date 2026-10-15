import type { TillSummary } from './read.js'

/*
 * What needs looking at, from each till's latest health report.
 *
 * The rules are the table in `docs/specs/support-kit.md`, part 2. Each is a
 * plain function of the reports and the time, so the same rules drive the
 * console, the morning digest and the tests, and a rule can be changed and
 * run again over reports already received.
 *
 * Severity is how fast somebody should look, not how bad it sounds: a shop
 * that cannot bill on one counter still bills on another, so very little here
 * is a P1. The books and the database itself are.
 *
 * Pure and DB-free.
 */

export type Severity = 'P1' | 'P2' | 'P3'

export interface Alert {
  severity: Severity
  rule: string
  shopId: string
  /** Null for a rule about the shop as a whole. */
  deviceId: string | null
  text: string
}

export interface TillLatest {
  shopId: string
  deviceId: string
  receivedAt: string
  summary: TillSummary
}

const HOUR = 3_600_000
export const QUIET_AFTER_HOURS = 48
export const STUCK_AFTER_HOURS = 24
export const SET_ASIDE_AFTER_HOURS = 24
export const SKEW_LIMIT_MS = 5 * 60_000
export const LICENCE_WARN_DAYS = 14
export const CRASHES_FOR_P1 = 3

export function alertsFor(tills: readonly TillLatest[], now: Date): Alert[] {
  const out: Alert[] = []
  const byShop = new Map<string, TillLatest[]>()
  for (const till of tills) byShop.set(till.shopId, [...(byShop.get(till.shopId) ?? []), till])

  for (const [shopId, shop] of byShop) {
    const recent = new Set(shop.filter((t) => ageHours(t.receivedAt, now) <= QUIET_AFTER_HOURS).map((t) => t.deviceId))

    for (const till of shop) {
      const s = till.summary
      const say = (severity: Severity, rule: string, text: string) =>
        out.push({ severity, rule, shopId, deviceId: till.deviceId, text })

      const quiet = ageHours(till.receivedAt, now)
      if (quiet > QUIET_AFTER_HOURS) {
        say('P3', 'quiet', `No report for ${Math.floor(quiet / 24)} days. The till may simply be off.`)
      }

      if (s.integrityOk === false || (s.foreignKeyProblems ?? 0) > 0) {
        say('P1', 'integrity', s.integrityOk === false
          ? 'The database failed its integrity check.'
          : `${s.foreignKeyProblems} record(s) point at something that is not there.`)
      }

      if ((s.booksMissing ?? 0) > 0) {
        say('P1', 'books', `${s.booksMissing} submitted bill(s) have no entries in the books.`)
      }

      for (const problem of s.problems) say('P2', 'problem', problem)

      for (const peer of s.peers) {
        // Stuck only when both ends are reporting: a till that is switched off is not a stuck sync.
        if (!recent.has(peer.deviceId) || !recent.has(till.deviceId)) continue
        const since = peer.lastAgreedAt === null ? Infinity : ageHours(peer.lastAgreedAt, now)
        if (since > STUCK_AFTER_HOURS) {
          say('P2', 'sync_stuck', `Has not agreed with ${peer.label ?? peer.deviceId.slice(0, 8)} `
            + (peer.lastAgreedAt === null ? 'yet' : `for ${Math.floor(since)} hours`)
            + (peer.lastError ? `: ${peer.lastError}` : '.'))
        }
      }

      if (s.setAsideWaiting > 0 && s.oldestSetAsideAt !== null
        && ageHours(s.oldestSetAsideAt, now) > SET_ASIDE_AFTER_HOURS) {
        say('P2', 'set_aside', `${s.setAsideWaiting} record(s) from another till could not be taken in.`)
      }

      if (s.discrepancyKinds.length > 0) {
        say('P3', 'discrepancy', `Needs Attention: ${s.discrepancyKinds.join(', ')}.`)
      }

      const skewed = s.peers.filter((p) => p.clockSkewMs !== null && Math.abs(p.clockSkewMs) > SKEW_LIMIT_MS)
      if (s.clockUnreliable || skewed.length > 0) {
        say('P3', 'clock', s.clockUnreliable
          ? 'The machine\'s date is earlier than one it has already seen.'
          : `Clock is ${Math.round(Math.abs(skewed[0]!.clockSkewMs!) / 60_000)} minutes off another till.`)
      }

      const l = s.licence
      if (l?.problem) say('P2', 'licence', `The licence will not verify: ${l.problem}.`)
      else if (l?.state === 'grace') say('P2', 'licence', `Paid time has ended (${l.paidThrough}); in grace.`)
      else if (l?.state === 'active' && l.paidThrough !== null) {
        const days = (Date.parse(`${l.paidThrough}T23:59:59Z`) - now.getTime()) / (24 * HOUR)
        if (days >= 0 && days <= LICENCE_WARN_DAYS) say('P2', 'licence', `Paid time ends ${l.paidThrough}.`)
      }

      const crashes = s.runs?.panicked ?? 0
      if (crashes > 0) {
        say(crashes >= CRASHES_FOR_P1 ? 'P1' : 'P2', 'crash', `${crashes} crash(es) on ${s.version} out of ${s.runs!.started} run(s).`)
      }
    }

    const versions = [...new Set(shop.filter((t) => recent.has(t.deviceId)).map((t) => t.summary.version).filter(Boolean))]
    if (versions.length > 1) {
      out.push({ severity: 'P3', rule: 'versions', shopId, deviceId: null, text: `Tills on different versions: ${versions.sort().join(', ')}.` })
    }
  }

  const order: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 }
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.shopId.localeCompare(b.shopId))
}

function ageHours(iso: string, now: Date): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? Infinity : (now.getTime() - at) / HOUR
}
