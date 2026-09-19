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
import { applyingRemote, changesSince, feedApplied, pendingCount, pruneFeed } from './changefeed.js'
import { getSetting } from './bootstrap.js'
import { refusedAsSubmitted } from '../integrity/docstatus.js'
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
  /**
   * How far *their* feed goes.
   *
   * The other half of the pair above, and the one that was missing. With only
   * `yourCursorWithThem` a till can say what it still owes and cannot say what
   * it is owed — so a screen reads "everything sent" while this machine is
   * ninety-five bills short and every total on every report is short with it.
   *
   * Optional, because a till on a build from before 044 does not send one.
   * Absent reads as "cannot say", which is not the same as level and is why
   * `behind` is null rather than zero in that case.
   */
  head?: number
  /**
   * Whether this peer can be dialled at all.
   *
   * The peer stating its own shape, rather than this till inferring it from
   * whether an address column happens to be set. A phone answers `false` — iOS
   * suspends a backgrounded app, so there is no port and there never will be —
   * and a till that knows that stops waiting for a timeout every round and
   * stops reporting the shop as unreachable. See migration 044.
   *
   * Absent means yes, which is what every till before 044 is.
   */
  answers?: boolean
  /**
   * The answering till's own clock, in milliseconds.
   *
   * `verify` refuses a request more than five minutes out and that wall is the
   * right wall, but it arrives all at once: a till that has been off and came
   * back with a flat battery fails every round from the first, having drifted
   * through four minutes with nothing said. And the wall is not even the worst
   * of it — the merge settles a tie on `updated_at`, so two tills three minutes
   * apart are two tills where the slower one quietly loses edits it made later,
   * with both screens saying everything agrees.
   *
   * Absent on a build from before 046, which records as level.
   */
  now?: number
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
      /**
       * Records that arrived and could not be applied, set aside rather than
       * allowed to stop everything behind them. See migration 038.
       *
       * Non-zero is not a failed round -- the rest of the batch landed and the
       * cursor moved. It is a round that dropped something, which is a different
       * thing from a round that stalled, and a shopkeeper is owed both.
       */
      quarantined: number
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

     Refused rather than risked, and refused *before* anything moves.

     This used to be the only thing standing between a shop and duplicate
     invoice numbers, and it stood in the wrong place: a second till was handed
     the first one's counter by default, billed on it happily, and met this
     refusal only afterwards -- with two bills already numbered the same on two
     machines, which pressing "Use here" cannot unmake. `resolveDeviceRegister`
     no longer guesses once a shop has a peer, so a till that has not been told
     which counter it is has none and cannot bill at all.

     Which leaves this as a guard that should never fire, and it stays exactly
     for the cases that are not the default: two machines pointed at one counter
     deliberately, or a choice made on both before they ever met. */
  const mineRegister = await resolveDeviceRegister(db, chosenRegister ?? null)

  /* Which counters are spoken for is not learned here. It used to be -- this
     hello was the only moment one till heard another's counter -- and it was
     late and narrow both: two tills choosing in the same minute have not
     exchanged a hello, and a till behind a hub never exchanges one with its
     sibling at all. The claim lives on the counter now and replicates with it.
     See `claimRegister` and migration 037. */
  if (
    mineRegister !== null
    && hello.registerId !== null
    && hello.registerId !== undefined
    && hello.registerId === mineRegister
  ) {
    return { ok: false, code: 'SAME_REGISTER', registerId: mineRegister }
  }

  const peer = await rememberPeer(db, hello.deviceId, hello.label)
  await recordWhatTheySaid(db, hello)

  // ── pull ────────────────────────────────────────────────────────────────
  const incoming = await transport.fetch(peer.theirCursor, BATCH)
  const mineChanged = await changedHere(db, peer.myCursor, incoming.records)
  const { applied, contested, ignoredColumns, ignoredTables, quarantined } =
    await applyBatch(db, incoming, mineChanged)

  if (incoming.records.length > 0) {
    await q(db).update(schema.syncPeers)
      .set({ theirCursor: incoming.upTo })
      .where(eq(schema.syncPeers.deviceId, hello.deviceId))
  }

  // ── push ────────────────────────────────────────────────────────────────
  const outgoing = await collectChanges(db, hello.yourCursorWithThem, BATCH, hello.deviceId)
  let sent = 0
  if (outgoing.records.length > 0) {
    const ack = await transport.offer(outgoing)
    /* Their word, not our hope. A batch that left here and never landed has to
       be sent again, and a cursor moved because we posted it is a row lost with
       nothing anywhere recording that it went missing.

       Their word, but not further than we spoke. A peer that answers with a seq
       beyond the batch it was given — a newer build with a different meaning
       for the field, a reply from a round that overtook this one, a peer that is
       simply wrong — would move this cursor past changes it has never been
       offered, and those changes are then never sent to it again by anything.
       Nothing would report it: the screen would say the tills agree. So the
       cursor goes to whichever is smaller, which is the furthest either side can
       honestly claim. */
    const reached = Math.min(ack.upTo, outgoing.upTo)
    /* An upper bound, as it always was — a record already held by the peer is
       counted here and writes nothing there — but no longer a count of rows that
       may never have been offered at all. A peer that moved nothing sent
       nothing, which is what `syncUntilDone` needs to hear to stop. */
    sent = reached > hello.yourCursorWithThem ? outgoing.records.length : 0
    await q(db).update(schema.syncPeers)
      .set({ myCursor: reached })
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
    quarantined,
    contested,
    more: !incoming.complete || !outgoing.complete,
  }
}

