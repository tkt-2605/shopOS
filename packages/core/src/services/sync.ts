import { eq, desc, count, min } from 'drizzle-orm'
import type { Row, SqlDriver, SqlValue } from '../db/driver.js'
import { MERGE_BUDGET_MS } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../db/migrationKinds.js'
import { deviceId } from '../device.js'
import { newId } from '../ids.js'
import { decideRow, decideDeletion } from '../domain/merge.js'
import {
  REPLICATED, shapeOf, type ChangeBatch, type ChangeRecord,
} from '../domain/replicaShape.js'
import { applyingRemote, changesSince, pendingCount, pruneFeed } from './changefeed.js'
import { getSetting } from './bootstrap.js'
import { recomputeStock } from './stock.js'
import { resolveDeviceRegister } from './registers.js'
import { clock } from '../clock.js'

/**
 * Two tills agreeing.
 *
 * Deliberately knows nothing about networks. It is handed a `SyncTransport` —
 * three methods — and everything that can be got wrong about replication lives
 * on this side of that line, where two real databases can be pointed at each
 * other in a test and made to agree without a socket existing.
 *
 * That split is the point. The bugs that matter here are not dropped packets,
 * they are a row applied on one till and not the other, a cursor moved before
 * the batch arrived, an edit silently overwritten. None of those need a network
 * to happen and none of them need one to reproduce.
 */

export interface PeerHello {
  deviceId: string | null
  label: string | null
  schemaVersion: number
  /**
   * The oldest schema the peer will sync with.
   *
   * Optional, and its absence means something specific rather than nothing: a
   * till running a build from before Phase 2c does not send this field *and*
   * refuses anything but an exact match. Treating "absent" as "they demand
   * equality" is therefore the truth about that peer, not a guess -- and it
   * gives the honest refusal here instead of a round that dies at their end.
   */
  minPeerSchema?: number
  /**
   * Which shop the peer is. Null on a till that has been migrated and not set
   * up, which is what a new till joining an existing shop looks like.
   */
  shopId: string | null
  /**
   * Which counter the peer bills on. Two tills on one counter mint the same
   * invoice numbers, which is the one thing the whole seam exists to prevent.
   */
  registerId?: string | null
  /** How far the peer has read of *our* feed. */
  yourCursorWithThem: number
}

export interface SyncTransport {
  /** Who are you, what version are you on, and how far have you read of mine? */
  hello(): Promise<PeerHello>
  /** Everything you have after `since`, up to `limit` records. */
  fetch(since: number, limit: number): Promise<ChangeBatch>
  /** Here is everything I have after your cursor. */
  offer(batch: ChangeBatch): Promise<{ upTo: number }>
}

export type SyncResult =
  | {
      ok: true
      peer: string
      received: number
      sent: number
      /** Rows where both tills had changed the same record since last agreeing. */
      contested: ContestedChange[]
      /** True when more is waiting and another round would fetch it. */
      more: boolean
      /**
       * Columns and tables in what arrived that this database has no place for.
       *
       * Not an error and not silence. A till one additive migration ahead sends
       * rows with a column this one has never heard of; dropping it is right,
       * and saying nothing about it would leave a shopkeeper with two tills
       * that quietly hold different things. The newer side reports zero and the
       * older side reports what it left out, so the counts also say which way
       * round the pair is.
       */
      ignoredColumns: number
      ignoredTables: number
    }
  | {
      ok: false; code: 'SCHEMA_MISMATCH'; mine: number; theirs: number
      /** Which side is too old to be talked to, for the sentence a screen shows. */
      behind: 'mine' | 'theirs'
    }
  | { ok: false; code: 'NO_IDENTITY' }
  | { ok: false; code: 'SAME_DEVICE' }
  | { ok: false; code: 'DIFFERENT_SHOP'; mine: string; theirs: string }
  | { ok: false; code: 'SAME_REGISTER'; registerId: string }

