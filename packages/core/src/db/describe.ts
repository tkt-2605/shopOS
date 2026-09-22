import type { SqlDriver } from './driver.js'
import { REPLICATED, NOT_REPLICATED } from '../domain/replicaShape.js'

/**
 * What the database actually looks like, read out of the database.
 *
 * `schema.ts` is the shape by hand and `schemaParity.test.ts` holds it to
 * account, but neither answers the question a person asks -- *what is in
 * here?* Forty-five tables spread over fifty migration files cannot be read
 * as a list of diffs, and the only complete statement of the schema today is
 * a `.db` file nobody can open in a review.
 *
 * So this walks SQLite's own catalogue on a freshly migrated database and
 * returns the whole shape as data. `schemaDoc.ts` renders it as the document
 * committed at `docs/schema.md`; `schemaDoc.test.ts` regenerates it and fails
 * when the committed copy has drifted, which is the same drift detector the
 * migration list and the replica shape already have.
 *
 * Reading the catalogue rather than `schema.ts` is deliberate. A generator fed
 * from the hand-written file would only ever restate what somebody typed --
 * including the typo. The pragmas answer for the file a shop will actually
 * open.
 */

export interface ColumnShape {
  name: string
  type: string
  notNull: boolean
  default: string | null
  /** Position in the primary key, 1-based. Zero means it is not part of one. */
  pk: number
}

export interface ForeignKeyShape {
  from: string
  table: string
  to: string | null
  onDelete: string
  onUpdate: string
}

export interface IndexShape {
  name: string
  unique: boolean
  /** Null for an index SQLite created itself for a UNIQUE constraint. */
  sql: string | null
  columns: string[]
}

/** How sync treats a table -- the third column of every row in the document. */
export type ReplicationRole =
  /** Travels as itself; the merge rule compares these rows. */
  | { kind: 'record'; key: string; travels: string | null }
  /** Travels only inside its parent document, never on its own. */
  | { kind: 'lines'; parent: string; parentKey: string }
  /** Stays on the till that wrote it, with the reason from `replicaShape.ts`. */
  | { kind: 'local'; why: string }
  /** In the database and in neither list -- which `replicaShape.test.ts` fails on. */
  | { kind: 'undecided' }

export interface TableShape {
  name: string
  sql: string
  columns: ColumnShape[]
  foreignKeys: ForeignKeyShape[]
  indexes: IndexShape[]
  triggers: string[]
  replication: ReplicationRole
}

export interface SchemaDescription {
  version: number
  tables: TableShape[]
  views: { name: string; sql: string }[]
}

interface MasterRow {
  name: string
  type: string
  tbl_name: string
  sql: string | null
}

interface ColumnRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
}

interface IndexRow {
  name: string
  unique: number
  origin: string
}

interface IndexColumnRow {
  seqno: number
  name: string | null
}

/**
 * Every table's shape, in the order SQLite stores them, minus its own
 * bookkeeping. `sqlite_sequence` and the `sqlite_autoindex_*` entries are
 * artefacts of AUTOINCREMENT and UNIQUE rather than anything a migration
 * wrote, and putting them in the document would invite somebody to migrate
 * one.
 */
export async function describeSchema(db: SqlDriver): Promise<SchemaDescription> {
  const versionRow = await db.get<{ user_version: number }>('PRAGMA user_version')
  const version = versionRow?.user_version ?? 0

  const objects = await db.query<MasterRow>(
    `SELECT name, type, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  )

  const roles = replicationRoles()
  const tables: TableShape[] = []

  for (const object of objects.filter((o) => o.type === 'table')) {
    tables.push({
      name: object.name,
      sql: (object.sql ?? '').trim(),
      columns: await columnsOf(db, object.name),
      foreignKeys: await foreignKeysOf(db, object.name),
      indexes: await indexesOf(db, object.name, objects),
      triggers: objects
        .filter((o) => o.type === 'trigger' && o.tbl_name === object.name)
        .map((o) => o.name),
      replication: roles.get(object.name) ?? { kind: 'undecided' },
    })
  }

  tables.sort((a, b) => a.name.localeCompare(b.name))

  return {
    version,
    tables,
    views: objects
      .filter((o) => o.type === 'view')
      .map((o) => ({ name: o.name, sql: (o.sql ?? '').trim() })),
  }
}

async function columnsOf(db: SqlDriver, table: string): Promise<ColumnShape[]> {
  const rows = await db.query<ColumnRow>(`PRAGMA table_info(${quote(table)})`)
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    notNull: row.notnull === 1,
    default: row.dflt_value,
    pk: row.pk,
  }))
}

async function foreignKeysOf(db: SqlDriver, table: string): Promise<ForeignKeyShape[]> {
  const rows = await db.query<ForeignKeyRow>(`PRAGMA foreign_key_list(${quote(table)})`)
  return rows
    .slice()
    .sort((a, b) => a.id - b.id || a.seq - b.seq)
    .map((row) => ({
      from: row.from,
      table: row.table,
      to: row.to,
      onDelete: row.on_delete,
      onUpdate: row.on_update,
    }))
}

async function indexesOf(
  db: SqlDriver, table: string, objects: MasterRow[],
): Promise<IndexShape[]> {
  const rows = await db.query<IndexRow>(`PRAGMA index_list(${quote(table)})`)
  const out: IndexShape[] = []

  for (const row of rows) {
    if (row.name.startsWith('sqlite_autoindex_')) continue
    const columns = await db.query<IndexColumnRow>(`PRAGMA index_info(${quote(row.name)})`)
    out.push({
      name: row.name,
      unique: row.unique === 1,
      sql: objects.find((o) => o.type === 'index' && o.name === row.name)?.sql ?? null,
      // A null name is an expression rather than a column; say so rather than drop it.
      columns: columns
        .slice()
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? '(expression)'),
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * The replication decision for every table `replicaShape.ts` has one for.
 *
 * Built from that file rather than restated here, so the document cannot
 * disagree with what sync actually does. A table in the database and in
 * neither list comes out `undecided`, which is the honest answer and is
 * already a failing test elsewhere.
 */
function replicationRoles(): Map<string, ReplicationRole> {
  const roles = new Map<string, ReplicationRole>()

  for (const shape of REPLICATED) {
    roles.set(shape.table, {
      kind: 'record',
      key: shape.key,
      travels: shape.travels ?? null,
    })
    for (const line of shape.lines) {
      roles.set(line.table, {
        kind: 'lines',
        parent: shape.table,
        parentKey: line.parentKey,
      })
    }
  }

  for (const [table, why] of Object.entries(NOT_REPLICATED)) {
    roles.set(table, { kind: 'local', why })
  }

  return roles
}

/** A table name inside a PRAGMA, which takes an identifier and not a parameter. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