/**
 * What the handshake told us about the peer itself, kept.
 *
 * Two things a peer knows about itself that this till can only guess at: how far
 * its own feed goes, and whether anybody can dial it. Both used to be guessed —
 * the first not at all, and the second from whether an address column was set,
 * which gets a phone right by accident and a cloud peer wrong.
 *
 * Only ever narrowing on `reach`. A peer that says it cannot answer is believed,
 * because it is the only thing that knows; a peer that says nothing is left
 * however it was recorded when somebody paired it, because silence from an older
 * build is not a claim.
 */
async function recordWhatTheySaid(db: SqlDriver, hello: PeerHello): Promise<void> {
  const head = Number.isFinite(hello.head) ? Number(hello.head) : null
  const cannotAnswer = hello.answers === false
  /* A round trip's worth of latency is in this and nothing tries to take it
     out. What it is compared against is two and a half minutes; a LAN round
     trip does not move that, and a subtraction that guessed would be a number
     nobody could check. */
  const skew = Number.isFinite(hello.now) ? Math.round(Number(hello.now) - clock.now()) : null

  if (head === null && skew === null && !cannotAnswer) return
  await q(db).update(schema.syncPeers)
    .set({
      /* The date as well as the number, because 0 is an honest answer — a peer
         whose feed has been pruned empty has nothing for us and says so — and
         without the date it is indistinguishable from a peer that has never
         spoken. Those want opposite sentences. Migration 048. */
      ...(head === null ? {} : { theirHead: head, headSaidAt: clock.iso() }),
      ...(skew === null ? {} : { clockSkewMs: skew }),
      ...(cannotAnswer ? { reach: 'none' as const } : {}),
    })
    .where(eq(schema.syncPeers.deviceId, hello.deviceId!))
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
  let mark = last.ok ? await cursorsWith(db, last.peer) : ''

  while (last.ok && last.more && done < rounds) {
    const next = await syncWith(db, transport, chosenRegister)
    if (!next.ok) return next

    /* Progress is the cursor moving, not rows landing, and the difference is a
       shop that silently stops catching up.

       `seedFeedWithEverything` runs every time a till joins and puts the whole
       shop back in the feed for *every* peer, which is deliberate. A peer that
       already holds those rows applies none of them — an identical row writes
       nothing, correctly — so a round of two hundred records reports `received: 0`
       and `sent: 0` while being perfectly successful. Read as no progress, that
       stopped the catch-up with hundreds of records still queued behind the
       cursor and told the screen the tills agreed.

       The cursor is the honest measure: it moves when a batch was taken,
       whether or not the batch changed anything. It stays where it is exactly
       when nothing crossed, which is the case this guard is for. */
    const reached = await cursorsWith(db, next.peer)
    if (reached === mark) return { ...next, more: false }
    mark = reached

    last = { ...next, contested: [...last.contested, ...next.contested] }
    done += 1
  }

  return last
}

