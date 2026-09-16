import { describe, it, expect, beforeAll } from 'vitest'
import { openMemoryDatabase } from '@shopos/core/node'
import {
  migrate, peekDocNo, MAX_DOC_NO, Quantity,
  recomputeStock, createBill, submitBill, type SqlDriver,
} from '@shopos/core'
import { MIGRATIONS } from '@shopos/core/migrations'
import { buildSyntheticShop, type SyntheticShop } from '../src/build.js'

/**
 * Whether the made-up shop is a shop.
 *
 * A fixture nobody checks is worse than no fixture: every test that runs
 * against it inherits its mistakes and reports them as findings about the code.
 * So before anything measures a query plan on this thing, this file establishes
 * that the thing is coherent — that the cache agrees with the ledger, that the
 * bills add up, that the numbers on the paper are legal and unique, and that
 * the shop can still be sold in.
 *
 * Built once for the whole file. Two seconds is cheap; twenty-odd rebuilds of
 * it are not.
 */

let db: SqlDriver
let shop: SyntheticShop

beforeAll(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  shop = await buildSyntheticShop(db)
}, 120_000)

async function count(table: string, where = '1=1'): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
  return row?.n ?? 0
}

describe('the shop it builds', () => {
  it('is the size the phase needs', async () => {
    expect(shop.bills + shop.cancelled).toBe(20_000)
    expect(await count('bills')).toBe(20_000)
    expect(await count('bills', 'docstatus = 1')).toBe(shop.bills)
    expect(await count('bills', 'docstatus = 2')).toBe(shop.cancelled)
    expect(await count('products')).toBe(400)
    expect(await count('customers')).toBe(600)

    // The four the scale work needs to be large: a ledger long enough that
    // replaying all of it is a visible cost, and an audit log long enough that
    // finding one actor in it is a question.
    expect(await count('stock_ledger')).toBeGreaterThan(40_000)
    expect(await count('bill_items')).toBeGreaterThan(40_000)
    expect(await count('audit_log')).toBeGreaterThan(20_000)
    expect(await count('bills', "posting_date >= date('now')")).toBe(0)
  })

  it('owes money past the end of one page of customers', async () => {
    /* The Credit page loads five hundred customers, ordered by name, and adds
       up the ones it got. For that to be a bug there has to be somebody owing
       money *after* the five hundredth name — otherwise the fixture agrees with
       the code for the wrong reason and the test that follows proves nothing. */
    const beyond = await db.get<{ n: number; owed: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(owed), 0) AS owed FROM (
         SELECT c.id,
                COALESCE((SELECT SUM(b.credit_total) FROM bills b
                           WHERE b.customer_id = c.id AND b.docstatus = 1), 0)
              - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                            JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                            JOIN bills b2 ON b2.id = pa.bill_id
                           WHERE b2.customer_id = c.id), 0) AS owed
           FROM customers c
          WHERE c.is_active = 1 AND c.deleted_at IS NULL
          ORDER BY c.name
          LIMIT -1 OFFSET 500)
        WHERE owed > 0`,
    )
    expect(beyond?.n).toBeGreaterThan(0)
    expect(beyond?.owed).toBeGreaterThan(0)
  })

  it('did not manufacture a year of changes for a peer to fetch', async () => {
    /* Generated, not traded. A feed saying twenty thousand bills are waiting to
       be sent would be believed by the next sync test, which would then be
       measuring something that never happened. */
    expect(await count('change_feed', `table_name = 'bills'`)).toBe(0)
    const flag = await db.get<{ applying: number }>(`SELECT applying FROM sync_state WHERE id = 1`)
    expect(flag?.applying).toBe(0)
  })
})

describe('what it says about itself', () => {
  it('counted what it wrote', async () => {
    expect(await count('bill_items')).toBe(shop.billItems)
    expect(await count('stock_ledger')).toBe(shop.ledgerRows)
    expect(await count('payment_entries')).toBe(shop.payments)
    expect(await count('products')).toBe(shop.productIds.length)
    expect(await count('customers')).toBe(shop.customerIds.length)
  })

  it('knows what the shop took', async () => {
    const row = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(grand_total), 0) AS total FROM bills WHERE docstatus = 1`,
    )
    expect(row?.total).toBe(shop.sales)
  })

  it('knows what the shop is owed', async () => {
    /* Per customer and then the positive ones added up, which is what the
       Credit page means by the phrase. A shop is not owed less because somebody
       else is in credit. */
    const row = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(owed), 0) AS total FROM (
         SELECT COALESCE((SELECT SUM(b.credit_total) FROM bills b
                           WHERE b.customer_id = c.id AND b.docstatus = 1), 0)
              - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                            JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                            JOIN bills b2 ON b2.id = pa.bill_id
                           WHERE b2.customer_id = c.id), 0) AS owed
           FROM customers c)
        WHERE owed > 0`,
    )
    expect(row?.total).toBe(shop.outstanding)
    expect(shop.outstanding).toBeGreaterThan(0)
  })
})

describe('the books', () => {
  it('has a stock cache that is what the ledger replays to', async () => {
    /* The generator keeps a running position as it sells and writes
       `product_stock` from that. `recomputeStock` throws the whole ledger
       through `movingAverage` instead. Two roads, and this is the test that
       they arrive at the same place — it caught a cancellation putting stock
       back at the wrong cost, which is a real bug in a shape the app can also
       produce. */
    expect(await recomputeStock(db)).toEqual([])
  })

  it('never let the ledger balance disagree with itself', async () => {
    const bad = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT id, balance_qty,
                SUM(qty_change) OVER (PARTITION BY product_id ORDER BY rowid) AS running
           FROM stock_ledger)
        WHERE balance_qty <> running`,
    )
    expect(bad?.n).toBe(0)
  })

  it('has bills that add up', async () => {
    expect(await count('bills', 'taxable_total + tax_total + round_off <> grand_total')).toBe(0)
    expect(await count('bills', 'paid_total + credit_total <> grand_total')).toBe(0)
    expect(await count('bills', 'credit_total > 0 AND customer_id IS NULL')).toBe(0)
  })

  it('has bills whose lines add up to them', async () => {
    const bad = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bills b
        WHERE b.taxable_total + b.tax_total <> (
          SELECT COALESCE(SUM(i.taxable_value + i.cgst_amount + i.sgst_amount + i.igst_amount), 0)
            FROM bill_items i WHERE i.bill_id = b.id)`,
    )
    expect(bad?.n).toBe(0)
  })

  it('never allocated more against a bill than the bill was owed', async () => {
    const bad = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bills b
        WHERE (SELECT COALESCE(SUM(pa.amount), 0) FROM payment_allocations pa
                WHERE pa.bill_id = b.id) > b.credit_total`,
    )
    expect(bad?.n).toBe(0)
  })

  it('leaves no dangling rows behind it', async () => {
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([])
    expect(await db.query(`PRAGMA integrity_check`)).toEqual([{ integrity_check: 'ok' }])
  })
})

