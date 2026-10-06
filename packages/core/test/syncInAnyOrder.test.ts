import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { REPLICATED } from '../src/domain/replicaShape.js'
import { pruneFeed, feedHead } from '../src/services/changefeed.js'
import { ledgerChecks } from '../src/repos/ledger.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, emptyDb, type Fixture } from './helpers.js'
import { TILL_A, TILL_B, as, pull, type Till } from './twoTills.js'
import { aMonthOfTrade } from './monthOfTrade.js'

/**
 * A month of trade reaching a second till, whatever order it arrives in.
 *
 * The sync tests used to send a shop the way it was written: a document, then
 * its stock movements, then its entries, in one batch. A real second till
 * gets it in batches of two hundred, and a till joining a shop after the feed
 * was pruned gets it table by table -- every bill before any stock movement.
 * Both orders broke the books in 0.2.1 (`syncLedger.test.ts`) and no test had
 * sent a shop in either. So this sends every kind of document the books post,
 * a few records at a time, both as it happens and to a till that joins
 * afterwards, and asks the second till to end up the same as the first.
 */

let fx: Fixture
let a: Till
let b: Till

beforeEach(async () => {
  fx = await freshDb()
  a = { id: TILL_A, db: fx.db }
  b = { id: TILL_B, db: await emptyDb() }
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

/** Every replicated table and line table, as rows a test can compare. */
async function everything(t: Till): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const shape of REPLICATED) {
    // raw: tables named by `REPLICATED`, as the sync itself reads them.
    out[shape.table] = await t.db.query(`SELECT * FROM "${shape.table}" ORDER BY "${shape.key}"`)
    for (const line of shape.lines) {
      out[line.table] = await t.db.query(`SELECT * FROM "${line.table}" ORDER BY rowid`)
    }
  }
  out['product_stock'] = await t.db.query(`SELECT * FROM product_stock ORDER BY product_id`)
  return out
}

/**
 * Rows each till writes for itself, where only when it wrote them differs:
 * the defaults every till's migrations seed (the same values, each stamped
 * with its own install), and the stock cache each till works out for itself.
 */
const STAMPED_HERE: Readonly<Record<string, readonly string[]>> = {
  settings: ['updated_at'],
  doc_formats: ['created_at', 'updated_at'],
  product_stock: ['updated_at'],
}

/** Comparable rows: in no particular order (a merge rewrites lines), less `STAMPED_HERE`. */
function sortedLines(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  const sorted: Record<string, unknown[]> = {}
  for (const [table, list] of Object.entries(rows)) {
    const skip = STAMPED_HERE[table] ?? []
    sorted[table] = list
      .map((r) => JSON.stringify(Object.fromEntries(
        Object.entries(r as Record<string, unknown>).filter(([k]) => !skip.includes(k)))))
      .sort()
  }
  return sorted
}

async function expectTheSameShop() {
  expect(await a.db.query(`SELECT table_name, row_id, reason FROM sync_quarantine`)).toEqual([])
  expect(await b.db.query(`SELECT table_name, row_id, reason FROM sync_quarantine`)).toEqual([])
  expect(await a.db.query(`SELECT table_name, row_id, explain FROM sync_conflicts`)).toEqual([])
  expect(await b.db.query(`SELECT table_name, row_id, explain FROM sync_conflicts`)).toEqual([])

  const checks = await ledgerChecks(b.db)
  expect(checks.unbalanced).toEqual([])
  expect(checks.stockDrift).toBe(0)

  const mine = sortedLines(await everything(a))
  const theirs = sortedLines(await everything(b))
  for (const table of Object.keys(mine)) expect(theirs[table], table).toEqual(mine[table])
}

describe.each([1, 3, 7, 200])('a month crossing %i records at a time', (limit) => {
  it('as it happens, the second till syncing after every document', async () => {
    await pull(b, a, limit)
    await as(TILL_A, () => aMonthOfTrade(fx, () => pull(b, a, limit).then(() => {})))
    await pull(b, a, limit)
    await expectTheSameShop()
  })

  it('to a till that joins after the feed was pruned', async () => {
    await as(TILL_A, () => aMonthOfTrade(fx))
    await as(TILL_A, async () => { await pruneFeed(a.db, await feedHead(a.db)) })
    await pull(b, a, limit)
    await expectTheSameShop()
  })
})
