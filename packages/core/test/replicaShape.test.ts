import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { REPLICATED, NOT_REPLICATED, shapeOf } from '../src/domain/replicaShape.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The list of what replicates, checked against what the database actually does.
 *
 * It exists in four places now — 021's feed triggers, 022's revision triggers,
 * `replicaShape.ts`, and whatever a merge applies. Four copies of one list is
 * four chances to add a table to three of them, and the failure that causes is
 * the quiet kind: a row that is fed and never applied, or a document that
 * arrives without its lines and is not obviously wrong until somebody totals it.
 *
 * So none of these assert against a list typed out again here. They ask the
 * schema.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function tablesInSchema(): Promise<string[]> {
  const rows = await fx.db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  )
  return rows.map((r) => r.name)
}

async function feedTriggerTargets(): Promise<Set<string>> {
  const rows = await fx.db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'feed_%'`,
  )
  return new Set(rows.map((r) => r.name.replace(/^feed_/, '').replace(/_(ins|upd|del)$/, '')))
}

describe('the shape agrees with the schema', () => {
  it('names a table that exists, for every record and every line', async () => {
    const present = new Set(await tablesInSchema())

    const missing: string[] = []
    for (const record of REPLICATED) {
      if (!present.has(record.table)) missing.push(record.table)
      for (const line of record.lines) {
        if (!present.has(line.table)) missing.push(line.table)
      }
    }
    expect(missing).toEqual([])
  })

  it('claims a key column that is really there', async () => {
    for (const record of REPLICATED) {
      const cols = await fx.db.query<{ name: string }>(`PRAGMA table_info("${record.table}")`)
      expect(cols.map((c) => c.name)).toContain(record.key)
    }
  })

  it('claims a parent column that is really there', async () => {
    for (const record of REPLICATED) {
      for (const line of record.lines) {
        const cols = await fx.db.query<{ name: string }>(`PRAGMA table_info("${line.table}")`)
        expect(cols.map((c) => c.name)).toContain(line.parentKey)
      }
    }
  })

  it('covers exactly what the feed triggers cover', async () => {
    /* If these two ever disagree, one of them is sending rows the other will not
       apply, or applying rows nothing ever sends. */
    const fed = await feedTriggerTargets()
    const declared = new Set<string>()
    for (const record of REPLICATED) {
      declared.add(record.table)
      for (const line of record.lines) declared.add(line.table)
    }

    expect([...fed].filter((t) => !declared.has(t)).sort()).toEqual([])
    expect([...declared].filter((t) => !fed.has(t)).sort()).toEqual([])
  })

  it('has an answer for every table in the schema, either way', async () => {
    const declared = new Set<string>()
    for (const record of REPLICATED) {
      declared.add(record.table)
      for (const line of record.lines) declared.add(line.table)
    }

    const unaccounted = (await tablesInSchema())
      .filter((t) => !declared.has(t) && NOT_REPLICATED[t] === undefined)

    // A table added without a decision fails here rather than going missing in
    // a shop. The fix is one line in replicaShape.ts, either way it goes.
    expect(unaccounted).toEqual([])
  })

  it('does not excuse a table that no longer exists', async () => {
    const present = new Set(await tablesInSchema())
    const stale = Object.keys(NOT_REPLICATED).filter((t) => !present.has(t))
    expect(stale).toEqual([])
  })
})

describe('lines belong to exactly one record', () => {
  it('never lets two records claim the same line table', () => {
    /* A line table claimed twice would be deleted and rewritten by whichever
       record was applied second, taking the other's lines with it. */
    const seen = new Map<string, string>()
    for (const record of REPLICATED) {
      for (const line of record.lines) {
        expect(seen.get(line.table) ?? record.table).toBe(record.table)
        seen.set(line.table, record.table)
      }
    }
  })

  it('never lists a line table as a record in its own right', () => {
    const records = new Set(REPLICATED.map((r) => r.table))
    for (const record of REPLICATED) {
      for (const line of record.lines) {
        expect(records.has(line.table)).toBe(false)
      }
    }
  })
})

describe('looking a table up', () => {
  it('finds a record by name', () => {
    expect(shapeOf('bills')?.key).toBe('id')
    expect(shapeOf('settings')?.key).toBe('key')
  })

  it('says nothing for a table that does not replicate', () => {
    expect(shapeOf('product_stock')).toBeUndefined()
    expect(shapeOf('audit_log')).toBeUndefined()
  })
})