describe('the paper', () => {
  it('numbers every document once, within the sixteen characters the law allows', async () => {
    const dupes = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT doc_no FROM bills GROUP BY doc_no HAVING COUNT(*) > 1)`,
    )
    expect(dupes?.n).toBe(0)

    const longest = await db.get<{ doc_no: string }>(
      `SELECT doc_no FROM bills ORDER BY LENGTH(doc_no) DESC LIMIT 1`,
    )
    expect(longest!.doc_no.length).toBeLessThanOrEqual(MAX_DOC_NO)
  })

  it('leaves the counter where the next real bill carries on from', async () => {
    /* Without `doc_sequences` the shop has twenty thousand invoices and a
       counter that starts again at one, and the first test to bill against it
       collides on a `doc_no` that is already printed. */
    const next = await peekDocNo(db, 'bill', shop.registerPrefix, new Date(`${shop.to}T12:00:00`))
    expect(await count('bills', `doc_no = '${next}'`)).toBe(0)

    const highest = await db.get<{ doc_no: string }>(
      `SELECT doc_no FROM bills WHERE doc_no LIKE 'BMR/2627/%' ORDER BY doc_no DESC LIMIT 1`,
    )
    const after = Number(next.slice(next.lastIndexOf('/') + 1))
    expect(after).toBe(Number(highest!.doc_no.slice(highest!.doc_no.lastIndexOf('/') + 1)) + 1)
  })
})

describe('what can still be done to it', () => {
  it('can be sold in', async () => {
    /* The point of the whole file. A fixture that the real billing path cannot
       write to is a museum piece, and every later test on it would be measuring
       a shop that cannot trade. */
    const stocked = await db.get<{ product_id: string }>(
      `SELECT product_id FROM product_stock WHERE qty_on_hand > 50000 LIMIT 1`,
    )
    const draft = await createBill(db, {
      registerId: shop.registerId,
      customerId: shop.customerIds[0]!,
      lines: [{ productId: stocked!.product_id, qty: Quantity.fromUnits(1) }],
      actorId: shop.adminId,
    })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    const done = await submitBill(db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: shop.adminId,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.docNo).not.toBe('')
    expect(await count('bills')).toBe(20_001)
  })
})

describe('the seed', () => {
  it('builds the same shop twice, and a different one on a different number', async () => {
    /* A performance test that fails once a fortnight on a shop nobody can
       rebuild is worse than no test. */
    const again = await build({ bills: 500, products: 40, customers: 30, days: 30 })
    const same = await build({ bills: 500, products: 40, customers: 30, days: 30 })
    expect(same.sales).toBe(again.sales)
    expect(same.outstanding).toBe(again.outstanding)
    expect(same.ledgerRows).toBe(again.ledgerRows)

    const other = await build({ bills: 500, products: 40, customers: 30, days: 30, seed: 11 })
    expect(other.sales).not.toBe(again.sales)
  }, 60_000)
})

async function build(shape: Parameters<typeof buildSyntheticShop>[1]): Promise<SyntheticShop> {
  const fresh = openMemoryDatabase()
  await migrate(fresh, MIGRATIONS)
  try {
    return await buildSyntheticShop(fresh, shape)
  } finally {
    await fresh.close()
  }
}