export interface ContestedChange {
  table: string
  rowId: string
  winner: 'mine' | 'theirs'
  explain: string
}

const BATCH = 200

/**
 * One round with one peer: pull, apply, push, then move the cursors.
 *
 * Pull before push so that a till which is about to be overruled has already
 * been told about it, and so that a batch we send is built from a database that
 * has just taken in everything the other side had. The order is not arbitrary —
 * doing it the other way round means each till spends a round sending changes
 * the other has already superseded.
 */
export async function syncWith(
  db: SqlDriver,
  transport: SyncTransport,
  chosenRegister?: string | null,
): Promise<SyncResult> {
  const me = deviceId()
  if (me === null) return { ok: false, code: 'NO_IDENTITY' }

  const hello = await transport.hello()

  /* Before a single row moves.
   *
   * This used to demand that the two versions be equal, which is right while
   * every till in the shop is updated by one person on one afternoon and wrong
   * the first time it is not. An update rolls out; the second till is switched
   * off; it comes back on Monday and the shop cannot sync at all, with nothing
   * on either screen explaining why. That is the common case, and across an
   * additive migration there was never anything unsafe about it.
   *
   * So each side carries a floor -- the version after its last breaking
   * migration -- and the pair is allowed when each is at or above the other's.
   * Both directions are checked because the danger is not symmetrical with the
   * numbers: the newer till writes columns the older has no place for, and the
   * older sends rows missing columns the newer has made NOT NULL. */
  const theirFloor = hello.minPeerSchema ?? hello.schemaVersion
  if (hello.schemaVersion < MIN_PEER_SCHEMA_VERSION) {
    return {
      ok: false, code: 'SCHEMA_MISMATCH', behind: 'theirs',
      mine: EXPECTED_SCHEMA_VERSION, theirs: hello.schemaVersion,
    }
  }
  if (EXPECTED_SCHEMA_VERSION < theirFloor) {
    return {
      ok: false, code: 'SCHEMA_MISMATCH', behind: 'mine',
      mine: EXPECTED_SCHEMA_VERSION, theirs: hello.schemaVersion,
    }
  }

  /* Two shops, not two tills. Both databases were set up separately, so each
     minted its own Admin role, its own counter, its own default price list —
     same names, different ids — and every natural key in the schema collides.
     There is no merge rule for that, because the two rows are not two versions
     of one thing; they are two different things with one name. Refused here, at
     the handshake, rather than dying on a UNIQUE constraint halfway through
     writing somebody's database. A till with no shop of its own may join any
     shop, which is exactly what a new till is. */
  const myShop = await getSetting(db, 'shop_id')
  if (myShop !== null && hello.shopId !== null && myShop !== hello.shopId) {
    return { ok: false, code: 'DIFFERENT_SHOP', mine: myShop, theirs: hello.shopId }
  }

  if (hello.deviceId === null) return { ok: false, code: 'NO_IDENTITY' }
  /* A till syncing with itself would apply its own changes back over itself and
     tiebreak every dead heat against its own id. Harmless and completely
     pointless, and it means something is misconfigured, so it is said out loud. */
  if (hello.deviceId === me) return { ok: false, code: 'SAME_DEVICE' }

  /* Both tills billing on one counter. They mint the same invoice numbers from
     the same series, so the first bill to cross fails on `bills.doc_no` and the
     sync dies on a UNIQUE constraint with nothing saying why.
     
     Refused rather than risked, and refused *before* anything moves. This is the
     one outcome the whole seam exists to prevent, it is recoverable in ten
     seconds by pressing "Use here" on the right counter, and it is exactly what
     a second till gets by default -- `resolveDeviceRegister` falls back to the
     first active counter when a machine has never been asked. */
  const mineRegister = await resolveDeviceRegister(db, chosenRegister ?? null)
  if (
    mineRegister !== null
    && hello.registerId !== null
    && hello.registerId !== undefined
    && hello.registerId === mineRegister
  ) {
    return { ok: false, code: 'SAME_REGISTER', registerId: mineRegister }
  }

  const peer = await rememberPeer(db, hello.deviceId, hello.label)

  // ── pull ────────────────────────────────────────────────────────────────
  const incoming = await transport.fetch(peer.theirCursor, BATCH)
  const mineChanged = await changedHere(db, peer.myCursor)
  const { applied, contested, ignoredColumns, ignoredTables } =
    await applyBatch(db, incoming, mineChanged)

  if (incoming.records.length > 0) {
    await q(db).update(schema.syncPeers)
      .set({ theirCursor: incoming.upTo })
      .where(eq(schema.syncPeers.deviceId, hello.deviceId))
  }

  // ── push ────────────────────────────────────────────────────────────────
  const outgoing = await collectChanges(db, hello.yourCursorWithThem, BATCH)
  let sent = 0
  if (outgoing.records.length > 0) {
    const ack = await transport.offer(outgoing)
    /* Their word, not our hope. A batch that left here and never landed has to
       be sent again, and a cursor moved because we posted it is a row lost with
       nothing anywhere recording that it went missing. */
    sent = outgoing.records.length
    await q(db).update(schema.syncPeers)
      .set({ myCursor: ack.upTo })
      .where(eq(schema.syncPeers.deviceId, hello.deviceId))
  }

  await q(db).update(schema.syncPeers)
    .set({ lastAgreedAt: clock.iso() })
    .where(eq(schema.syncPeers.deviceId, hello.deviceId))

  return {
    ok: true,
    peer: hello.deviceId,
    received: applied,
    sent,
    ignoredColumns,
    ignoredTables,
    contested,
    more: !incoming.complete || !outgoing.complete,
  }
}

