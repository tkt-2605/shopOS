import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MIGRATIONS } from '../src/db/migrations.js'

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
