import { describe, it, expect, beforeAll } from 'vitest'
import { openMemoryDatabase } from '@shopos/core/node'
import {
  migrate, listBills, countBills, productValuation,
  type SqlDriver, type SqlValue, type Row,
} from '@shopos/core'
import { MIGRATIONS } from '@shopos/core/migrations'
import { listAuditEntries, auditActors } from '../../../packages/core/src/repos/audit.js'
import { buildSyntheticShop, type SyntheticShop } from '../src/build.js'

/**
 * The query plans migration 034 exists to produce.
 *
 * A plan test is only worth writing if it explains the query the app actually
 * runs, and a plan test that carries its own copy of the SQL stops doing that
 * the first time somebody edits the repo. So nothing here is written twice:
 * the repo function is called against a driver that writes down what it was
 * asked, and *that* string is what gets explained.
 *
 * What this catches is the slow, quiet kind of regression — an index dropped in
 * a later migration, or an `ORDER BY` given one more term, either of which
 * leaves every test green and the Bills page fifty times slower on a shop with
 * a year behind it. Nothing else in the suite would notice.
 */

let db: SqlDriver
let shop: SyntheticShop

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  shop = await buildSyntheticShop(db)
}, 120_000)

/* No `ANALYZE` here, deliberately.
 *
 * ShopOS has never run it and keeps no `sqlite_stat1`, so the planner works
 * from fixed guesses about how selective a column is. A plan test that first
 * gave the planner statistics the app does not have would be testing a
 * different database from the one in the shop -- and could pass while the real
 * thing chose a scan. Every plan asserted below was checked both ways and is
 * the same either way. */

/** What the repo asked for, rather than what a test thinks it asked for. */
interface Asked { sql: string; params: SqlValue[] }

function watching(): { driver: SqlDriver; asked: Asked[] } {
  const asked: Asked[] = []
  const driver: SqlDriver = {
    query: <T = Row>(sql: string, params: SqlValue[] = []) => {
      asked.push({ sql, params })
      return db.query<T>(sql, params)
    },
    get: <T = Row>(sql: string, params: SqlValue[] = []) => {
      asked.push({ sql, params })
      return db.get<T>(sql, params)
    },
    /* Recorded like the other two. A query that Drizzle sends is still a
       statement this repo issued, and a plan test that could not see it would
       go quietly blind the day a service moves onto typed queries. */
    queryValues: (sql: string, params: SqlValue[] = []) => {
      asked.push({ sql, params })
      return db.queryValues(sql, params)
    },
    execute: (sql, params) => db.execute(sql, params),
    transaction: (fn) => fn(driver),
    close: () => Promise.resolve(),
  }
  return { driver, asked }
}

/**
 * A statement against the table it reads, however the table is spelled.
 *
 * Hand-written SQL says `FROM stock_ledger`; a typed query says
 * `from "stock_ledger"`, lower case and quoted. The matcher has to see both, or
 * this file goes red the day a service is rewritten and says only "no statement
 * matching" -- which is a test failing for a reason that has nothing to do with
 * what it is checking.
 */
function reads(table: string): RegExp {
  return new RegExp(String.raw`from\s+"?${table}"?`, 'i')
}

/** The plan for the heaviest statement a call made, as one line. */
async function planOf(run: (driver: SqlDriver) => Promise<unknown>, match: RegExp): Promise<string> {
  const { driver, asked } = watching()
  await run(driver)
  const found = asked.find((a) => match.test(a.sql))
  if (!found) throw new Error(`no statement matching ${match} among ${asked.length}`)
  const rows = await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${found.sql}`, found.params)
  return rows.map((r) => r.detail).join(' | ')
}

describe('the Bills page, on twenty thousand bills', () => {
  it('finds its fifty rows through an index instead of reading every bill', async () => {
    const plan = await planOf((d) => listBills(d, { status: 'live' }), reads('bills'))

    expect(plan).toContain('USING INDEX idx_bills_ledger')
    expect(plan).not.toContain('SCAN bills')
    /* The date is in the index, so only the `created_at` tiebreak is sorted.
       "LAST TERM" rather than the whole ORDER BY is the difference between
       sorting fifty rows and sorting nineteen thousand eight hundred. */
    expect(plan).toContain('USE TEMP B-TREE FOR LAST TERM OF ORDER BY')
  })

  it('counts them the same way', async () => {
    const plan = await planOf((d) => countBills(d, { status: 'live' }), /count\(\*\)/i)
    expect(plan).toContain('idx_bills_ledger')
  })

  it('still narrows by date through the date index', async () => {
    /* Two indexes could serve this and the planner picks between them. Either
       answer is fine; reading the whole table is not. */
    const plan = await planOf(
      (d) => listBills(d, { from: '2026-01-01', to: '2026-03-31' }),
      reads('bills'),
    )
    expect(plan).toMatch(/USING INDEX idx_bills_(date|ledger)/)
    expect(plan).not.toContain('SCAN bills')
  })
})

describe('the Audit page, on twenty-one thousand rows', () => {
  it('goes straight to one person rather than walking the whole log', async () => {
    const plan = await planOf(
      (d) => listAuditEntries(d, { actorId: shop.staffIds[3]! }),
      reads('audit_log'),
    )
    expect(plan).toContain('USING INDEX idx_audit_actor')
    expect(plan).not.toContain('idx_audit_at')
  })

  it('keeps the newest-first order out of the index, not out of a sort', async () => {
    /* The whole reason `at DESC` is the second column. With `actor_id` alone
       this reads "USE TEMP B-TREE FOR ORDER BY" — every row that actor ever
       touched, sorted, to show a hundred — and the busy cashier's case gets
       forty times slower than having no index at all. */
    const plan = await planOf(
      (d) => listAuditEntries(d, { actorId: shop.staffIds[1]! }),
      reads('audit_log'),
    )
    expect(plan).toContain('USE TEMP B-TREE FOR LAST TERM OF ORDER BY')
    expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  })

  it('reads the actor list off the index it already has', async () => {
    const plan = await planOf((d) => auditActors(d), /DISTINCT/)
    expect(plan).toContain('COVERING INDEX idx_audit_actor')
  })

  it('still opens unfiltered through the date index', async () => {
    const plan = await planOf((d) => listAuditEntries(d, {}), /FROM audit_log a/)
    expect(plan).toContain('idx_audit_at')
    expect(plan).not.toContain('TEMP B-TREE')
  })
})

describe('the stock ledger', () => {
  it('replays one product in order without sorting anything', async () => {
    /* This is why migration 034 did *not* add the third index the phase asked
       for. `idx_stock_ledger_product` is `(product_id, posting_date)` and an
       index's key order ends with the rowid, so `ORDER BY posting_date, rowid`
       is already a prefix of it. Appending `created_at` would put a column in
       between and hand this query a sort it does not have.

       If a later migration adds that column, this test is what says so. */
    const plan = await planOf(
      (d) => productValuation(d, shop.productIds[3]!),
      reads('stock_ledger'),
    )
    expect(plan).toContain('USING INDEX idx_stock_ledger_product')
    expect(plan).not.toContain('TEMP B-TREE')
  })
})
