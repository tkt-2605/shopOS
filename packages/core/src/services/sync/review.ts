import { eq, desc, count } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { ContestedChange } from './types.js'

/*
 * What a person is asked to look at after the tills have merged: edits that
 * lost a tiebreak, and records this database could not take at all.
 */

export interface RecordedConflict extends ContestedChange {
  id: string
  at: string
  peerDevice: string | null
}

/**
 * Where two tills disagreed and one side's change was dropped.
 *
 * Nothing retries these and nothing repairs them. The only thing that can be
 * done is for a person to look and decide whether it mattered, which is why they
 * are kept rather than counted.
 */
export async function recentConflicts(
  db: SqlDriver,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<RecordedConflict[]> {
  /* `WHERE acknowledged = 0 OR ? = 0` bound the flag itself so SQLite could
     work out the condition did not apply. Here it is either in the list or it
     is not. */
  const unreadOnly = options.unreadOnly !== false

  const rows = await q(db)
    .select({
      id: schema.syncConflicts.id,
      at: schema.syncConflicts.at,
      peerDevice: schema.syncConflicts.peerDevice,
      table: schema.syncConflicts.tableName,
      rowId: schema.syncConflicts.rowId,
      winner: schema.syncConflicts.winner,
      explain: schema.syncConflicts.explain,
    })
    .from(schema.syncConflicts)
    .where(unreadOnly ? eq(schema.syncConflicts.acknowledged, 0) : undefined)
    .orderBy(desc(schema.syncConflicts.at))
    .limit(options.limit ?? 50)

  // `winner` is text in the database and these are the two words this build
  // writes into it. A third could only come from a build that had a third.
  return rows.map((r) => ({ ...r, winner: r.winner as 'mine' | 'theirs' }))
}

/** Marks them read. Kept rather than deleted — what the tills disagreed about
 *  is worth having later, even once somebody has seen it. */
export async function acknowledgeConflicts(db: SqlDriver): Promise<number> {
  // raw: how many were marked read is the answer, and the proxy the typed
  // queries go over does not carry a row count back.
  const result = await db.execute(
    `UPDATE sync_conflicts SET acknowledged = 1 WHERE acknowledged = 0`,
  )
  return result.rowsAffected
}

/** How many nobody has looked at. For a badge, and for the screen's headline. */
export async function unreadConflictCount(db: SqlDriver): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.syncConflicts)
    .where(eq(schema.syncConflicts.acknowledged, 0))
  return row?.n ?? 0
}

export interface QuarantinedRecord {
  id: string
  at: string
  peerDevice: string | null
  table: string
  rowId: string
  op: string
  /** What SQLite said, verbatim. The constraint name is the diagnosis. */
  reason: string
  /** The record as it arrived. Parsed lazily by whoever wants to look at it. */
  record: string
}

/**
 * Records another till holds and this one could not take.
 *
 * Kept apart from `sync_conflicts` because the two fail differently and want
 * different answers. A conflict is a decision: both tills had the row, one
 * version won, and a person may want to know whose edit went. A quarantined
 * record is not a decision at all — this database refused it, the other one has
 * it, and the two shops genuinely differ until somebody does something.
 *
 * So this list is the more urgent of the two, and unlike a conflict it usually
 * has a fix: the reason names the constraint, and the constraint names what to
 * merge or rename by hand.
 */
export async function quarantinedRecords(
  db: SqlDriver,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<QuarantinedRecord[]> {
  const unreadOnly = options.unreadOnly !== false

  return q(db)
    .select({
      id: schema.syncQuarantine.id,
      at: schema.syncQuarantine.at,
      peerDevice: schema.syncQuarantine.peerDevice,
      table: schema.syncQuarantine.tableName,
      rowId: schema.syncQuarantine.rowId,
      op: schema.syncQuarantine.op,
      reason: schema.syncQuarantine.reason,
      record: schema.syncQuarantine.record,
    })
    .from(schema.syncQuarantine)
    .where(unreadOnly ? eq(schema.syncQuarantine.acknowledged, 0) : undefined)
    .orderBy(desc(schema.syncQuarantine.at))
    .limit(options.limit ?? 50)
}

/** How many nobody has looked at. For a badge, and for the status line. */
export async function unreadQuarantineCount(db: SqlDriver): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.syncQuarantine)
    .where(eq(schema.syncQuarantine.acknowledged, 0))
  return row?.n ?? 0
}

/**
 * Marks them read. Kept rather than deleted, like a conflict — and for one
 * reason more: the row is the only copy of the record, so deleting it is the
 * second half of losing the data.
 */
export async function acknowledgeQuarantine(db: SqlDriver): Promise<number> {
  // raw: how many were marked read is the answer, and the proxy the typed
  // queries go over does not carry a row count back.
  const result = await db.execute(
    `UPDATE sync_quarantine SET acknowledged = 1 WHERE acknowledged = 0`,
  )
  return result.rowsAffected
}

/**
 * Forgets one, once a person has put the shop right by hand.
 *
 * Deliberately by id and one at a time. The row is the only copy of a record
 * this database never applied, so the wholesale version of this is a way to
 * lose the evidence of a problem along with the problem.
 */
export async function discardQuarantined(db: SqlDriver, id: string): Promise<void> {
  await q(db).delete(schema.syncQuarantine).where(eq(schema.syncQuarantine.id, id))
}
