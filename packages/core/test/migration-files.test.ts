import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MIGRATIONS } from '../src/db/migrations.js'
import { MIGRATION_FILES, MIN_PEER_SCHEMA_VERSION, REVIEWED_DEFAULTS } from '../src/db/migrationKinds.js'
import { REPLICATED } from '../src/domain/replicaShape.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * The previous system drifted because adding a migration file and registering it
 * were two steps. Both loaders now derive from the directory; this asserts the
 * directory and the registered list still agree.
 */
describe('migration files', () => {
  it('registers every .sql file in the migrations folder', () => {
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(MIGRATIONS.map((m) => m.name).sort()).toEqual(onDisk)
  })

  it('takes each version from the filename, contiguous from 1', () => {
    MIGRATIONS.forEach((m, i) => {
      expect(m.version).toBe(i + 1)
      expect(m.name.startsWith(String(m.version).padStart(3, '0'))).toBe(true)
    })
  })

  it('loads each file with content in it', () => {
    for (const m of MIGRATIONS) expect(m.sql.trim().length).toBeGreaterThan(0)
  })
})

/**
 * The classification, and the floor it produces.
 *
 * `MIGRATION_FILES` decides which tills in a shop can talk to each other, so
 * the list has to stay in step with the folder in both directions and the
 * reasoning has to stay checkable. Reading the .sql back and looking for the
 * operations is not a substitute for judgement -- it is what stops a migration
 * being classified once, by hand, and then quietly edited.
 */
describe('what each migration does to a peer', () => {
  it('classifies every file, and only files that exist', () => {
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(MIGRATION_FILES.map(([, file]) => file).sort()).toEqual(onDisk)
  })

  it('puts the floor at the last breaking migration', () => {
    const lastBreaking = [...MIGRATION_FILES].reverse()
      .find(([, , kind]) => kind === 'breaking')

    expect(lastBreaking).toBeDefined()
    expect(MIN_PEER_SCHEMA_VERSION).toBe(lastBreaking![0])
    // Everything above the floor is additive, which is what it means.
    for (const [version, file, kind] of MIGRATION_FILES) {
      if (version > MIN_PEER_SCHEMA_VERSION) {
        expect(kind, `${file} is above the floor`).toBe('additive')
      }
    }
  })

  it('never lets the floor exceed the schema this build is on', () => {
    /* A floor above head would refuse every peer including an identical one,
       which is a shop that cannot sync with itself. It happened once, when
       the floor was one past the last breaking migration and head was
       breaking; this is what said so. */
    expect(MIN_PEER_SCHEMA_VERSION).toBeLessThanOrEqual(EXPECTED_SCHEMA_VERSION)
  })

  it('calls a migration breaking whenever its SQL drops or renames anything', () => {
    /* The direction that matters. A migration marked additive that drops a
       column lets two tills corrupt each other quietly; one marked breaking
       that did not need to be only refuses a sync somebody can fix by updating
       the other till. So this checks one way and not the other, and `030` --
       breaking although what it drops is not replicated -- stays legal. */
    for (const [version, file, kind] of MIGRATION_FILES) {
      const sql = readFileSync(join(dir, file), 'utf8')
        .replace(/--[^\n]*/g, '')
        .toUpperCase()
      const destructive = /\b(DROP\s+(TABLE|COLUMN)|RENAME\s+TO|RENAME\s+COLUMN)\b/.test(sql)
      if (destructive) {
        expect(kind, `${version} ${file} drops or renames something`).toBe('breaking')
      }
    }
  })

  it('makes an additive migration justify every defaulted column on a replicated table', () => {
    /* 035 and 050 were both called additive for adding a column with a
       default, and both defaults were a wrong figure on a row an older till
       relayed. This asks the question for every one above the floor. */
    const replicated = new Set(REPLICATED.flatMap((r) => [r.table, ...r.lines.map((l) => l.table)]))
    const unexplained: string[] = []
    for (const [version, file, kind] of MIGRATION_FILES) {
      if (kind !== 'additive' || version < MIN_PEER_SCHEMA_VERSION) continue
      const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '')
      const adds = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+(?:COLUMN\s+)?"?(\w+)"?([^;]*);/gi
      for (const [, table, column, rest] of sql.matchAll(adds)) {
        if (!replicated.has(table!) || !/\b(DEFAULT|NOT\s+NULL)\b/i.test(rest!)) continue
        const key = `${file}:${table}.${column}`
        if (!(key in REVIEWED_DEFAULTS)) unexplained.push(key)
      }
    }
    expect(unexplained).toEqual([])
  })
})