/**
 * Rounds until there is nothing left to say.
 *
 * `syncWith` does one round of at most 200 records and reports `more` when there
 * is a queue behind it. A till switched off for a fortnight has thousands
 * waiting, and one round leaves it almost as far behind as it started — so
 * something has to keep going, and it is here rather than in a screen, where it
 * would be written twice and stopped by a person changing pages.
 *
 * Bounded, because a loop that runs until it is finished is a loop that never
 * finishes if the two tills keep handing each other the same row. `rounds` is
 * reached only when something is wrong, and reaching it is reported rather than
 * retried for ever.
 */
export async function syncUntilDone(
  db: SqlDriver,
  transport: SyncTransport,
  rounds = 50,
  chosenRegister?: string | null,
): Promise<SyncResult> {
  let last = await syncWith(db, transport, chosenRegister)
  let done = 1

  while (last.ok && last.more && done < rounds) {
    const next = await syncWith(db, transport, chosenRegister)
    if (!next.ok) return next

    /* No progress and still saying there is more means the two are passing
       something back and forth. Stopping and saying so beats spinning. */
    if (next.received === 0 && next.sent === 0) return { ...next, more: false }

    last = { ...next, contested: [...last.contested, ...next.contested] }
    done += 1
  }

  return last
}

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
): Promise<ChangeBatch> {
  const entries = await changesSince(db, cursor, limit + 1)
  const complete = entries.length <= limit
  const batch = complete ? entries : entries.slice(0, limit)

  const records: ChangeRecord[] = []
  for (const entry of batch) {
    const shape = shapeOf(entry.table)
    if (shape === undefined) continue // not replicated; see NOT_REPLICATED

    /* raw: the table and its key are `REPLICATED`'s, read at run time. See the
       note on `upsert` below for why this half of the file stays written out. */
    const row = await db.get<Row>(
      `SELECT * FROM "${shape.table}" WHERE "${shape.key}" = ?`, [entry.rowId],
    )

    /* A row that is not there has been deleted, whatever the feed says about it.
       The two disagree in exactly one case — a document deleted while its own
       lines cascade away beneath it, each firing a trigger — and looking is the
       answer that is right either way. */
    if (row === undefined) {
      records.push({ table: shape.table, rowId: entry.rowId, op: 'delete', row: null })
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
    upTo: batch.length > 0 ? batch[batch.length - 1]!.seq : cursor,
    complete,
  }
}

/**
 * Applies a batch, deciding each record against what is already here.
 *
 * Everything happens inside `applyingRemote`, so none of it is fed back to the
 * till it came from and none of it raises a revision. Both matter: a revision
 * raised here would make this copy look newer than the machine that wrote it,
 * and the next round would send it straight back as an edit nobody made.
 */
export interface MergeOutcome {
  applied: number
  contested: ContestedChange[]
  /** See `SyncResult.ignoredColumns`. */
  ignoredColumns: number
  ignoredTables: number
}

export async function applyBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string> = new Set(),
): Promise<MergeOutcome> {
  if (batch.records.length === 0) {
    return { applied: 0, contested: [], ignoredColumns: 0, ignoredTables: 0 }
  }

  const outcome = await mergeBatch(db, batch, changedHereToo)

  /* `product_stock` is a cache of the ledger and does not replicate — and
     `NOT_REPLICATED` has said "a merge recomputes it" since the day it was
     written, while nothing did. So a till that took in another till's sales had
     stale stock figures until somebody happened to open Inventory, and the two
     tills quietly disagreed about what was on the shelf.

     This is also the whole of the oversell case. Two tills each sell the last
     one: each is at zero and neither is wrong on its own, and only after the
     ledgers are put together is the shop one short. Nothing recomputed, so
     nothing went below zero, so "Counts that need fixing" stayed empty and
     nobody was ever told.

     Only the products whose ledger rows actually arrived, and after the merge
     rather than inside it, so a busy counter is not held behind a long
     transaction. A recompute that is missed is picked up by the next sync or by
     the weekly replay; a counter that stalls mid-sale is not recoverable in the
     same way.

     Scoped since Phase 3. This used to replay the whole ledger — every product
     in the shop, forty-seven thousand movements on a year of trade, because one
     row for one item came across. */
  if (outcome.applied > 0) {
    const touched = productsIn(batch)
    if (touched === null || touched.length > 0) {
      await recomputeStock(db, { repair: true, ...(touched ? { productIds: touched } : {}) })
    }
  }

  return outcome
}

