import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { MIGRATIONS } from '../src/db/migrations.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'

/**
 * An upgrade, run the way a shop runs it: over a database that already has
 * trade in it.
 *
 * Every other test in this suite starts from an empty file, which is the one
 * case a migration is never wrong about. What breaks a shop is the other case
 * — thirty-five statements applied in order over twenty thousand bills — and
 * the two failures that matter there are silent. A rebuilt table can come back
 * with rows missing, and a rebuilt table can come back with its foreign keys
 * pointing at nothing. Neither raises an error at the time. Both are found
 * weeks later by a shopkeeper whose report is short.
 *
 * So this asserts what a bad migration breaks and a green suite would not
 * notice: the file is still sound, nothing dangles, and no table lost rows.
 *
 * Two fixtures, and both are checked the same way:
 *
 *   - **The owner's own shop**, gitignored, absent on every machine but this
 *     one. `npm run pull-shop-db` makes it. A skip is not a pass and the phase
 *     checklist says so.
 *   - **Every migration on its own**, which always runs. Stepping one at a time
 *     and checking after each is what names the migration that did it, rather
 *     than reporting that something between 1 and 35 went wrong.
 *
 * The synthetic shop is checked in `tools/synthetic-shop/test/shape.test.ts`,
 * which builds it by running these same migrations and then asserts the same
 * two pragmas. It is not repeated here: that shop is built at head, so there is
 * no older version to replay it from.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', '..', 'tools', 'fixtures', 'real-shop.db')
const MIGRATIONS_DIR = join(here, '..', 'migrations')

const present = existsSync(FIXTURE)

function sound(db: Database.Database): void {
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(db.pragma('foreign_key_check')).toEqual([])
}

function apply(db: Database.Database, version: number, name: string): void {
  db.exec('BEGIN')
  db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
  db.exec(`PRAGMA user_version = ${version}`)
  db.exec('COMMIT')
}

/** Every table in the file, and how many rows are in it. */
function rowCounts(db: Database.Database): Map<string, number> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]

  const counts = new Map<string, number>()
  for (const { name } of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
    counts.set(name, row.n)
  }
  return counts
}

/**
 * Tables a migration is allowed to change the row count of, and why.
 *
 * An allow-list rather than a tolerance: "a few rows either way" is how a
 * rebuild that drops one row in a thousand gets through. Anything not named
 * here must come out of an upgrade with exactly the rows it went in with.
 */
const WRITTEN_BY_A_MIGRATION = new Map<string, string>([
  ['settings', '012 and 024 insert a key; 033 removes `schema_bootstrapped_at`'],
  ['role_pages', '009 and later grant pages to the seeded roles'],
  ['role_permissions', 'the same, for what a role may do'],
  ['change_feed', '021 creates it; its triggers fire on anything a later migration writes'],
  ['sync_state', '021 seeds the one row'],
  ['doc_sequences', '027 and 028 rewrite the scope keys, which changes how many there are'],
])

/* What the owner's own database actually moves, so the allow-list above cannot
   quietly grow to cover a table it was never meant to. Checked as well as the
   counts themselves: a list of exceptions nobody looks at is how the exception
   that mattered gets added. */
const MOVED_ON_THE_REAL_SHOP = ['doc_sequences', 'settings']

describe('replaying every migration, one at a time', () => {
  it('leaves the database sound after each one', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    for (const m of MIGRATIONS) {
      apply(db, m.version, m.name)
      /* Named per migration on purpose. "Something between 1 and 35 broke it"
         is a day's work; "015 broke it" is ten minutes. */
      expect(db.pragma('integrity_check', { simple: true }), `after ${m.name}`).toBe('ok')
      expect(db.pragma('foreign_key_check'), `after ${m.name}`).toEqual([])
    }

    expect(db.pragma('user_version', { simple: true })).toBe(EXPECTED_SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!present)('replaying them over a shop that has been trading', () => {
  it('arrives at head with nothing lost and nothing dangling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shopos-replay-'))
    const path = join(dir, 'shop.db')
    copyFileSync(FIXTURE, path)

    const db = new Database(path)
    db.pragma('foreign_keys = ON')

    const from = db.pragma('user_version', { simple: true }) as number
    /* A fixture already at head would make every assertion below vacuous and
       the test would go quietly green for ever. */
    expect(from).toBeLessThan(EXPECTED_SCHEMA_VERSION)

    const before = rowCounts(db)
    for (const m of MIGRATIONS) {
      if (m.version <= from) continue
      apply(db, m.version, m.name)
    }

    expect(db.pragma('user_version', { simple: true })).toBe(EXPECTED_SCHEMA_VERSION)
    sound(db)

    const after = rowCounts(db)
    for (const [table, was] of before) {
      // A table a migration dropped is not a table that lost rows. `030` took
      // two that nothing ever read.
      if (!after.has(table)) continue
      if (WRITTEN_BY_A_MIGRATION.has(table)) continue
      expect(after.get(table), `${table} lost or gained rows`).toBe(was)
    }

    const moved = [...before.keys()]
      .filter((t) => after.has(t) && after.get(t) !== before.get(t))
      .sort()
    expect(moved).toEqual(MOVED_ON_THE_REAL_SHOP)

    // And every table that was there is still there, unless something dropped
    // it on purpose.
    const dropped = [...before.keys()].filter((t) => !after.has(t))
    expect(dropped.sort()).toEqual(['activity_log', 'sync_queue'])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
