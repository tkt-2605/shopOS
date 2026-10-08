import {
  recomputeStock, reconcileLoyalty, reconcileReturnedQty, reconcileFulfilledQty, type SqlDriver,
} from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'
import { msUntilHour, DAILY_BACKUP_HOUR } from './backup'
import { logEvent } from './log'

/**
 * The slow checks, on a timer, because they are too slow to do on a screen.
 *
 * ## What changed and why this exists
 *
 * `recomputeStock` replays the stock ledger — the longest table in the shop —
 * and the Dashboard was running it on every mount to decide whether to show one
 * line of warning. On a year of trade that is about 160 ms of pure arithmetic
 * before the page can paint, and it grows with every sale the shop has ever
 * made. A screen that costs a linear pass over the shop's history to open is
 * the wrong shape however fast it is today.
 *
 * But the check itself is worth keeping. It is the only thing that would ever
 * notice a `product_stock` row written by something outside `stock.ts`, and its
 * value comes precisely from being unbounded: a scoped replay cannot find drift
 * on a product nobody has touched. So it moves to a timer, and the Dashboard
 * reads what the timer found.
 *
 * ## It reports and does not repair
 *
 * Deliberately. Drift means something wrote stock outside the one module
 * allowed to, and quietly correcting that every week would hide a bug that is
 * still happening — the shop would be repaired for ever and never told. The
 * repair stays where it was, behind a person pressing a button on Inventory,
 * and that button now records what it found so the Dashboard's warning clears
 * the moment it is dealt with rather than at the next weekly run.
 *
 * The merge is the exception and stays as it is: `applyBatch` repairs, because
 * after taking in another till's ledger rows the cache is *known* to be stale
 * by construction. That is not drift, it is arithmetic that has not been done
 * yet.
 *
 * ## Where the result is kept
 *
 * On the machine, not in the shop's database. `product_stock` is a device-local
 * cache that does not replicate — `NOT_REPLICATED` says so — so "when did this
 * cache last get checked" is a fact about this till and nothing to send to
 * another one.
 */

/** Seven days. A drift check is looking for something that should never happen. */
export const STOCK_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

const CHECKED_AT = 'stock_checked_at'
const DRIFT_FOUND = 'stock_drift'

export interface StockCheck {
  /** When the ledger was last replayed in full, ISO. */
  at: string
  /** How many products disagreed with it. */
  drift: number
}

/** What the last full replay found, or null if this machine has never run one. */
export function lastStockCheck(): StockCheck | null {
  const at = deviceSetting(CHECKED_AT)
  if (!at) return null
  const drift = Number(deviceSetting(DRIFT_FOUND) ?? '0')
  return { at, drift: Number.isFinite(drift) ? drift : 0 }
}

export async function recordStockCheck(check: StockCheck): Promise<void> {
  await setDeviceSetting(CHECKED_AT, check.at)
  await setDeviceSetting(DRIFT_FOUND, String(check.drift))
}

export function stockCheckIsDue(now = new Date(), last = lastStockCheck()): boolean {
  if (!last) return true
  const when = Date.parse(last.at)
  // A machine whose clock has been moved backwards would otherwise never run
  // this again. An unreadable date is treated the same as never having run.
  if (!Number.isFinite(when)) return true
  return now.getTime() - when >= STOCK_CHECK_INTERVAL_MS || when > now.getTime()
}

/**
 * Replays the whole ledger if it has been a week, and records what it found.
 *
 * Returns null when it was not due, so a caller can tell "nothing to report"
 * from "checked, and nothing was wrong".
 */
export async function runStockCheck(
  db: SqlDriver,
  opts: { now?: Date; force?: boolean } = {},
): Promise<StockCheck | null> {
  const now = opts.now ?? new Date()
  if (!opts.force && !stockCheckIsDue(now)) return null

  const started = Date.now()
  const drift = await recomputeStock(db)
  const check: StockCheck = { at: now.toISOString(), drift: drift.length }
  await recordStockCheck(check)

  logEvent(
    drift.length === 0 ? 'info' : 'warn',
    'maintenance',
    `Stock replay over ${Date.now() - started} ms: ${drift.length} product(s) adrift`,
  )

  /* The other caches that a merge can leave behind, checked in full once a
     week as stock is -- a sync only looks at what its batch touched. Each
     repairs what is safe to repair and reports the rest. */
  const points = await reconcileLoyalty(db, { repair: true })
  const returned = await reconcileReturnedQty(db, { repair: true })
  const fulfilled = await reconcileFulfilledQty(db, { repair: true })
  const all = [...points, ...returned, ...fulfilled]
  const left = all.filter((d) => !d.repairable).length
  if (all.length > 0) {
    logEvent(
      left === 0 ? 'info' : 'warn',
      'maintenance',
      `Loyalty, returned and fulfilled quantities: ${all.length - left} put right, ${left} left for a person`,
    )
  }
  return check
}

/**
 * Runs the check at the next 02:00 and every 02:00 after. Returns the stop.
 *
 * Re-armed with a fresh timeout each round rather than a 24 h interval, for the
 * reason the backup timer used to give: the two disagree the moment somebody
 * corrects the machine's clock, and a till whose clock was wrong is exactly the
 * till somebody has just been fixing.
 *
 * Every night, and a no-op on six of them — so a machine that is off at 02:00
 * on the seventh day still gets its turn on the eighth rather than waiting
 * another week.
 */
export function startMaintenanceTimer(
  db: SqlDriver,
  report: (check: StockCheck) => void,
  hour = DAILY_BACKUP_HOUR,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function arm(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void runStockCheck(db)
        .then((check) => { if (check && !stopped) report(check) })
        .catch((err: unknown) => {
          /* Swallowed on purpose. This is housekeeping at two in the morning;
             a failure here must not take down the timer that carries it, and
             the till has to open in the morning regardless. */
          logEvent('error', 'maintenance', `Stock replay failed: ${describe(err)}`)
        })
        .finally(arm)
    }, msUntilHour(hour))
  }

  arm()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  if (typeof err === 'string') return err
  return err instanceof Error ? err.message : 'unknown failure'
}