/**
 * Which products a batch has something to say about, or null for "cannot tell".
 *
 * A deletion carries no row, so there is no way to learn from the batch alone
 * which product the deleted movement belonged to. That answers null and the
 * caller replays everything, which is slow and correct — and the alternative,
 * guessing, leaves one product's cache wrong with nothing to notice it until
 * the weekly replay. The ledger is append-only in practice, so this is a path
 * that should almost never be taken.
 */
function productsIn(batch: ChangeBatch): string[] | null {
  const ids = new Set<string>()
  for (const record of batch.records) {
    if (record.table !== 'stock_ledger') continue
    const id = record.row?.['product_id']
    if (typeof id !== 'string') return null
    ids.add(id)
  }
  return [...ids]
}

/**
 * What columns a table has here, asked once per table per process.
 *
 * A merge reads this for every row it applies, and the answer cannot change
 * while the app is running: a migration runs at startup, before anything syncs.
 * Cached on the driver rather than globally, so a test that opens two databases
 * in one process does not hand one of them the other's shape.
 */
const columnsOf = new WeakMap<SqlDriver, Map<string, Set<string> | null>>()

async function localColumns(db: SqlDriver, table: string): Promise<Set<string> | null> {
  let tables = columnsOf.get(db)
  if (!tables) { tables = new Map(); columnsOf.set(db, tables) }

  const cached = tables.get(table)
  if (cached !== undefined) return cached

  /* The table name is interpolated because it cannot be bound -- it is an
     identifier, not a value. It comes from `REPLICATED` in `replicaShape.ts`
     and never from the wire: `shapeOf` has already refused anything that is not
     on that list, so a peer cannot name a table here. */
  // raw: a PRAGMA, which a query builder has no words for.
  const info = await db.query<{ name: string }>(`PRAGMA table_info("${table}")`)
  const columns = info.length === 0 ? null : new Set(info.map((c) => c.name))
  tables.set(table, columns)
  return columns
}

