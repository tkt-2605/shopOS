import type { SqlDriver, TxOptions } from '../db/driver.js'
import { REPLICATED } from '../domain/replicaShape.js'

/**
 * What has changed on this machine since another till last asked.
 *
 * Phase 1 of `docs/multi-device.md`, and on its own it replicates nothing — it
 * is the question sync gets to ask instead of "send me your whole database".
 * Migration 021 carries the reasoning for the shape; this is the reading end.
 *
 * The feed is a **set of what is dirty**, not a log of what happened. One row
 * per changed record, replaced each time it changes, so a price edited forty
 * times before anyone asks is one row rather than forty. It holds no copy of the
 * data: it names what changed and the row itself is read at send time, because a
 * payload stored here would be a second version of the truth and this product is
 * built on there not being one.
 */

export type ChangeOp = 'upsert' | 'delete'

export interface Change {
  /** Ordering, and the cursor. Never reused — the column is AUTOINCREMENT. */
  seq: number
  table: string
  rowId: string
  /**
   * A hint, not the answer. The sender resolves the row when it sends it, and a
   * row that is not there has been deleted whatever this says — which is what
   * settles the one case the triggers cannot agree on between them, a document
   * deleted while its own lines cascade away underneath it.
   */
  op: ChangeOp
  at: string
}

interface FeedRow {
  seq: number
  table_name: string
  row_id: string
  op: ChangeOp
  at: string
}

/**
 * Everything that has changed after `cursor`, oldest first.
 *
 * `limit` is a batch size rather than a safeguard: a till that has been switched
 * off for a fortnight has a large feed, and the point of a cursor is that it can
 * be caught up in pieces without holding one transaction open across all of it.
 */
export async function changesSince(
  db: SqlDriver,
  cursor: number,
  limit = 500,
): Promise<Change[]> {
  const rows = await db.query<FeedRow>(
    `SELECT seq, table_name, row_id, op, at
       FROM change_feed
      WHERE seq > ?
      ORDER BY seq
      LIMIT ?`,
    [cursor, limit],
  )
  return rows.map((r) => ({
    seq: r.seq,
    table: r.table_name,
    rowId: r.row_id,
    op: r.op,
    at: r.at,
  }))
}

/**
 * The newest seq in the feed, or 0 when there is nothing to send.
 *
 * Not for use as a cursor after taking a batch — take the seq of the last row
 * actually read, or a change written between the query and this call is stepped
 * over and never sent again.
 */
export async function feedHead(db: SqlDriver): Promise<number> {
  const row = await db.get<{ head: number | null }>(
    `SELECT MAX(seq) AS head FROM change_feed`,
  )
  return row?.head ?? 0
}

/** How much is waiting. For the screen Phase 3 owes a person. */
export async function pendingCount(db: SqlDriver, cursor = 0): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM change_feed WHERE seq > ?`, [cursor],
  )
  return row?.n ?? 0
}

/**
 * Writes a merge's changes without feeding them back to the till they came from.
 *
 * Applying a change from another machine is itself a write, so it lands in this
 * feed, so the other machine pulls it back and applies it and feeds it again.
 * Two tills would hand one row back and forth for ever, each doing real work and
 * neither making progress.
 *
 * The flag lives in a table because a trigger can see nothing else, and it is
 * set **inside the transaction** so that it cannot outlive a failure: a merge
 * that throws rolls the flag back with everything else, and a machine that loses
 * power mid-merge never committed it. A till that quietly stopped telling anyone
 * anything would be this product's own worst failure — a switch that is on and
 * does nothing — so it is arranged not to be reachable rather than cleaned up
 * afterwards.
 */
export async function applyingRemote<T>(
  db: SqlDriver,
  fn: (tx: SqlDriver) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(`UPDATE sync_state SET applying = 1 WHERE id = 1`)
    try {
      return await fn(tx)
    } finally {
      // Before the commit, so no committed state ever has it set. On the throwing
      // path this runs and is then rolled back anyway, which is the same answer.
      await tx.execute(`UPDATE sync_state SET applying = 0 WHERE id = 1`)
    }
  }, opts)
}

/** Whether the feed is currently switched off. For tests and for a diagnostic. */
export async function isApplyingRemote(db: SqlDriver): Promise<boolean> {
  const row = await db.get<{ applying: number }>(
    `SELECT applying FROM sync_state WHERE id = 1`,
  )
  return row?.applying === 1
}

/**
 * Belt and braces at startup.
 *
 * Given `applyingRemote` above, this should never have anything to do: the flag
 * is only ever set inside a transaction, so it is rolled back by any failure and
 * never committed as 1. It is here because the cost of being wrong about that is
 * a till that silently replicates nothing, and the cost of running it is one
 * UPDATE against a one-row table.
 */
export async function resetSyncState(db: SqlDriver): Promise<void> {
  await db.execute(`UPDATE sync_state SET applying = 0 WHERE id = 1`)
}

/**
 * Puts the whole shop into the feed, so a till that has just joined receives it.
 *
 * The feed records what has *changed*, and it began empty at migration 021. A
 * shop that had been selling for a year therefore had two rows in it and twenty
 * products, six customers and twenty-nine bills outside it — so a new till
 * pairing with that shop received the two rows and none of the shop. Pairing
 * worked, syncing worked, and nothing arrived.
 *
 * Rather than a second protocol for first contact, the answer is to say that
 * everything is new: one INSERT per replicated table, in dependency order, so
 * the sequence numbers come out parents-first and a batch cannot carry a bill
 * before the customer it belongs to.
 *
 * Every peer is behind these entries, not only the new one, so an existing till
 * is sent the shop again. That is bandwidth on a LAN, once, when somebody adds a
 * till — and applying a record identical to the one already held loses the
 * tiebreak and writes nothing. The alternative is a feed per peer, which is the
 * same data multiplied by the number of tills to save a few seconds once.
 */
export async function seedFeedWithEverything(db: SqlDriver): Promise<number> {
  return db.transaction(async (tx) => {
    let marked = 0
    for (const shape of REPLICATED) {
      /* Deliberately not inside `applyingRemote`, and deliberately not touching
         the rows: these have not changed. A write to the rows themselves would
         raise every `rev` in the shop and make this till look newer than every
         other one, which is a lie that then wins every merge. */
      const result = await tx.execute(
        `INSERT INTO change_feed (table_name, row_id, op, at)
         SELECT ?, "${shape.key}", 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           FROM "${shape.table}"
          WHERE "${shape.key}" NOT IN (
                SELECT row_id FROM change_feed WHERE table_name = ?)`,
        [shape.table, shape.table],
      )
      marked += result.rowsAffected
    }
    return marked
  })
}

/**
 * Forgets entries up to and including `upTo`, which the caller has established
 * every peer has received.
 *
 * The seq comes from the caller because who the peers are and how far each has
 * read is Phase 2's question. Pruning on any looser rule loses changes: an entry
 * dropped before a till that was switched off has seen it is a row that machine
 * never learns about, and nothing afterwards will mention it again.
 */
export async function pruneFeed(db: SqlDriver, upTo: number): Promise<number> {
  const result = await db.execute(`DELETE FROM change_feed WHERE seq <= ?`, [upTo])
  return result.rowsAffected
}
