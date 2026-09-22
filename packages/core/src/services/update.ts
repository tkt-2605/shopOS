import type { SqlDriver } from '../db/driver.js'

/**
 * Deciding whether to install an update. The decision, not the download.
 *
 * Lives in core rather than in the app because the rule it holds is a
 * business rule -- *not while the drawer is open* -- and because a rule that
 * needs Tauri around it to be tested is a rule that gets tested once.
 * `apps/pos/src/core/updater.ts` supplies an `UpdateSource` that really talks
 * to the updater plugin; the tests supply one that does not, and both go
 * through this.
 *
 * ## The rule
 *
 * An update replaces the binary and restarts the app. If it does that while a
 * cash session is open, the shopkeeper comes back to a till that has
 * forgotten what it was doing mid-count, and the drawer reconciliation for
 * that shift is somewhere between awkward and unrecoverable. So:
 *
 * **Downloading is always allowed. Installing waits for the drawer to close.**
 *
 * Separating them matters on an Indian shop's connection: the download is the
 * slow part and can happen across the afternoon, so that when the shop closes
 * the install is instant rather than a twenty-minute wait somebody cancels.
 *
 * ## What is deliberately not here
 *
 * Any notion of a forced update. A till that must update to keep working is a
 * till that stops working when the update server is down, which is the same
 * failure the whole product is built to avoid.
 */

export interface AvailableUpdate {
  version: string
  /** What the release says it changes. Shown as-is; may be empty. */
  notes: string
  /** ISO, from the feed. Null when the feed does not say. */
  publishedAt: string | null
}

export type UpdateStage =
  /** Nothing known yet, or the last check found nothing. */
  | { stage: 'idle'; checkedAt: number | null }
  | { stage: 'checking' }
  /** There is a newer build and it has not been fetched. */
  | { stage: 'available'; update: AvailableUpdate }
  | { stage: 'downloading'; update: AvailableUpdate; percent: number }
  /** Fetched and verified. Waiting for a moment to install. */
  | { stage: 'ready'; update: AvailableUpdate }
  | { stage: 'installing'; update: AvailableUpdate }
  /**
   * The last attempt failed. Not an error screen: a till that cannot reach
   * the update server is a till that is working perfectly well.
   */
  | { stage: 'failed'; why: string; checkedAt: number }

/** What the platform can actually do. Implemented once per host. */
export interface UpdateSource {
  /** Null when this build is current, or when the feed could not be read. */
  check(): Promise<AvailableUpdate | null>
  download(update: AvailableUpdate, onProgress?: (percent: number) => void): Promise<void>
  /** Replaces the binary and restarts. Does not return on success. */
  install(): Promise<void>
}

/** How often a till asks, on top of the check at start. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

export type InstallRefusal =
  | { ok: false; code: 'NOT_READY'; detail: string }
  | { ok: false; code: 'SESSION_OPEN'; registerName: string | null }

export type CanInstall = { ok: true } | InstallRefusal

/**
 * Whether now is a moment to restart the till.
 *
 * Asks the database rather than taking the app's word for it: the screen
 * that offers the button and the drawer that is open are two different
 * pieces of state, and the one that matters is the one in the file.
 */
export async function canInstall(db: SqlDriver, state: UpdateStage): Promise<CanInstall> {
  if (state.stage !== 'ready') {
    return { ok: false, code: 'NOT_READY', detail: `nothing to install (${state.stage})` }
  }

  /* raw: a left join for the register's name on a condition that is the
     table's own partial-unique index. The builder can say the join but not
     that this is the index being used, and the name is the whole point --
     "the drawer at Counter 2 is open" is actionable and "a session is open"
     is not. */
  const open = await db.get<{ register_name: string | null }>(
    `SELECT r.name AS register_name
       FROM cash_sessions s
       LEFT JOIN registers r ON r.id = s.register_id
      WHERE s.closed_at IS NULL
      LIMIT 1`,
  )

  if (open !== undefined) {
    return { ok: false, code: 'SESSION_OPEN', registerName: open.register_name }
  }

  return { ok: true }
}

/** What the sidebar says. Empty string means show nothing at all. */
export function updateWords(state: UpdateStage, refusal?: InstallRefusal): string {
  switch (state.stage) {
    case 'idle':
    case 'checking':
      return ''
    case 'available':
      return `Version ${state.update.version} is available`
    case 'downloading':
      return `Getting version ${state.update.version}… ${Math.round(state.percent)}%`
    case 'ready':
      if (refusal?.code === 'SESSION_OPEN') {
        return refusal.registerName === null
          ? `Version ${state.update.version} is ready. It will install once the drawer is closed`
          : `Version ${state.update.version} is ready. Close the drawer at ${refusal.registerName} first`
      }
      return `Version ${state.update.version} is ready to install`
    case 'installing':
      return 'Installing. The till will restart'
    case 'failed':
      /* Deliberately quiet. A shop that cannot reach the update server has
         nothing wrong with it, and a red banner would teach people to ignore
         red banners. */
      return ''
  }
}

/**
 * Whether it is time to ask again.
 *
 * A separate function because "every 24 hours" is the kind of thing a timer
 * gets subtly wrong -- a till switched off overnight has no timer running,
 * and the check that matters most is the one at start.
 */
export function dueForCheck(state: UpdateStage, now: number): boolean {
  switch (state.stage) {
    case 'checking':
    case 'downloading':
    case 'installing':
      return false
    case 'idle':
      return state.checkedAt === null || now - state.checkedAt >= CHECK_EVERY_MS
    case 'failed':
      return now - state.checkedAt >= CHECK_EVERY_MS
    case 'available':
    case 'ready':
      // Already knows about one. Asking again would only find the same thing.
      return false
  }
}
