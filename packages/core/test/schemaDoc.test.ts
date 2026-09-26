import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openMemoryDatabase } from '../src/db/node-driver.js'
import { migrate } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { describeSchema, type SchemaDescription } from '../src/db/describe.js'
import { renderSchemaDoc } from '../src/db/schemaDoc.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { REPLICATED, NOT_REPLICATED } from '../src/domain/replicaShape.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * `docs/schema.md` is generated, and this is what stops it going stale.
 *
 * The file is the only complete statement of the schema anybody can read in a
 * review -- fifty migrations do not add up to a shape in a person's head --
 * and a generated document nobody regenerates is worse than none, because it
 * is believed. So the migrations are run here, the document is rendered again,
 * and the committed copy has to match it byte for byte.
 *
 * The same drift detector `migrations.test.ts` has for the migration list and
 * `replicaShape.test.ts` has for what sync carries.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const docPath = join(root, 'docs', 'schema.md')

let db: SqlDriver
let described: SchemaDescription

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  described = await describeSchema(db)
})

afterAll(async () => {
  await db.close()
})

describe('the generated schema document', () => {
  it('is committed', () => {
    expect(existsSync(docPath), `${docPath} is missing — run \`npm run schema:doc\``).toBe(true)
  })

  it('matches what the migrations produce', () => {
    const committed = readFileSync(docPath, 'utf8')
    const fresh = renderSchemaDoc(described)

    if (committed !== fresh) {
      /* The diff itself is 2,000 lines and unreadable in a test report, so say
         what changed at the level a person can act on and point at the command
         that fixes it. */
      const shape = (text: string) =>
        new Set((text.match(/^### `(.+)`$/gm) ?? []).map((line) => line.slice(5, -1)))
      const was = shape(committed)
      const now = shape(fresh)
      const added = [...now].filter((t) => !was.has(t))
      const gone = [...was].filter((t) => !now.has(t))

      const why = [
        added.length > 0 ? `tables added: ${added.join(', ')}` : null,
        gone.length > 0 ? `tables removed: ${gone.join(', ')}` : null,
        added.length === 0 && gone.length === 0 ? 'the same tables, changed inside' : null,
      ].filter((line): line is string => line !== null)

      expect.fail(
        `docs/schema.md has drifted from the migrations (${why.join('; ')}). ` +
        'Run `npm run schema:doc` and commit the result.',
      )
    }
  })
})

describe('what it describes', () => {
  it('reports the schema version the code expects', () => {
    expect(described.version).toBe(EXPECTED_SCHEMA_VERSION)
  })

  it('has a replication decision for every table', () => {
    const undecided = described.tables
      .filter((t) => t.replication.kind === 'undecided')
      .map((t) => t.name)
    expect(undecided, 'add these to REPLICATED or NOT_REPLICATED in replicaShape.ts').toEqual([])
  })

  it('describes every table replicaShape.ts names, and no ghosts', () => {
    // A name in replicaShape.ts that is not a table is the other direction of
    // the same drift: a decision about something that no longer exists.
    const inDb = new Set(described.tables.map((t) => t.name))
    const named = [
      ...REPLICATED.flatMap((r) => [r.table, ...r.lines.map((l) => l.table)]),
      ...Object.keys(NOT_REPLICATED),
    ]
    expect(named.filter((name) => !inDb.has(name))).toEqual([])
  })

  it('reads columns off the database rather than off schema.ts', async () => {
    // The point of describing the file instead of the hand-written shape: a
    // column added here shows up without schema.ts being touched.
    await db.execute('CREATE TABLE a_table_schema_ts_never_heard_of (id TEXT PRIMARY KEY)')
    const after = await describeSchema(db)
    const found = after.tables.find((t) => t.name === 'a_table_schema_ts_never_heard_of')

    expect(found).toBeDefined()
    expect(found?.columns.map((c) => c.name)).toEqual(['id'])
    expect(found?.replication).toEqual({ kind: 'undecided' })

    await db.execute('DROP TABLE a_table_schema_ts_never_heard_of')
  })

  it('leaves out SQLite\'s own bookkeeping', () => {
    const names = described.tables.map((t) => t.name)
    expect(names.filter((n) => n.startsWith('sqlite_'))).toEqual([])
    for (const table of described.tables) {
      expect(table.indexes.filter((i) => i.name.startsWith('sqlite_autoindex_'))).toEqual([])
    }
  })

  it('says a column is unique when a UNIQUE constraint makes it so', () => {
    /* SQLite backs a UNIQUE constraint with an index of its own, and the
       document used to skip those as bookkeeping -- so `bills.doc_no` read as
       a column that could repeat, and one comment in the code reasoned from
       that and was wrong. */
    const bills = described.tables.find((t) => t.name === 'bills')
    expect(bills?.indexes.some((i) => i.unique && i.columns.join() === 'doc_no')).toBe(true)
  })

  it('carries the partial indexes\' conditions, which is where the meaning is', () => {
    const bills = described.tables.find((t) => t.name === 'bills')
    const kindIndex = bills?.indexes.find((i) => i.name === 'idx_bills_kind')
    expect(kindIndex?.sql).toMatch(/WHERE/i)
  })

  it('says which rows of bills travel', () => {
    const bills = described.tables.find((t) => t.name === 'bills')
    expect(bills?.replication).toMatchObject({ kind: 'record', key: 'id' })
    // A draft is one till's unfinished work and does not belong on the other.
    expect(bills?.replication).toMatchObject({ travels: expect.stringContaining('docstatus') })
  })
})
