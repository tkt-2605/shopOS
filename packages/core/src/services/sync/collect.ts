import type { Row, SqlDriver } from '../../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { deviceId } from '../../device.js'
import { shapeOf, type ChangeBatch, type ChangeRecord } from '../../domain/replicaShape.js'
import { changesSince, feedHead, prunedThrough, seedFeedWithEverything } from '../changefeed.js'

/*
 * What leaves this till: the records a peer has not seen, read as they stand,
 * and which of an incoming batch's rows were also changed here.
 */

export const BATCH = 200

/**
 * What has changed here since `cursor`, as records ready to cross.
 *
 * The row is read now rather than stored when it changed, so what travels is the
 * record as it stands. A payload written into the feed would have been a second
 * copy of the truth, and the older it got the more confidently wrong it would be.
 */
export async function collectChanges(
  db: SqlDriver,
  cursor: number,
  limit = BATCH,
  /** The till this batch is for. Its own changes are left out of it. */
  forPeer: string | null = null,
): Promise<ChangeBatch> {
  await catchUpFromBelowTheFloor(db, cursor, forPeer)
  /* Read before the entries, so a row written in between lies above it and is
     still sent next time. Everything at or below it that the batch leaves out
     is the peer's own, which it is never sent: see `upTo` below. */
  const head = await feedHead(db)
  const entries = await changesSince(db, cursor, limit + 1, forPeer)
  const complete = entries.length <= limit
  const batch = complete ? entries : entries.slice(0, limit)

  const records: ChangeRecord[] = []
  for (const entry of batch) {
    const shape = shapeOf(entry.table)
    if (shape === undefined) continue // not replicated; see NOT_REPLICATED

    /* raw: the table and its key are `REPLICATED`'s, read at run time. See the
       note on `upsert` in `record.ts` for why this half stays written out. */
    const row = await db.get<Row>(
      `SELECT * FROM "${shape.table}" WHERE "${shape.key}" = ?`, [entry.rowId],
    )

    /* A row that is not there has been deleted, whatever the feed says about it.
       The two disagree in exactly one case — a document deleted while its own
       lines cascade away beneath it, each firing a trigger — and looking is the
       answer that is right either way. */
    if (row === undefined) {
      /* `row` for a delete is not the row — there is none — it is the one fact
         about it that outlives it: which revision went. `decideDeletion` is
         written against exactly this and had nothing to read until 040. Null
         when even that is unknown, which is a delete fed before 040 or a
         document that vanished under its own cascading lines. */
      records.push({
        table: shape.table, rowId: entry.rowId, op: 'delete',
        row: { rev: entry.deletedRev },
      })
      continue
    }

    const lines: Record<string, Row[]> = {}
    for (const line of shape.lines) {
      lines[line.table] = await db.query<Row>(
        `SELECT * FROM "${line.table}" WHERE "${line.parentKey}" = ?`, [entry.rowId],
      )
    }

    records.push({
      table: shape.table,
      rowId: entry.rowId,
      op: 'upsert',
      row,
      ...(shape.lines.length > 0 ? { lines } : {}),
    })
  }

  return {
    fromDevice: deviceId(),
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    records,
    /* A complete batch has given the peer everything it will ever get up to
       `head`, including the entries left out because they were its own. Stopping
       at the last one sent left the peer's cursor short of its own relayed
       changes for good, and every screen saying "short by 2" with nothing to
       come -- the three-till bench, 18 October. */
    upTo: complete
      ? Math.max(cursor, head, batch.at(-1)?.seq ?? cursor)
      : batch.at(-1)!.seq,
    complete,
  }
}

/**
 * Which records have also changed *here* since the peer last read our feed.
 *
 * Locally written entries only. A row this till merely relayed from a third
 * counter did change here in the sense that it was written, but nobody at this
 * counter touched it -- and reporting it as contested would tell a shopkeeper
 * that two people edited one thing when one did.
 */
export async function changedHere(
  db: SqlDriver,
  cursor: number,
  about: ReadonlyArray<{ table: string; rowId: string }>,
): Promise<ReadonlySet<string>> {
  if (about.length === 0) return new Set()

  /* Only about the rows in front of us.

     This used to read the feed itself — `changesSince(db, cursor, 100_000)` —
     and build a set of everything this till had changed, once per round, up to
     fifty rounds in a catch-up pass. On a till that has been offline a fortnight
     that is a hundred thousand rows loaded and thrown away fifty times to answer
     a question about two hundred of them.

     The limit was the worse half, because it was silent. A feed longer than the
     cap came back truncated, every row past it read as `not changed here`, and a
     genuine clash was applied without a word — which is the one failure
     `sync_conflicts` exists to prevent.

     Asked the other way round there is nothing to cap. `change_feed` is UNIQUE
     on `(table_name, row_id)`, and the batch is at most five hundred records. */
  const ids = [...new Set(about.map((r) => r.rowId))]
  const wanted = new Set(about.map((r) => `${r.table}\u0000${r.rowId}`))

  /* raw: an `IN` list as long as the batch, which a builder has no shape for.
     Filtered by `row_id` alone and narrowed in JS afterwards: a single indexed
     lookup, and a row id that happens to be a `settings` key rather than a uuid
     cannot smuggle in another table's row because `wanted` carries both. */
  const entries = await db.query<{ table_name: string; row_id: string }>(
    `SELECT table_name, row_id FROM change_feed
      WHERE seq > ?
        AND origin_device IS NULL
        AND row_id IN (${ids.map(() => '?').join(',')})`,
    [cursor, ...ids],
  )

  return new Set(
    entries
      .map((e) => `${e.table_name}\u0000${e.row_id}`)
      .filter((key) => wanted.has(key)),
  )
}

/** Peers already given the whole shop again by this process. */
const reseeded = new WeakMap<SqlDriver, Set<string>>()

/**
 * A peer asking from below where the feed was pruned has missed entries --
 * it was away past `FEED_LEASE_MS`, and the feed went on without it. It is
 * given the whole shop again, which is what a till that has just joined gets
 * and for the same reason: the feed alone no longer says everything it lacks.
 * Rows it already holds are identical and write nothing there.
 *
 * Once per peer per run: after the first time every row is in the feed and a
 * second pass would find nothing to add, at the price of a scan of every table.
 * What cannot be sent again is a delete, because the row is gone -- a peer away
 * for a month keeps a draft the rest of the shop threw out.
 */
async function catchUpFromBelowTheFloor(db: SqlDriver, cursor: number, forPeer: string | null): Promise<void> {
  if (forPeer === null || cursor >= await prunedThrough(db)) return
  let done = reseeded.get(db)
  if (!done) { done = new Set(); reseeded.set(db, done) }
  if (done.has(forPeer)) return
  await seedFeedWithEverything(db)
  done.add(forPeer)
}
