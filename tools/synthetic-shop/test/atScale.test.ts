import { describe, it, expect, beforeAll } from 'vitest'
import { openMemoryDatabase } from '@shopos/core/node'
import {
  migrate, searchCustomers, countCustomers, totalOutstandingAll, recomputeStock,
  applyBatch, newId, MERGE_BUDGET_MS,
  type ChangeBatch, type ChangeRecord, type Row, type SqlDriver, type SqlValue,
} from '@shopos/core'
import { EXPECTED_SCHEMA_VERSION } from '../../../packages/core/src/db/schemaVersion.js'
import { MIGRATIONS } from '@shopos/core/migrations'
import { buildSyntheticShop, type SyntheticShop } from '../src/build.js'

/**
 * The Phase 3 checks that only exist at size.
 *
 * Each of these is a line on the phase's verification list that reads "on the
 * synthetic 20,000-bill shop" or "on a shop with 600 customers". They are here
 * rather than in `packages/core/test` because building the shop takes a couple
 * of seconds and the core suite should stay instant; the *meanings* are tested
 * there, on nine rows, where a failure says which rule broke.
 */

let db: SqlDriver
let shop: SyntheticShop

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  shop = await buildSyntheticShop(db)
}, 120_000)

describe('what the shop is owed, on a shop with six hundred customers', () => {
  it('is the whole book and not the page of it the screen holds', async () => {
    const book = await totalOutstandingAll(db)
    expect(book.total).toBe(shop.outstanding)
    expect(await countCustomers(db)).toBe(600)
  })

  it('is more than the old arithmetic could see', async () => {
    /* What the Credit page did until now: load five hundred customers ordered
       by name, keep the ones who owe, add those up. On six hundred customers
       the hundred at the back of the alphabet are not loaded at all, so their
       debt is not in the figure and nothing on the screen says a hundred
       customers were left out.

       This is the bug, reproduced, so the fix has something to be a fix of. */
    const loaded = await searchCustomers(db, '', 500)
    const asShown = loaded.reduce((sum, c) => (c.outstanding > 0 ? sum + c.outstanding : sum), 0)

    const book = await totalOutstandingAll(db)
    expect(asShown).toBeLessThan(book.total)
    expect(book.total - asShown).toBeGreaterThan(0)

    // And it was short by real money, not by a rounding difference.
    expect(book.total - asShown).toBeGreaterThan(100_00)
  })

  it('counts the customers who owe, not the rows that fitted', async () => {
    const book = await totalOutstandingAll(db)
    const loadedAndOwing = (await searchCustomers(db, '', 500)).filter((c) => c.outstanding > 0).length
    expect(book.customers).toBeGreaterThan(loadedAndOwing)
  })

  it('names the same worst customer the whole book would', async () => {
    const book = await totalOutstandingAll(db)
    const everyone = await searchCustomers(db, '', 10_000)
    const worst = everyone.reduce((w, c) => (c.outstanding > w.outstanding ? c : w), everyone[0]!)

    expect(book.worst).not.toBeNull()
    expect(book.worst!.id).toBe(worst.id)
    expect(book.worst!.outstanding).toBe(worst.outstanding)
  })

  it('answers in two passes rather than six hundred', async () => {
    /* A budget, not a benchmark. The point is the shape of the query, and the
       shape that would fail this is the obvious one: a correlated subquery per
       customer, re-reading twenty thousand bills for every name on the list.
       Generous enough not to go red on a loaded CI box. */
    const started = Date.now()
    await totalOutstandingAll(db)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})


/**
 * How many rows a call actually read.
 *
 * A timing assertion on a loaded CI box is a coin toss, and the thing being
 * claimed here is not "fast" but "does not read the whole ledger". Rows
 * returned is what that means, it is deterministic, and it is what would change
 * if somebody quietly dropped the scope again.
 */
function counting(db: SqlDriver): { driver: SqlDriver; rows: () => number } {
  let read = 0
  const driver: SqlDriver = {
    query: async <T = Row>(sql: string, params: SqlValue[] = []) => {
      const rows = await db.query<T>(sql, params)
      read += rows.length
      return rows
    },
    get: (sql, params) => db.get(sql, params),
    queryValues: async (sql, params) => {
      const rows = await db.queryValues(sql, params)
      read += rows.length
      return rows
    },
    execute: (sql, params) => db.execute(sql, params),
    transaction: (fn) => fn(driver),
    close: () => Promise.resolve(),
  }
  return { driver, rows: () => read }
}

describe('replaying the stock ledger, on forty-seven thousand movements', () => {
  it('reads the whole ledger when asked about the whole shop', async () => {
    const { driver, rows } = counting(db)
    await recomputeStock(driver)
    expect(rows()).toBeGreaterThan(shop.ledgerRows)
  })

  it('reads a hundredth of it when asked about one product', async () => {
    /* The Dashboard used to pay the first of these on every mount, and a sync
       round that carried one row for one item paid it again. */
    const { driver, rows } = counting(db)
    await recomputeStock(driver, { productIds: [shop.productIds[3]!] })

    expect(rows()).toBeGreaterThan(0)
    expect(rows()).toBeLessThan(shop.ledgerRows / 100)
  })

  it('finishes a merge carrying one ledger row without walking the shop', async () => {
    /* The phase's own verification: "a sync round carrying one ledger row
       replays one product". Counted rather than timed, and counted through
       `applyBatch` rather than through `recomputeStock`, so it is the merge's
       own decision being tested and not mine about what it should pass. */
    const product = shop.productIds[7]!
    const batch: ChangeBatch = {
      fromDevice: '2222bbbb-2222-4222-8222-222222222222',
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      records: [{
        table: 'stock_ledger',
        rowId: newId(),
        op: 'upsert',
        row: {
          id: newId(), product_id: product, posting_date: '2026-09-15',
          qty_change: -10_000, unit_cost: 1000, balance_qty: 0,
          voucher_type: 'bill', voucher_id: newId(), created_by: null,
          created_at: '2026-09-15T10:00:00.000Z',
        },
      }],
      upTo: 1,
      complete: true,
    }

    const { driver, rows } = counting(db)
    const outcome = await applyBatch(driver, batch)
    expect(outcome.applied).toBe(1)
    expect(rows()).toBeLessThan(shop.ledgerRows / 100)
  })
})


describe('a merge of five hundred changes', () => {
  it('finishes well inside the ninety seconds it asks to be allowed', async () => {
    /* The phase's verification line. The watchdog is Rust's and is tested
     * there, against a transaction whose start time is moved rather than one
     * that is waited out; what cannot be tested there is whether five hundred
     * real changes against a real shop are anywhere near ninety seconds.
     *
     * Five hundred bills with their lines, sent as if from the other till with
     * a higher `rev` so every one of them is applied rather than skipped. That
     * is the heaviest ordinary batch there is: `collectChanges` caps a round,
     * and a bill carries four line tables behind it.
     *
     * A quarter of the budget is the threshold rather than all of it. Passing
     * at eighty-nine seconds would tell nobody anything useful, and a merge
     * that has crept to a quarter of its allowance on a fixture this size is
     * already worth looking at. */
    const bills = await db.query<Row>(
      `SELECT * FROM bills WHERE docstatus = 1 ORDER BY posting_date LIMIT 500`,
    )
    expect(bills).toHaveLength(500)

    const records: ChangeRecord[] = []
    for (const bill of bills) {
      const id = bill['id'] as string
      const items = await db.query<Row>(`SELECT * FROM bill_items WHERE bill_id = ?`, [id])
      records.push({
        table: 'bills',
        rowId: id,
        op: 'upsert',
        // Newer than this copy, so the merge decides for the incoming side and
        // actually writes. A batch that loses every row would measure nothing.
        row: { ...bill, rev: (bill['rev'] as number) + 1, updated_at: '2026-09-16T10:00:00.000Z' },
        lines: { bill_items: items },
      })
    }

    const batch: ChangeBatch = {
      fromDevice: '2222bbbb-2222-4222-8222-222222222222',
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      records,
      upTo: records.length,
      complete: true,
    }

    const started = Date.now()
    const outcome = await applyBatch(db, batch)
    const took = Date.now() - started

    expect(outcome.applied).toBe(500)
    expect(took).toBeLessThan(MERGE_BUDGET_MS / 4)
  }, 120_000)
})