/** How far the two of us have read into each other, as one comparable thing. */
async function cursorsWith(db: SqlDriver, peer: string): Promise<string> {
  const [row] = await q(db)
    .select({ theirs: schema.syncPeers.theirCursor, mine: schema.syncPeers.myCursor })
    .from(schema.syncPeers)
    .where(eq(schema.syncPeers.deviceId, peer))
  return `${row?.theirs ?? 0}/${row?.mine ?? 0}`
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
  /** The till this batch is for. Its own changes are left out of it. */
  forPeer: string | null = null,
): Promise<ChangeBatch> {
  const entries = await changesSince(db, cursor, limit + 1, forPeer)
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
  /**
   * Records that could not be applied and were set aside rather than allowed to
   * stop the batch. See migration 038 and `sync_quarantine`.
   *
   * Reported rather than counted quietly, because the cursor moves past them:
   * the sending till will prune its own entry, and after that the only record
   * that this row ever existed is the one here.
   */
  quarantined: number
}

export async function applyBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string> = new Set(),
): Promise<MergeOutcome> {
  if (batch.records.length === 0) {
    return { applied: 0, contested: [], ignoredColumns: 0, ignoredTables: 0, quarantined: 0 }
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

/** What one record did, before it is folded into the batch's totals. */
interface RecordOutcome {
  applied: number
  contested: ContestedChange[]
  ignoredColumns: number
  ignoredTables: number
}

const NOTHING: RecordOutcome = { applied: 0, contested: [], ignoredColumns: 0, ignoredTables: 0 }

/**
 * One record, decided against what is here and written if it wins.
 *
 * Lifted out of the loop so the slow path can put a savepoint around it. It
 * returns what it did rather than adding to the batch's counters, because a
 * record that throws must leave no trace in them -- one that had already pushed
 * a `contested` row would file a complaint about a decision that never took
 * effect, and inflate `applied` with a row nobody has.
 */
async function applyRecord(
  tx: SqlDriver,
  record: ChangeRecord,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
): Promise<RecordOutcome> {
  const shape = shapeOf(record.table)
  if (shape === undefined) return NOTHING

  /* A table the peer has and this database does not -- they are ahead by a
     migration that added one. Counted and skipped, rather than failing the
     batch that carries it. */
  const columns = await localColumns(tx, shape.table)
  if (columns === null) return { ...NOTHING, ignoredTables: 1 }

  // raw: `REPLICATED`'s table and key again. See the note on `upsert`.
  const mine = await tx.get<Row>(
    `SELECT * FROM "${shape.table}" WHERE "${shape.key}" = ?`, [record.rowId],
  )
  const both = changedHereToo.has(`${record.table}\u0000${record.rowId}`)

  /* Nothing to do, so nothing is done -- and nothing is said about it.
     Two tills that both hold this row identically is the ordinary state of
     a shop that has just synced, and an identical row arrives on every
     round that relays one. Writing it anyway would be worse than wasteful:
     `bump_rev` from 019 fires `WHEN NEW.rev = OLD.rev`, so a write that
     changes nothing is exactly the write that raises the revision -- this
     till would come out looking newer than the machine that wrote the row,
     win every later tiebreak against it, and feed it back again.

     It is also what makes skipping the line tables here safe: 022 raises the
     parent revision when a line changes on the sending side, so a head that
     matches means the lines match too. */
  if (record.op === 'upsert' && record.row !== null && mine !== undefined
      && same(known(record.row, columns).row, mine)) {
    return NOTHING
  }

  if (record.op === 'delete') {
    if (mine === undefined) return NOTHING
    const call = decideDeletion({
      deletedRev: numberOf(record.row?.['rev']),
      survivingRev: numberOf(mine['rev']),
    })
    if (call.winner !== 'delete') return NOTHING

    await tx.execute(`DELETE FROM "${shape.table}" WHERE "${shape.key}" = ?`, [record.rowId])
    /* The trigger will not fire — `applying` is 1 — so the entry this till
       relays is written by hand, and it carries the revision it was given
       rather than the one this till happened to hold. */
    await feedApplied(
      tx, shape.table, record.rowId, 'delete', origin(record, batch),
      numberOf(record.row?.['rev']),
    )
    return {
      ...NOTHING,
      applied: 1,
      contested: both
        ? [{ table: record.table, rowId: record.rowId, winner: 'theirs', explain: call.explain }]
        : [],
    }
  }

  if (record.row === null) return NOTHING

  const contested: ContestedChange[] = []
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
    if (call.winner === 'mine') return { ...NOTHING, contested }

    /* A submitted document is immutable, and until now the merge was the one
       write path that did not know it. `assertEditable` guards every write into
       a document's own row on this machine; this is the same rule for a row
       arriving from another one. `docstatus.ts` carries the argument and the
       list.

       Recorded, never silent: this till is refusing something the other one
       holds, so the two shops now genuinely differ and a person has to be the
       one to decide. */
    const refusal = refusedAsSubmitted(shape.table, mine, record.row)
    if (refusal !== null) {
      return {
        ...NOTHING,
        contested: [{
          table: record.table, rowId: record.rowId, winner: 'mine', explain: refusal,
        }],
      }
    }
  }

  let ignoredColumns = 0
  let ignoredTables = 0

  const trimmed = known(record.row, columns)
  ignoredColumns += trimmed.dropped
  await upsert(tx, shape.table, shape.key, trimmed.row)
  await feedApplied(tx, shape.table, record.rowId, 'upsert', origin(record, batch))

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

  return { applied: 1, contested, ignoredColumns, ignoredTables }
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
  try {
    return await applyingRemote(
      db, (tx) => runBatch(tx, batch, changedHereToo, false), { budgetMs: MERGE_BUDGET_MS },
    )
  } catch {
    /* Something in this batch will not go in, and the fast path has just rolled
       back everything including everything that was fine. So it runs again, with
       a savepoint around each record, and the one that cannot land is set aside
       instead of taking the batch with it.

       A second pass rather than savepoints every time, because the cost is two
       statements per record on a path that already does four or five — paid on
       every healthy merge to insure against a rare one. This way a shop that
       never meets the case never pays for it, and a shop that does pays once.

       Not retried beyond this. If the slow path throws as well then the fault is
       not a record — it is the disk, the schema, or the watchdog — and setting a
       whole batch aside would be inventing a diagnosis. The throw goes up, the
       cursor stays where it was, and the round is reported as failed. */
    return await applyingRemote(
      db, (tx) => runBatch(tx, batch, changedHereToo, true), { budgetMs: MERGE_BUDGET_MS },
    )
  }
}

/**
 * The savepoint's name.
 *
 * One constant rather than one per record: `run_execute` in the Rust driver
 * prepares statements into a small cache, and a fresh name each time would push
 * out the statements the merge actually runs on. SQLite is content to reuse a
 * name — `ROLLBACK TO` and `RELEASE` find the most recent one that carries it.
 */
const RECORD = 'shopos_record'

async function runBatch(
  tx: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
  /** Whether to put a savepoint around each record. See `mergeBatch`. */
  oneByOne: boolean,
): Promise<MergeOutcome> {
  let applied = 0
  let ignoredColumns = 0
  let ignoredTables = 0
  let quarantined = 0
  const contested: ContestedChange[] = []
  const setAside = new Set<string>()

  /* Foreign keys are checked at COMMIT rather than per statement, for the rows
     written inside this transaction only.

     `REPLICATED` is in dependency order and the feed is seeded in that order,
     so a batch normally arrives parents-first anyway. This is the safety net
     for the cases that ordering cannot cover: a row whose parent changed in
     the same batch and sorted after it, and `bills.amended_from`, which points
     at another bill. Without it one such row fails the whole batch — every
     time, in the same way, for ever. The check still happens; it happens once,
     at the end, when the batch is whole.

     It survives a savepoint rollback. SQLite clears the flag on a full rollback
     and on a successful commit and on neither of the two statements below, and
     it restores the count of outstanding violations to what it was when the
     savepoint opened — so a record that is set aside takes its own dangling
     references with it rather than leaving them to fail the COMMIT. */
  await tx.execute(`PRAGMA defer_foreign_keys = ON`)

  for (const record of batch.records) {
    if (!oneByOne) {
      const outcome = await applyRecord(tx, record, batch, changedHereToo)
      applied += outcome.applied
      ignoredColumns += outcome.ignoredColumns
      ignoredTables += outcome.ignoredTables
      contested.push(...outcome.contested)
      continue
    }

    /* A record whose parent was set aside cannot land either, and finding that
       out at COMMIT fails the whole batch — which is the thing this pass exists
       to prevent. `REPLICATED`'s dependency order covers most of it and cannot
       cover a row that points at its own table: `categories.parent_id`,
       `bills.amended_from`, `products.parent_product_id`. */
    const orphaned = await parentSetAside(tx, record, setAside)
    if (orphaned !== null) {
      await quarantine(tx, batch, record, orphaned)
      setAside.add(`${record.table}\u0000${record.rowId}`)
      quarantined += 1
      continue
    }

    await tx.execute(`SAVEPOINT ${RECORD}`)
    try {
      const outcome = await applyRecord(tx, record, batch, changedHereToo)
      await tx.execute(`RELEASE ${RECORD}`)
      applied += outcome.applied
      ignoredColumns += outcome.ignoredColumns
      ignoredTables += outcome.ignoredTables
      contested.push(...outcome.contested)
    } catch (err) {
      /* Both statements, and in this order. `ROLLBACK TO` undoes the work and
         leaves the savepoint on the stack; without the `RELEASE` the stack grows
         by one for every record that fails. */
      await tx.execute(`ROLLBACK TO ${RECORD}`)
      await tx.execute(`RELEASE ${RECORD}`)
      await quarantine(tx, batch, record, reasonOf(err))
      setAside.add(`${record.table}\u0000${record.rowId}`)
      quarantined += 1
    }
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

  return { applied, contested, ignoredColumns, ignoredTables, quarantined }
}

/**
 * Sets a record aside, with the reason and the record itself.
 *
 * Written after the `ROLLBACK TO`, so it belongs to the outer transaction and
 * survives the undo of the thing it describes. Migration 038 carries why it
 * keeps a payload where the changefeed refuses to: this is the only copy of that
 * row this database will ever hold, because the cursor is about to step past it.
 */
async function quarantine(
  tx: SqlDriver,
  batch: ChangeBatch,
  record: ChangeRecord,
  reason: string,
): Promise<void> {
  const at = clock.iso()
  const stored = JSON.stringify(record)
  await q(tx).insert(schema.syncQuarantine)
    .values({
      id: newId(),
      at,
      peerDevice: batch.fromDevice,
      tableName: record.table,
      rowId: record.rowId,
      op: record.op,
      reason,
      record: stored,
    })
    .onConflictDoUpdate({
      /* One entry per record. A row that fails again is the same complaint with
         a fresher date on it, not a second one — and `acknowledged` goes back to
         zero, because somebody having seen it last week is not the same as
         somebody having seen this. */
      target: [schema.syncQuarantine.tableName, schema.syncQuarantine.rowId],
      set: {
        at,
        peerDevice: batch.fromDevice,
        op: record.op,
        reason,
        record: stored,
        acknowledged: 0,
      },
    })
}

/**
 * Which foreign keys a table has, asked once per table per process.
 *
 * Cached on the driver rather than globally for `localColumns`' reason: a test
 * that opens two databases in one process must not be handed the other's shape.
 */
const keysOf = new WeakMap<SqlDriver, Map<string, Array<{ from: string; table: string }>>>()

async function foreignKeys(
  tx: SqlDriver, table: string,
): Promise<Array<{ from: string; table: string }>> {
  let tables = keysOf.get(tx)
  if (!tables) { tables = new Map(); keysOf.set(tx, tables) }

  const cached = tables.get(table)
  if (cached !== undefined) return cached

  /* raw: a PRAGMA, which a query builder has no words for. The name is
     `REPLICATED`'s and never the wire's -- see the note on `upsert`. */
  const rows = await tx.query<{ from: string; table: string }>(
    `PRAGMA foreign_key_list("${table}")`,
  )
  const keys = rows.map((r) => ({ from: r.from, table: r.table }))
  tables.set(table, keys)
  return keys
}

/** Why a record cannot land when what it points at did not, or null. */
async function parentSetAside(
  tx: SqlDriver,
  record: ChangeRecord,
  setAside: ReadonlySet<string>,
): Promise<string | null> {
  if (setAside.size === 0 || record.row === null) return null
  const shape = shapeOf(record.table)
  if (shape === undefined) return null

  for (const key of await foreignKeys(tx, shape.table)) {
    const value = record.row[key.from]
    if (typeof value !== 'string') continue
    if (setAside.has(`${key.table}\u0000${value}`)) {
      return `parent quarantined: ${key.table} ${value}`
    }
  }
  return null
}

/** What SQLite said, got back out as plainly as it can be. */
function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message !== '') return cause.message
    return err.message
  }
  return String(err)
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

