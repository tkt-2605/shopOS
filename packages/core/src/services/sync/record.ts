import type { Row, SqlDriver, SqlValue } from '../../db/driver.js'
import { deviceId } from '../../device.js'
import { decideRow, decideDeletion } from '../../domain/merge.js'
import { shapeOf, type ChangeBatch, type ChangeRecord } from '../../domain/replicaShape.js'
import { feedApplied } from '../changefeed.js'
import {
  refusedAsSubmitted, refusedLinesOfSubmitted, DOCUMENT_TABLES, SUBMITTED,
} from '../../integrity/docstatus.js'
import type { ContestedChange } from './types.js'

/*
 * One record against what is already here: decided, trimmed to the columns
 * this database has, and written if it wins.
 */

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
export async function applyRecord(
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
      && same(known(record.row, columns).row, mine, shape.incidental)) {
    return NOTHING
  }

  if (record.op === 'delete') {
    if (mine === undefined) return NOTHING
    /* Only a draft is ever deleted. A submitted document leaving because a
       peer's revision number happened to be as high as this one's would take a
       bill's stock and money with it; the rule is that submitted is immutable,
       and it is said here rather than left to the arithmetic of revisions. */
    if (DOCUMENT_TABLES.has(shape.table) && Number(mine['docstatus']) >= SUBMITTED) {
      return {
        ...NOTHING,
        contested: [{
          table: record.table, rowId: record.rowId, winner: 'mine',
          explain: 'a submitted document, which is never deleted -- it is cancelled',
        }],
      }
    }
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
      ?? await linesRefused(tx, shape, record, mine)
    if (refusal !== null) {
      return {
        ...NOTHING,
        contested: [{
          table: record.table, rowId: record.rowId, winner: 'mine', explain: refusal,
        }],
      }
    }
  }

  /* The record names its row twice -- once as `rowId`, once as the key inside
     the row -- and everything below trusts that they agree: the upsert writes
     the row's key, the feed and the line rewrite use `rowId`. A record where
     they differ would write one row and rewrite another's lines. Thrown, so the
     one-by-one pass quarantines this record and nothing else. */
  if (String(record.row[shape.key]) !== record.rowId) {
    throw new Error(`${shape.table} record ${record.rowId} carries the key ${String(record.row[shape.key])}`)
  }
  for (const line of shape.lines) {
    for (const row of record.lines?.[line.table] ?? []) {
      if (String(row[line.parentKey]) !== record.rowId) {
        throw new Error(`${line.table} line under ${record.rowId} belongs to ${String(row[line.parentKey])}`)
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

/**
 * `refusedLinesOfSubmitted` against the lines held here. Only read for a
 * document already submitted here, which is the only case it can refuse.
 */
async function linesRefused(
  tx: SqlDriver,
  shape: NonNullable<ReturnType<typeof shapeOf>>,
  record: ChangeRecord,
  mine: Row,
): Promise<string | null> {
  if (!DOCUMENT_TABLES.has(shape.table) || Number(mine['docstatus']) < SUBMITTED) return null
  if (record.lines === undefined || shape.lines.length === 0) return null
  const held: Record<string, Row[]> = {}
  for (const line of shape.lines) {
    /* raw: `REPLICATED`'s names again. See the note on `upsert`. */
    held[line.table] = await tx.query<Row>(
      `SELECT * FROM "${line.table}" WHERE "${line.parentKey}" = ?`, [record.rowId],
    )
  }
  return refusedLinesOfSubmitted(shape.table, mine, held, record.lines)
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

/**
 * Whether an incoming row says anything this database does not already hold.
 * `incidental` columns are left out of it: see `RecordShape.incidental`.
 */
function same(theirs: Row, mine: Row, incidental: readonly string[] = []): boolean {
  const keys = Object.keys(theirs)
  if (keys.length !== Object.keys(mine).length) return false
  return keys.every((k) => theirs[k] === mine[k] || incidental.includes(k))
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

function numberOf(v: SqlValue | undefined): number | null {
  return typeof v === 'number' ? v : null
}

function textOf(v: SqlValue | undefined): string | null {
  return typeof v === 'string' ? v : null
}
