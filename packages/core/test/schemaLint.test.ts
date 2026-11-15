import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { applyingRemote } from '../src/services/changefeed.js'
import { newId } from '../src/ids.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * The schema held to the sqlite3 shell's own lint, on every run (087).
 *
 * `.lint fkey-indexes`: every foreign key has an index that leads with its
 * columns and is not partial -- the shell does not count a partial one. And no
 * index is a leading prefix of another on the same table, which the planner
 * never needs and every write pays for. The review of 13 Nov found 54 of the
 * first and 5 of the second; a migration that brings either back fails here,
 * naming what it added.
 */

let fx: Fixture
beforeAll(async () => { fx = await freshDb() })
afterAll(async () => { await fx.db.close() })

interface Ix { name: string; cols: string[]; partial: boolean }

async function indexesOf(table: string): Promise<Ix[]> {
  const list = await fx.db.query<{ name: string; partial: number }>(`SELECT name, partial FROM pragma_index_list(?)`, [table])
  const out: Ix[] = []
  for (const ix of list) {
    const cols = await fx.db.query<{ name: string }>(
      `SELECT name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno`, [ix.name])
    out.push({ name: ix.name, cols: cols.map((c) => c.name), partial: ix.partial === 1 })
  }
  const pk = await fx.db.query<{ name: string }>(`SELECT name FROM pragma_table_info(?) WHERE pk > 0`, [table])
  if (pk.length === 1) out.push({ name: '<rowid>', cols: [pk[0]!.name], partial: false })
  return out
}

async function tables(): Promise<string[]> {
  return (await fx.db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map((t) => t.name)
}

describe('the schema, by the sqlite3 shell lint', () => {
  it('has an index behind every foreign key', async () => {
    const missing: string[] = []
    for (const t of await tables()) {
      const fks = await fx.db.query<{ id: number; from: string }>(`SELECT id, "from" FROM pragma_foreign_key_list(?)`, [t])
      const byKey = new Map<number, string[]>()
      for (const f of fks) byKey.set(f.id, [...(byKey.get(f.id) ?? []), f.from])
      const ixs = await indexesOf(t)
      for (const cols of byKey.values()) {
        const covered = ixs.some((ix) => !ix.partial && ix.cols.length >= cols.length
          && cols.every((c) => ix.cols.slice(0, cols.length).includes(c)))
        if (!covered) missing.push(`${t}(${cols.join(', ')})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('has no index that another already covers', async () => {
    const redundant: string[] = []
    for (const t of await tables()) {
      const ixs = (await indexesOf(t)).filter((ix) => !ix.partial)
      for (const a of ixs) {
        if (a.name === '<rowid>') continue
        for (const b of ixs) {
          if (a !== b && a.cols.length < b.cols.length && a.cols.every((c, i) => b.cols[i] === c)) {
            redundant.push(`${t}: ${a.name} is a prefix of ${b.name}`)
          }
        }
      }
    }
    expect(redundant).toEqual([])
  })

  it('passes integrity_check and foreign_key_check', async () => {
    expect(await fx.db.query(`PRAGMA integrity_check`)).toEqual([{ integrity_check: 'ok' }])
    expect(await fx.db.query(`PRAGMA foreign_key_check`)).toEqual([])
  })
})

describe('a posting names a voucher the books know', () => {
  const post = (tx: Fixture['db'], voucherType: string) => tx.execute(
    `INSERT INTO gl_entries (id, posting_date, account, debit, credit, voucher_type, voucher_id, created_at)
     VALUES (?, '2026-11-15', 'cash', 100, 0, ?, ?, '2026-11-15T00:00:00Z')`, [newId(), voucherType, newId()])

  it('refuses a misspelt kind written here', async () => {
    await expect(post(fx.db, 'bil')).rejects.toThrow(/voucher the books know|kind of voucher/)
  })

  it('takes a known kind', async () => {
    await expect(post(fx.db, 'payment')).resolves.not.toThrow()
  })

  it('takes any kind arriving by sync, which a newer till may know and this one not', async () => {
    await expect(applyingRemote(fx.db, (tx) => post(tx, 'a_kind_from_a_newer_till'))).resolves.not.toThrow()
  })
})