/**
 * A row as this database can hold it: the columns it knows, and no others.
 *
 * A till one additive migration ahead sends rows carrying a column this one has
 * never heard of. Passing it straight to an INSERT fails the whole batch on
 * "no such column", every round, in the same way, for ever -- so the shop stops
 * syncing rather than syncing slightly less.
 */
function known(row: Row, columns: Set<string>): { row: Row; dropped: number } {
  const kept: Row = {}
  let dropped = 0
  for (const [name, value] of Object.entries(row)) {
    if (columns.has(name)) kept[name] = value
    else dropped += 1
  }
  return { row: kept, dropped }
}

async function mergeBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
): Promise<MergeOutcome> {
  /* Ninety seconds rather than a bill's fifteen.
   *
   * The whole batch is one transaction on purpose: half a merge is not a state
   * any reconciliation rule can describe. On a till that has been offline a week
   * that can legitimately take a minute, and under a bill's budget the watchdog
   * rolls it back — so the next round starts again from the beginning, takes
   * just as long, and is rolled back again. A till far enough behind would never
   * catch up, and nobody would diagnose that from the shop floor. */
  return applyingRemote(db, async (tx) => {
    let applied = 0
    let ignoredColumns = 0
    let ignoredTables = 0
    const contested: ContestedChange[] = []

    /* Foreign keys are checked at COMMIT rather than per statement, for the rows
       written inside this transaction only.

       `REPLICATED` is in dependency order and the feed is seeded in that order,
       so a batch normally arrives parents-first anyway. This is the safety net
       for the cases that ordering cannot cover: a row whose parent changed in
       the same batch and sorted after it, and `bills.amended_from`, which points
       at another bill. Without it one such row fails the whole batch — every
       time, in the same way, for ever. The check still happens; it happens once,
       at the end, when the batch is whole. */
    await tx.execute(`PRAGMA defer_foreign_keys = ON`)

    for (const record of batch.records) {
      const shape = shapeOf(record.table)
      if (shape === undefined) continue

      /* A table the peer has and this database does not -- they are ahead by a
         migration that added one. Counted and skipped, rather than failing the
         batch that carries it. */
      const columns = await localColumns(tx, shape.table)
      if (columns === null) { ignoredTables += 1; continue }

      // raw: `REPLICATED`'s table and key again. See the note on `upsert`.
      const mine = await tx.get<Row>(
        `SELECT * FROM "${shape.table}" WHERE "${shape.key}" = ?`, [record.rowId],
      )
      const both = changedHereToo.has(`${record.table}\u0000${record.rowId}`)

      if (record.op === 'delete') {
        if (mine === undefined) continue
        const call = decideDeletion({
          deletedRev: numberOf(record.row?.['rev']),
          survivingRev: numberOf(mine['rev']),
        })
        if (call.winner === 'delete') {
          await tx.execute(`DELETE FROM "${shape.table}" WHERE "${shape.key}" = ?`, [record.rowId])
          applied += 1
          if (both) {
            contested.push({
              table: record.table, rowId: record.rowId,
              winner: 'theirs', explain: call.explain,
            })
          }
        }
        continue
      }

      if (record.row === null) continue

      if (mine !== undefined) {
        const call = decideRow({
          mine: { rev: numberOf(mine['rev']), updatedAt: textOf(mine['updated_at']) },
          theirs: { rev: numberOf(record.row['rev']), updatedAt: textOf(record.row['updated_at']) },
          myDevice: deviceId(),
          theirDevice: batch.fromDevice,
          bothChangedSinceLastSync: both,
        })
        if (call.contested) {
          contested.push({
            table: record.table, rowId: record.rowId,
            winner: call.winner, explain: call.explain,
          })
        }
        // Keeping what is here writes nothing at all, which is always the safer
        // of two answers — and leaves this machine's feed exactly as it was.
        if (call.winner === 'mine') continue
      }

      const trimmed = known(record.row, columns)
      ignoredColumns += trimmed.dropped
      await upsert(tx, shape.table, shape.key, trimmed.row)

      for (const line of shape.lines) {
        /* The winning side's document is the document. Merging lines one by one
           builds a bill neither till ever had — three items from here, two from
           there, and totals belonging to nobody. */
        await tx.execute(
          `DELETE FROM "${line.table}" WHERE "${line.parentKey}" = ?`, [record.rowId],
        )
        const lineColumns = await localColumns(tx, line.table)
        if (lineColumns === null) { ignoredTables += 1; continue }

        for (const row of record.lines?.[line.table] ?? []) {
          const line0 = known(row, lineColumns)
          ignoredColumns += line0.dropped
          await insert(tx, line.table, line0.row)
        }
      }
      applied += 1
    }

    /* Written inside the same transaction that applied the batch, so a merge
       that rolls back cannot leave a complaint about a change it did not make.

       This matters more once the catch-up runs on its own: up to here a person
       was watching the answer, and from here nobody is. A dropped edit that is
       only ever returned from a function is a dropped edit nobody hears about. */
    for (const complaint of contested) {
      await q(tx).insert(schema.syncConflicts).values({
        id: newId(),
        at: clock.iso(),
        peerDevice: batch.fromDevice,
        tableName: complaint.table,
        rowId: complaint.rowId,
        winner: complaint.winner,
        explain: complaint.explain,
      })
    }

    return { applied, contested, ignoredColumns, ignoredTables }
  }, { budgetMs: MERGE_BUDGET_MS })
}

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

