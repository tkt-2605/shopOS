import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { postMovement, recomputeStock } from '../src/services/stock.js'
import { applyBatch } from '../src/services/sync.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { ChangeBatch } from '../src/domain/replicaShape.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'

/** One id for a crafted record's `rowId` and its row's key, which a merge now holds to agreeing. */
const ROW_ID = newId()

/**
 * Replaying one product's ledger instead of the whole shop's.
 *
 * The cost of the full replay is the reason: it is linear in every stock
 * movement the shop has ever made, and it was being paid on every Dashboard
 * mount and after every sync round that carried a single row. `tools/synthetic-
 * shop` has the measurement on a year of trade; what is pinned here is that
 * narrowing it does not change the answer, and that the narrowing is honest —
 * a scoped replay must not report drift it did not look for, and must not
 * quietly skip a product it was asked about.
 */

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

async function stocked(units: number): Promise<string> {
  const id = await makeProduct(fx.db, { baseRate: rupees(50), taxRateBp: 0 })
  await fx.db.transaction(async (tx) => {
    await postMovement(tx, {
      productId: id, qtyChange: fromUnits(units), unitCost: rupees(30),
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    })
  })
  return id
}

/** Corrupts the cache the way something writing outside `stock.ts` would. */
async function bendTheCache(productId: string, to: number): Promise<void> {
  await fx.db.execute(`UPDATE product_stock SET qty_on_hand = ? WHERE product_id = ?`, [to, productId])
}

describe('a replay of only the products named', () => {
  it('finds drift on a product it was asked about', async () => {
    const one = await stocked(10)
    await bendTheCache(one, fromUnits(3))

    const drift = await recomputeStock(fx.db, { productIds: [one] })
    expect(drift).toHaveLength(1)
    expect(drift[0]!.productId).toBe(one)
    expect(drift[0]!.actual).toBe(fromUnits(10))
    expect(drift[0]!.cached).toBe(fromUnits(3))
  })

  it('does not look at, or report, a product it was not asked about', async () => {
    const asked = await stocked(10)
    const other = await stocked(20)
    await bendTheCache(other, fromUnits(1))

    expect(await recomputeStock(fx.db, { productIds: [asked] })).toEqual([])
    // And the full replay still sees it, so the scope narrowed the looking and
    // not the truth.
    expect(await recomputeStock(fx.db)).toHaveLength(1)
  })

  it('repairs only what it was asked about', async () => {
    const asked = await stocked(10)
    const other = await stocked(20)
    await bendTheCache(asked, fromUnits(3))
    await bendTheCache(other, fromUnits(1))

    await recomputeStock(fx.db, { productIds: [asked], repair: true })

    const rows = await fx.db.query<{ product_id: string; qty_on_hand: number }>(
      `SELECT product_id, qty_on_hand FROM product_stock ORDER BY product_id`,
    )
    const by = new Map(rows.map((r) => [r.product_id, r.qty_on_hand]))
    expect(by.get(asked)).toBe(fromUnits(10))
    expect(by.get(other)).toBe(fromUnits(1))
  })

  it('gives the same answer as the full replay for the same products', async () => {
    /* The point of the whole change: less work, not different arithmetic. */
    const ids = [await stocked(10), await stocked(7), await stocked(3)]
    for (const id of ids) {
      await fx.db.transaction(async (tx) => {
        await postMovement(tx, {
          productId: id, qtyChange: fromUnits(-2), voucherType: 'bill',
          voucherId: newId(), postingDate: '2026-02-01',
        })
      })
    }
    for (const id of ids) await bendTheCache(id, fromUnits(99))

    const whole = await recomputeStock(fx.db)
    const scoped = await recomputeStock(fx.db, { productIds: ids })
    expect(scoped).toEqual(whole)
  })

  it('treats an empty list as nothing to do, not as everything', async () => {
    /* The trap. An empty array is what a caller naturally passes when nothing
       was touched, and reading it as "all products" would turn the one case
       that needs no work into the most expensive call in the module. */
    const one = await stocked(10)
    await bendTheCache(one, fromUnits(3))

    expect(await recomputeStock(fx.db, { productIds: [] })).toEqual([])
    expect(await recomputeStock(fx.db, { productIds: [], repair: true })).toEqual([])
    const row = await fx.db.get<{ qty_on_hand: number }>(
      `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`, [one],
    )
    expect(row?.qty_on_hand).toBe(fromUnits(3))
  })

  it('still answers when asked about more products than fit in one query', async () => {
    /* The ids go into an `IN (...)`, chunked at two hundred. A merge that
       touched more than that is an ordinary evening's sync between two busy
       tills, and it must not come back with only the first chunk's drift. */
    const ids: string[] = []
    for (let i = 0; i < 210; i++) ids.push(await stocked(5))
    for (const id of ids) await bendTheCache(id, fromUnits(1))

    const drift = await recomputeStock(fx.db, { productIds: ids })
    expect(drift).toHaveLength(210)
    expect(new Set(drift.map((d) => d.productId)).size).toBe(210)
  }, 30_000)

  it('says nothing about a product id that is not a product', async () => {
    expect(await recomputeStock(fx.db, { productIds: [newId()] })).toEqual([])
  })
})

