import type { SqlDriver } from '@shopos/core'
import type { TillSummary } from './read.js'

/*
 * How each release is holding up across the fleet: runs and crashes per
 * version, from each till's latest report on that version (`faults.json`
 * counts cumulatively, so the latest is the whole story for that till).
 *
 * Crash-free is out of the runs that ended either cleanly or in a crash. A
 * run that ended without closing -- a power cut, a PC switched off at the
 * wall -- is left out of both sides: in a shop without a UPS it is most of
 * the runs that end badly, and it says nothing about the release.
 *
 * `tools/release.ts target` reads this before widening a rollout.
 */

export interface ReleaseHealth {
  version: string
  tills: number
  started: number
  clean: number
  panicked: number
  unclean: number
  /** 0..1, or null when no run has ended cleanly or crashed yet. */
  crashFree: number | null
}

export async function releaseHealth(db: SqlDriver): Promise<ReleaseHealth[]> {
  const rows = await db.query<{ version: string; summary: string }>(
    `SELECT version, summary FROM (
       SELECT version, summary, ROW_NUMBER() OVER (
                PARTITION BY shop_id, device_id, version ORDER BY received_at DESC, rowid DESC) AS n
         FROM health_reports WHERE version IS NOT NULL)
      WHERE n = 1`, // raw: the newest report per till per version, by window function
  )
  const by = new Map<string, ReleaseHealth>()
  for (const row of rows) {
    const runs = (JSON.parse(row.summary) as TillSummary).runs
    const h = by.get(row.version) ?? { version: row.version, tills: 0, started: 0, clean: 0, panicked: 0, unclean: 0, crashFree: null }
    h.tills += 1
    if (runs) {
      h.started += runs.started
      h.clean += runs.clean
      h.panicked += runs.panicked
      h.unclean += runs.unclean
    }
    by.set(row.version, h)
  }
  return [...by.values()]
    .map((h) => ({ ...h, crashFree: h.clean + h.panicked === 0 ? null : h.clean / (h.clean + h.panicked) }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** `0.3.0` against `0.2.21`, as numbers, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number(p))
  const pb = b.split(/[.-]/).map((p) => Number(p))
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (Number.isNaN(pa[i]) ? 0 : pa[i] ?? 0) - (Number.isNaN(pb[i]) ? 0 : pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