/**
 * Where a record was originally written.
 *
 * The batch says which till sent it; the record does not say who wrote it, and
 * for a relayed row those are two different machines. Until the wire format
 * carries the true origin, the sender is the best answer available -- and it is
 * the one that matters, because it is the till this row must not be sent back
 * to. A relayed row is therefore attributed to the middle till, which sends it
 * one hop further than strictly necessary and then stops.
 */
function origin(_record: ChangeRecord, batch: ChangeBatch): string | null {
  return batch.fromDevice
}

/** Whether an incoming row says anything this database does not already hold. */
function same(theirs: Row, mine: Row): boolean {
  const keys = Object.keys(theirs)
  if (keys.length !== Object.keys(mine).length) return false
  return keys.every((k) => theirs[k] === mine[k])
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
  /**
   * How much that till has that this one has not seen, or null when it has
   * never said.
   *
   * Null and zero are different answers and a screen must not print them the
   * same way. Zero is "level, as of the last handshake"; null is "this till has
   * never been told", which is a peer on an older build or one never reached.
   *
   * Told apart by `head_said_at` rather than by the number being zero, and that
   * distinction cost a real bug: a peer whose feed has been pruned empty
   * reports a head of 0 quite correctly, so reading 0 as silence made a shop
   * that was completely caught up say it could not tell.
   */
  behind: number | null
  /** What kind of peer it is. See migration 044. */
  reach: string
  /**
   * How far that till's clock is from this one, signed: positive means theirs
   * is ahead. Zero is level, or a peer on a build too old to say.
   */
  clockSkewMs: number
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
      theirCursor: schema.syncPeers.theirCursor,
      theirHead: schema.syncPeers.theirHead,
      headSaidAt: schema.syncPeers.headSaidAt,
      reach: schema.syncPeers.reach,
      clockSkewMs: schema.syncPeers.clockSkewMs,
    })
    .from(schema.syncPeers)
    .orderBy(schema.syncPeers.createdAt)

  const out: PeerHealth[] = []
  for (const r of rows) {
    const { myCursor, theirCursor, theirHead, headSaidAt, ...peer } = r
    out.push({
      ...peer,
      waiting: await pendingCount(db, myCursor),
      /* Zero, not negative: a head from a handshake that has since been
         overtaken by rows this till pulled would otherwise read as owing
         somebody a negative number of bills. */
      behind: headSaidAt === null ? null : Math.max(0, theirHead - theirCursor),
    })
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
