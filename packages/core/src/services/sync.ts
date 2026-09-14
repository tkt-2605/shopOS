import type { Row, SqlDriver, SqlValue } from '../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../db/schemaVersion.js'
import { deviceId } from '../device.js'
import { decideRow, decideDeletion } from '../domain/merge.js'
import {
  REPLICATED, shapeOf, type ChangeBatch, type ChangeRecord,
} from '../domain/replicaShape.js'
import { applyingRemote, changesSince, pruneFeed } from './changefeed.js'
import { getSetting } from './bootstrap.js'

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
    [new Date().toISOString(), hello.deviceId],
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
): Promise<SyncResult> {
  let last = await syncWith(db, transport)
  let done = 1

  while (last.ok && last.more && done < rounds) {
    const next = await syncWith(db, transport)
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

  return applyingRemote(db, async (tx) => {
    let applied = 0
    const contested: ContestedChange[] = []

    for (const record of batch.records) {
      const shape = shapeOf(record.table)
      if (shape === undefined) continue

      const mine = await tx.get<Row>(
        `SELECT * FROM "${shape.table}" WHERE "${shape.key}" = ?`, [record.rowId],
      )
      const both = changedHereToo.has(`${record.table} ${record.rowId}`)

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

    return { applied, contested }
  })
}

/** Which records have also changed here since the peer last read our feed. */
export async function changedHere(
  db: SqlDriver,
  cursor: number,
): Promise<ReadonlySet<string>> {
  const entries = await changesSince(db, cursor, 100_000)
  return new Set(entries.map((e) => `${e.table} ${e.rowId}`))
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
    [hello.deviceId, hello.label, new Date().toISOString()],
  )
  const row = await db.get<{ their_cursor: number; my_cursor: number }>(
    `SELECT their_cursor, my_cursor FROM sync_peers WHERE device_id = ?`,
    [hello.deviceId],
  )
  return { theirCursor: row?.their_cursor ?? 0, myCursor: row?.my_cursor ?? 0 }
}

/** Everyone this machine has agreed with, for the screen Phase 3 owes. */
export async function listPeers(db: SqlDriver): Promise<Array<{
  deviceId: string; label: string | null; lastAgreedAt: string | null
}>> {
  const rows = await db.query<{ device_id: string; label: string | null; last_agreed_at: string | null }>(
    `SELECT device_id, label, last_agreed_at FROM sync_peers ORDER BY created_at`,
  )
  return rows.map((r) => ({
    deviceId: r.device_id, label: r.label, lastAgreedAt: r.last_agreed_at,
  }))
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
