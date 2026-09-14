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

describe('the order records are applied in', () => {
  /* Applying a batch in the order it arrives means a `users` row landing before
     the `roles` row it points at fails on a foreign key — and the whole batch is
     one transaction, so one such row fails the entire sync, the same way, every
     time. That is what happened the first time two real tills were pointed at
     each other, and the in-process tests had missed it because they synced twice
     and the second round picked up what the first had dropped. */

  async function dependencies(table: string): Promise<string[]> {
    const rows = await fx.db.query<{ table: string }>(`PRAGMA foreign_key_list("${table}")`)
    return rows.map((r) => r.table).filter((t) => t !== table)
  }

  it('puts every table after the tables it points at', async () => {
    const position = new Map(REPLICATED.map((r, i) => [r.table, i]))
    const wrong: string[] = []

    for (const record of REPLICATED) {
      for (const parent of await dependencies(record.table)) {
        const mine = position.get(record.table)!
        const theirs = position.get(parent)
        if (theirs !== undefined && theirs > mine) {
          wrong.push(`${record.table} is applied before ${parent}, which it points at`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  /**
   * The one dependency no ordering can satisfy, kept here by name.
   *
   * `loyalty_redemptions` is a line of a bill and points at `loyalty_entries`,
   * which points back at `bills`. That is a genuine cycle in the schema, not a
   * list in the wrong order, and it is why `applyBatch` turns on
   * `defer_foreign_keys` — the check still happens, once, at the end, when the
   * batch is whole.
   *
   * Written down rather than allowed for in general, so that a *new* cycle fails
   * this test instead of being silently covered by the deferral.
   */
  const KNOWN_CYCLE = ['loyalty_redemptions needs loyalty_entries, applied after bills']

  it('puts a line table after the record that owns it, bar one real cycle', async () => {
    const position = new Map(REPLICATED.map((r, i) => [r.table, i]))
    const wrong: string[] = []

    for (const record of REPLICATED) {
      for (const line of record.lines) {
        for (const parent of await dependencies(line.table)) {
          const theirs = position.get(parent)
          if (theirs !== undefined && theirs > position.get(record.table)!) {
            wrong.push(`${line.table} needs ${parent}, applied after ${record.table}`)
          }
        }
      }
    }
    expect(wrong).toEqual(KNOWN_CYCLE)
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