describe('what a merge replays', () => {
  function batch(records: ChangeBatch['records']): ChangeBatch {
    return {
      fromDevice: '2222bbbb-2222-4222-8222-222222222222',
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      records,
      upTo: records.length,
      complete: true,
    }
  }

  it('brings the cache up to date for the product whose rows arrived', async () => {
    /* A merge is the one place a repair is right without a person asking: after
       taking in another till's ledger rows the cache is *known* to be behind by
       construction. That is not drift, it is arithmetic not yet done. */
    const here = await stocked(10)
    const sold = await fx.db.get<{ id: string }>(`SELECT id FROM products WHERE id = ?`, [here])
    expect(sold).toBeTruthy()

    const applied = await applyBatch(fx.db, batch([{
      table: 'stock_ledger',
      rowId: ROW_ID,
      op: 'upsert',
      row: {
        id: ROW_ID, product_id: here, posting_date: '2026-03-01',
        qty_change: -fromUnits(4), unit_cost: rupees(30), balance_qty: fromUnits(6),
        voucher_type: 'bill', voucher_id: newId(), created_by: null,
        created_at: '2026-03-01T10:00:00.000Z',
      },
    }]))

    expect(applied.applied).toBe(1)
    const row = await fx.db.get<{ qty_on_hand: number }>(
      `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`, [here],
    )
    expect(row?.qty_on_hand).toBe(fromUnits(6))
  })

  it('leaves a product the batch said nothing about exactly as it was', async () => {
    const touched = await stocked(10)
    const untouched = await stocked(20)
    /* Bent by hand, and deliberately left bent. Before this change the merge
       replayed everything, so a sync would silently repair drift on a product
       nobody had mentioned — which sounds helpful and is not: it destroys the
       evidence that something is writing stock outside `stock.ts`, which is the
       only thing that drift means. */
    await bendTheCache(untouched, fromUnits(1))

    await applyBatch(fx.db, batch([{
      table: 'stock_ledger',
      rowId: ROW_ID,
      op: 'upsert',
      row: {
        id: ROW_ID, product_id: touched, posting_date: '2026-03-01',
        qty_change: -fromUnits(4), unit_cost: rupees(30), balance_qty: fromUnits(6),
        voucher_type: 'bill', voucher_id: newId(), created_by: null,
        created_at: '2026-03-01T10:00:00.000Z',
      },
    }]))

    const row = await fx.db.get<{ qty_on_hand: number }>(
      `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`, [untouched],
    )
    expect(row?.qty_on_hand).toBe(fromUnits(1))
  })

  it('refuses a ledger row deleted elsewhere, and keeps it', async () => {
    /* The ledger is append-only in the database since 052, not only by habit:
       a deletion arriving from another till is set aside in quarantine rather
       than taking a movement out of this till's history. */
    const product = await stocked(20)

    const ledgerRow = await fx.db.get<{ id: string }>(
      `SELECT id FROM stock_ledger WHERE product_id = ?`, [product],
    )
    const outcome = await applyBatch(fx.db, batch([
      { table: 'stock_ledger', rowId: ledgerRow!.id, op: 'delete', row: null },
    ]))

    expect(outcome.quarantined).toBe(1)
    const still = await fx.db.get<{ id: string }>(`SELECT id FROM stock_ledger WHERE id = ?`, [ledgerRow!.id])
    expect(still?.id).toBe(ledgerRow!.id)
  })

  it('does nothing at all when the batch carried no stock', async () => {
    const one = await stocked(10)
    await bendTheCache(one, fromUnits(3))

    await applyBatch(fx.db, batch([{
      table: 'customers',
      rowId: ROW_ID,
      op: 'upsert',
      row: {
        id: ROW_ID, code: null, name: 'Someone', phone: null, email: null, gstin: null,
        address: null, state_code: '33', price_list_id: null, credit_limit: 0,
        credit_enforcement: 'hard', is_active: 1, rev: 1, origin_id: null,
        created_at: '2026-03-01T10:00:00.000Z', updated_at: '2026-03-01T10:00:00.000Z',
        deleted_at: null,
      },
    }]))

    const row = await fx.db.get<{ qty_on_hand: number }>(
      `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`, [one],
    )
    expect(row?.qty_on_hand).toBe(fromUnits(3))
  })
})
