import type { Row, SqlDriver, SqlValue } from '../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
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
    }
  | { ok: false; code: 'SCHEMA_MISMATCH'; mine: number; theirs: number }
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

  /* Before a single row moves. Two tills on different builds is the sync bug
     that corrupts data rather than the one that annoys somebody: the newer one
     writes columns the older one has no place for, and the older one sends rows
     missing columns the newer one has made NOT NULL. `staleBuild()` already
     refuses to start an app against a database it is behind; this is the same
     refusal across the wire. */
  if (hello.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      mine: EXPECTED_SCHEMA_VERSION,
      theirs: hello.schemaVersion,
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

  const peer = await rememberPeer(db, hello)

  // ── pull ────────────────────────────────────────────────────────────────
  const incoming = await transport.fetch(peer.theirCursor, BATCH)
  const mineChanged = await changedHere(db, peer.myCursor)
  const { applied, contested } = await applyBatch(db, incoming, mineChanged)

  if (incoming.records.length > 0) {
    await db.execute(
      `UPDATE sync_peers SET their_cursor = ? WHERE device_id = ?`,
      [incoming.upTo, hello.deviceId],
    )
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
    await db.execute(
      `UPDATE sync_peers SET my_cursor = ? WHERE device_id = ?`,
      [ack.upTo, hello.deviceId],
    )
  }

  await db.execute(
    `UPDATE sync_peers SET last_agreed_at = ? WHERE device_id = ?`,
    [clock.iso(), hello.deviceId],
  )

  return {
    ok: true,
    peer: hello.deviceId,
    received: applied,
    sent,
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
export async function applyBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string> = new Set(),
): Promise<{ applied: number; contested: ContestedChange[] }> {
  if (batch.records.length === 0) return { applied: 0, contested: [] }

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

     Only when ledger rows actually arrived, because this replays the whole
     ledger — and after the merge rather than inside it, so a busy counter is not
     held behind a long transaction. A recompute that is missed is picked up by
     the next sync or by the Dashboard's drift check; a counter that stalls
     mid-sale is not recoverable in the same way. */
  if (outcome.applied > 0 && batch.records.some((r) => r.table === 'stock_ledger')) {
    await recomputeStock(db, { repair: true })
  }

  return outcome
}

async function mergeBatch(
  db: SqlDriver,
  batch: ChangeBatch,
  changedHereToo: ReadonlySet<string>,
): Promise<{ applied: number; contested: ContestedChange[] }> {
  return applyingRemote(db, async (tx) => {
    let applied = 0
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

      await upsert(tx, shape.table, shape.key, record.row)
      for (const line of shape.lines) {
        /* The winning side's document is the document. Merging lines one by one
           builds a bill neither till ever had — three items from here, two from
           there, and totals belonging to nobody. */
        await tx.execute(
          `DELETE FROM "${line.table}" WHERE "${line.parentKey}" = ?`, [record.rowId],
        )
        for (const row of record.lines?.[line.table] ?? []) {
          await insert(tx, line.table, row)
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
      await tx.execute(
        `INSERT INTO sync_conflicts
           (id, at, peer_device, table_name, row_id, winner, explain)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), clock.iso(), batch.fromDevice,
          complaint.table, complaint.rowId, complaint.winner, complaint.explain,
        ],
      )
    }

    return { applied, contested }
  })
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
  const rows = await db.query<{
    id: string; at: string; peer_device: string | null
    table_name: string; row_id: string; winner: 'mine' | 'theirs'; explain: string
  }>(
    `SELECT id, at, peer_device, table_name, row_id, winner, explain
       FROM sync_conflicts
      WHERE acknowledged = 0 OR ? = 0
      ORDER BY at DESC
      LIMIT ?`,
    [options.unreadOnly === false ? 0 : 1, options.limit ?? 50],
  )
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    peerDevice: r.peer_device,
    table: r.table_name,
    rowId: r.row_id,
    winner: r.winner,
    explain: r.explain,
  }))
}

/** Marks them read. Kept rather than deleted — what the tills disagreed about
 *  is worth having later, even once somebody has seen it. */
export async function acknowledgeConflicts(db: SqlDriver): Promise<number> {
  const result = await db.execute(
    `UPDATE sync_conflicts SET acknowledged = 1 WHERE acknowledged = 0`,
  )
  return result.rowsAffected
}

/** How many nobody has looked at. For a badge, and for the screen's headline. */
export async function unreadConflictCount(db: SqlDriver): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_conflicts WHERE acknowledged = 0`,
  )
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
  await db.execute(
    `UPDATE sync_peers SET last_error = ?, last_tried_at = ? WHERE device_id = ?`,
    [error, clock.iso(), peerDeviceId],
  )
}

/** Which records have also changed here since the peer last read our feed. */
export async function changedHere(
  db: SqlDriver,
  cursor: number,
): Promise<ReadonlySet<string>> {
  const entries = await changesSince(db, cursor, 100_000)
  return new Set(entries.map((e) => `${e.table}\u0000${e.rowId}`))
}

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

async function rememberPeer(
  db: SqlDriver,
  hello: PeerHello,
): Promise<{ theirCursor: number; myCursor: number }> {
  await db.execute(
    `INSERT INTO sync_peers (device_id, label, created_at) VALUES (?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET label = excluded.label`,
    [hello.deviceId, hello.label, clock.iso()],
  )
  const row = await db.get<{ their_cursor: number; my_cursor: number }>(
    `SELECT their_cursor, my_cursor FROM sync_peers WHERE device_id = ?`,
    [hello.deviceId],
  )
  return { theirCursor: row?.their_cursor ?? 0, myCursor: row?.my_cursor ?? 0 }
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
  const rows = await db.query<{
    device_id: string; label: string | null; last_agreed_at: string | null
    last_tried_at: string | null; last_error: string | null; my_cursor: number
  }>(
    `SELECT device_id, label, last_agreed_at, last_tried_at, last_error, my_cursor
       FROM sync_peers ORDER BY created_at`,
  )

  const out: PeerHealth[] = []
  for (const r of rows) {
    out.push({
      deviceId: r.device_id,
      label: r.label,
      lastAgreedAt: r.last_agreed_at,
      lastTriedAt: r.last_tried_at,
      lastError: r.last_error,
      waiting: await pendingCount(db, r.my_cursor),
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
  const row = await db.get<{ safe: number | null; peers: number }>(
    `SELECT MIN(my_cursor) AS safe, COUNT(*) AS peers FROM sync_peers`,
  )
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
