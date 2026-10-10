import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { postMovement, currentStock, recomputeStock } from '../src/services/stock.js'
import { reconcileDoubleReversals } from '../src/services/stockReversals.js'
import { ledgerChecks } from '../src/repos/ledger.js'
import { setDeviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TILL_A, TILL_B, as, pull, type Till } from './twoTills.js'

/**
 * One bill cancelled on two tills while they were apart.
 *
 * Each till put the goods back on its own shelf, under ids of its own, so once
 * they met the ledger held two reversals of one sale: a unit too many on the
 * shelf, and the stock account out of step with the books by that unit's cost.
 * Found on a three-till bench, where "Books and the stock ledger disagree by
 * ₹285.00" was the only sign. See `services/stockReversals.ts`.
 */

let fx: Fixture
let a: Till
let b: Till
let product: string
let billId: string

beforeEach(async () => {
  fx = await freshDb()
  a = { id: TILL_A, db: fx.db }
  b = { id: TILL_B, db: await emptyDb() }

  product = await makeProduct(fx.db, { baseRate: rupees(500), taxRateBp: 0 })
  await as(a.id, async () => {
    await fx.db.transaction((tx) => postMovement(tx, {
      productId: product, qtyChange: fromUnits(10), unitCost: 28500 as Money,
      voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
    }))
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId, lines: [{ productId: product, qty: fromUnits(1) }], actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    billId = draft.billId
    const done = await submitBill(fx.db, {
      billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
    })
    if (!done.ok) throw new Error(done.code)
  })
  await pull(b, a)
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

const onShelf = (t: Till) => currentStock(t.db, product)

async function cancelOnBoth() {
  await as(a.id, () => cancelBill(a.db, { billId, reason: 'a', actorId: fx.adminId }))
  await as(b.id, () => cancelBill(b.db, { billId, reason: 'b', actorId: fx.adminId }))
  await pull(a, b)
  await pull(b, a)
  await pull(a, b)
}

describe('a bill cancelled on two tills at once', () => {
  it('puts the goods back once, on both', async () => {
    await cancelOnBoth()
    // Ten in, one sold, one put back: ten, not eleven.
    expect(await onShelf(a)).toBe(fromUnits(10))
    expect(await onShelf(b)).toBe(fromUnits(10))
  })

  it('leaves the stock account and the books agreeing', async () => {
    await cancelOnBoth()
    for (const t of [a, b]) {
      const checks = await ledgerChecks(t.db)
      // The opening stock here was posted without books entries, which is a
      // fixed gap of its own; what a second reversal added on top was one
      // more unit's cost (-313,500 against this).
      expect(checks.stockDrift).toBe(-10 * 28500)
    }
  })

  it('leaves both tills with the same ledger and nothing to recompute', async () => {
    await cancelOnBoth()
    const rows = (t: Till) => t.db.query<{ id: string }>('SELECT id FROM stock_ledger ORDER BY id')
    expect((await rows(a)).map((r) => r.id)).toEqual((await rows(b)).map((r) => r.id))
    for (const t of [a, b]) expect(await recomputeStock(t.db)).toEqual([])
  })

  it('is a no-op the second time, and never rewrites a row', async () => {
    await cancelOnBoth()
    const before = await a.db.query('SELECT * FROM stock_ledger ORDER BY id')
    expect(await reconcileDoubleReversals(a.db, { repair: true })).toEqual([])
    expect(await a.db.query('SELECT * FROM stock_ledger ORDER BY id')).toEqual(before)
  })

  it('does nothing to a bill cancelled once', async () => {
    await as(a.id, () => cancelBill(a.db, { billId, actorId: fx.adminId }))
    await pull(b, a)
    expect(await reconcileDoubleReversals(b.db, { repair: true })).toEqual([])
    expect(await onShelf(b)).toBe(fromUnits(10))
  })
})
