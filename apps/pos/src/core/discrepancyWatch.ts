import { discrepanciesWithSeen, markDiscrepanciesSeen, type Discrepancy, type SqlDriver } from '@shopos/core'
import { onSyncRound } from './syncLoop'
import { logEvent } from './log'

/**
 * What in the shop's records does not add up, kept current for the screens.
 *
 * Asked when the app starts, after every sync round that brought something in
 * -- which is when another counter's refund, sale or credit can turn out to
 * clash with this one's -- and whenever a screen asks. A module-level slot
 * like `outOfDate.ts`, because the banner on every screen and the list on the
 * dashboard must show the same thing.
 */

export type Found = Discrepancy & { seen: boolean }

let found: Found[] = []
const listeners = new Set<(found: Found[]) => void>()
let running: Promise<void> | null = null
let again = false

export function discrepancies(): Found[] {
  return found
}

export function onDiscrepancies(fn: (found: Found[]) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Reads the shop again. One run at a time; a call while one is running asks
 * for one more after it, so a burst of sync rounds is one or two reads.
 */
export function checkDiscrepancies(db: SqlDriver): Promise<void> {
  if (running) { again = true; return running }
  running = (async () => {
    try {
      do {
        again = false
        const before = new Set(found.map((d) => d.key))
        const next = await discrepanciesWithSeen(db)
        const fresh = next.filter((d) => !d.seen && !before.has(d.key))
        /* Written down as well as shown: a till nobody is looking at still
           leaves a record that it noticed. */
        for (const d of fresh) logEvent('warn', 'discrepancy', `${d.title}. ${d.detail}`)
        found = next
        for (const fn of listeners) fn(found)
      } while (again)
    } catch (err) {
      logEvent('error', 'discrepancy', `could not check the records: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = null
    }
  })()
  return running
}

/** Marks some seen on this till and reads again. */
export async function markSeen(db: SqlDriver, keys: readonly string[], actorId: string | null): Promise<void> {
  await markDiscrepanciesSeen(db, { keys, actorId })
  await checkDiscrepancies(db)
}

let watching: (() => void) | null = null

/** Starts watching: once now, and after each sync round that brought anything in. */
export function watchDiscrepancies(db: SqlDriver): void {
  if (watching) return
  void checkDiscrepancies(db)
  watching = onSyncRound((reports) => {
    if (reports.some((r) => r.ok && r.received > 0)) void checkDiscrepancies(db)
  })
}
