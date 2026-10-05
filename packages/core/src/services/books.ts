import type { SqlDriver } from '../db/driver.js'
import { businessDate } from '../dates.js'
import { writeAudit } from '../integrity/audit.js'
import { requirePermission } from '../integrity/permissions.js'
import { getSetting, setSetting } from './settings.js'

/**
 * Books closed through a date.
 *
 * Once a month's GST return is filed, the documents in it are what was filed.
 * Cancelling one of them afterwards changes a return nobody will file again --
 * the export reads a cancelled bill as one that "was never filed", which is
 * true only while the month is still open. The convention, in ERPNext and in
 * every set of books a CA keeps, is a date before which nothing moves: a
 * mistake found later is corrected by a document in the open period (a credit
 * note, a stock adjustment), not by reaching back.
 *
 * What it binds, and what it deliberately does not:
 *
 * - **Binds** cancelling a submitted document dated on or before it, and
 *   posting anything whose date a person chose -- a backdated stock entry, a
 *   count, an opening balance.
 * - **Does not bind** issuing today's bill, return or payment. Those are dated
 *   today by the service, so they are in the open period whenever the lock was
 *   set honestly, and the one rule above all others here is that the counter
 *   keeps taking money. A lock set wrongly on another till must not stop it.
 *
 * One setting, which replicates like any other. Sync applies rows rather than
 * calling services, so a till that cancels something before it has heard of
 * the lock is not stopped -- the same limit every offline rule here has.
 */

export const BOOKS_CLOSED_THROUGH = 'books_closed_through'

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface PeriodClosed {
  ok: false
  code: 'PERIOD_CLOSED'
  /** The last day that is closed. */
  closedThrough: string
}

/** The last closed day, or null when nothing has been closed. */
export async function booksClosedThrough(db: SqlDriver): Promise<string | null> {
  const value = await getSetting(db, BOOKS_CLOSED_THROUGH)
  return value !== null && ISO_DAY.test(value) ? value : null
}

/**
 * The refusal for a document dated `date`, or null when its period is open.
 *
 * Every guarded service asks this inside its own transaction and returns the
 * answer as it stands, so the screens have one shape to explain.
 */
export async function closedFor(db: SqlDriver, date: string): Promise<PeriodClosed | null> {
  const through = await booksClosedThrough(db)
  if (through === null || date > through) return null
  return { ok: false, code: 'PERIOD_CLOSED', closedThrough: through }
}

/** What a screen says when it is refused. One sentence, everywhere. */
export function periodClosedMessage(closedThrough: string): string {
  return `The books are closed through ${closedThrough}. Nothing dated on or before then can be changed; ` +
    'correct it with a document dated today, or have an administrator reopen the period.'
}

export type CloseBooksResult =
  | { ok: true; closedThrough: string | null }
  | { ok: false; code: 'INVALID_DATE' }
  /** Today is still being traded. Closing it would refuse today's own corrections. */
  | { ok: false; code: 'NOT_BEFORE_TODAY'; today: string }

/**
 * Closes the books through `through`, or reopens them all with null.
 *
 * Moving the date back is allowed, because reopening a period is a real thing
 * a shop's CA asks for. Either way it is audited with the date it replaced.
 */
export async function closeBooks(
  db: SqlDriver,
  input: { through: string | null; actorId: string; now?: Date },
): Promise<CloseBooksResult> {
  await requirePermission(db, input.actorId, 'settings', 'write')
  const now = input.now ?? new Date()
  const today = businessDate(now)

  if (input.through !== null) {
    if (!ISO_DAY.test(input.through) || Number.isNaN(Date.parse(`${input.through}T00:00:00`))) {
      return { ok: false, code: 'INVALID_DATE' }
    }
    if (input.through >= today) return { ok: false, code: 'NOT_BEFORE_TODAY', today }
  }

  return db.transaction(async (tx): Promise<CloseBooksResult> => {
    const before = await booksClosedThrough(tx)
    /* Reopened by writing an empty value rather than deleting the row: an edit
       merges between tills by its revision, and a delete is a tombstone some
       other till's older copy could outlive. */
    await setSetting(tx, BOOKS_CLOSED_THROUGH, input.through ?? '', now.toISOString())
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'settings', entityId: BOOKS_CLOSED_THROUGH, action: 'update',
      before: { closed_through: before }, after: { closed_through: input.through },
    })
    return { ok: true, closedThrough: input.through }
  })
}