/**
 * Records that a peer could not be reached, or that it now can.
 *
 * One fact per peer rather than a history, because the useful question is "is it
 * working, and since when has it not been" — and a thousand rows saying the same
 * till was off all weekend answer that worse than one row saying so.
 */
export async function recordAttempt(
  db: SqlDriver,
  peerDeviceId: string,
  error: string | null,
): Promise<void> {
  await q(db).update(schema.syncPeers)
    .set({ lastError: error, lastTriedAt: clock.iso() })
    .where(eq(schema.syncPeers.deviceId, peerDeviceId))
}

/** Which records have also changed here since the peer last read our feed. */
export async function changedHere(
  db: SqlDriver,
  cursor: number,
): Promise<ReadonlySet<string>> {
  const entries = await changesSince(db, cursor, 100_000)
  return new Set(entries.map((e) => `${e.table}\u0000${e.rowId}`))
}

/**
 * The half of sync that is written out, and why it stays that way.
 *
 * Everything from here down takes its table, its key and its column list from
 * `replicaShape.ts` at run time and from the row that arrived over the wire.
 * A query builder is a way of naming columns at compile time; this code does
 * not know its columns until a batch is in front of it, and that is not an
 * accident of how it was written -- it is what lets one function replicate
 * forty-three tables instead of forty-three functions doing it each their own
 * way, each able to forget a column.
 *
 * The safety here is not the compiler. It is `shapeOf`, which refuses any table
 * not on the replicated list before a name reaches a statement, and `known()`,
 * which drops any column this database does not have. A peer cannot name a
 * table or a column that gets this far.
 *
 * `PRAGMA table_info` and `PRAGMA defer_foreign_keys` are written out for a
 * plainer reason: they are not statements a builder has any words for.
 */
async function upsert(tx: SqlDriver, table: string, key: string, row: Row): Promise<void> {
  const columns = Object.keys(row)
  const assignments = columns
    .filter((c) => c !== key)
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(', ')

  /* ON CONFLICT DO UPDATE rather than INSERT OR REPLACE, and the difference is
     not style: REPLACE deletes the row before inserting it, which fires every
     ON DELETE CASCADE hanging off it. One replaced bill would take its own items
     with it and leave a bill with no lines. */
  await tx.execute(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT ("${key}") DO UPDATE SET ${assignments}`,
    columns.map((c) => row[c] as SqlValue),
  )
}

async function insert(tx: SqlDriver, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row)
  await tx.execute(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => row[c] as SqlValue),
  )
}

/* Takes the two fields rather than the whole `hello`, because the device id is
   not optional here although it is on the wire: `syncWith` refuses a peer
   without one before it gets this far, and the column is NOT NULL. */
async function rememberPeer(
  db: SqlDriver,
  deviceId: string,
  label: string | null,
): Promise<{ theirCursor: number; myCursor: number }> {
  await q(db).insert(schema.syncPeers)
    .values({ deviceId, label, createdAt: clock.iso() })
    .onConflictDoUpdate({
      target: schema.syncPeers.deviceId,
      // The label only. The cursors are where this pair has got to and are
      // never reset by meeting again.
      set: { label },
    })

  const [row] = await q(db)
    .select({
      theirCursor: schema.syncPeers.theirCursor,
      myCursor: schema.syncPeers.myCursor,
    })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, deviceId))
  return { theirCursor: row?.theirCursor ?? 0, myCursor: row?.myCursor ?? 0 }
}

export interface PeerHealth {
  deviceId: string
  label: string | null
  /** When the two tills last actually agreed about everything. */
  lastAgreedAt: string | null
  /** When this till last tried, whether or not it worked. */
  lastTriedAt: string | null
  /** Why the last attempt failed, or null when it did not. */
  lastError: string | null
  /** How much this till still has to tell that one. */
  waiting: number
}

/**
 * Every till this one knows, and whether it is actually working.
 *
 * `lastAgreedAt` on its own is the number that lies most comfortably: a till
 * that agreed at 4pm and has been unreachable since 4:05 looks, at a glance,
 * exactly like one that agreed at 4pm and had nothing to say afterwards. So the
 * last attempt and its error come with it, and so does how much is queued.
 */
export async function listPeers(db: SqlDriver): Promise<PeerHealth[]> {
  const rows = await q(db)
    .select({
      deviceId: schema.syncPeers.deviceId,
      label: schema.syncPeers.label,
      lastAgreedAt: schema.syncPeers.lastAgreedAt,
      lastTriedAt: schema.syncPeers.lastTriedAt,
      lastError: schema.syncPeers.lastError,
      myCursor: schema.syncPeers.myCursor,
    })
    .from(schema.syncPeers)
    .orderBy(schema.syncPeers.createdAt)

  const out: PeerHealth[] = []
  for (const r of rows) {
    const { myCursor, ...peer } = r
    out.push({ ...peer, waiting: await pendingCount(db, myCursor) })
  }
  return out
}

/**
 * Drops feed entries every known peer has confirmed receiving.
 *
 * The lowest `my_cursor` across all peers, and not a row further: an entry
 * dropped before a till that has been switched off for a fortnight has seen it
 * is a change that machine never learns about, and nothing will mention it
 * again. A shop with no peers prunes nothing, which is correct — it has nobody
 * to have told.
 */
export async function pruneAcknowledged(db: SqlDriver): Promise<number> {
  const [row] = await q(db)
    .select({ safe: min(schema.syncPeers.myCursor), peers: count() })
    .from(schema.syncPeers)
  if (!row || row.peers === 0 || row.safe === null) return 0
  return pruneFeed(db, row.safe)
}

/** The tables that travel, for a diagnostic screen and for tests. */
export const REPLICATED_TABLES: readonly string[] = REPLICATED.map((r) => r.table)

function numberOf(v: SqlValue | undefined): number | null {
  return typeof v === 'number' ? v : null
}

function textOf(v: SqlValue | undefined): string | null {
  return typeof v === 'string' ? v : null
}
