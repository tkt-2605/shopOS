import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { postMovement, currentStock } from '../src/services/stock.js'
import { collectChanges, applyBatch, changedHere } from '../src/services/sync.js'
import { pruneFeed, feedHead } from '../src/services/changefeed.js'
import type { ChangeBatch, ChangeRecord } from '../src/domain/replicaShape.js'
import { setDeviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { newId } from '../src/ids.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TILL_A, TILL_B, as, pull, type Till } from './twoTills.js'

/**
 * A reversal that reaches a till before the sale it reverses.
 *
 * `reconcileDoubleReversals` used to count reversals against the sale's
 * movements, and a reversal with no sale yet was counted against nothing:
 * taken back as an extra, and the sale then left the shelf for good on that
 * till alone. The ordinary way there is a feed pruned past the sale and
 * re-seeded for a till below its floor, which appends the sale after the
 * reversal still waiting in the feed. See `stockReversals.ts`.
 */

const TILL_C = '3333cccc-3333-4333-8333-333333333333'

let fx: Fixture
let a: Till
let product: string
let billId: string

beforeEach(async () => {
  fx = await freshDb()
  a = { id: TILL_A, db: fx.db }
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
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
})

const onShelf = (t: Till) => currentStock(t.db, product)
const isSale = (r: ChangeRecord) => r.table === 'stock_ledger' && r.row?.['voucher_type'] === 'bill'

/** Applies `batch` one record at a time, in the order given, as `to`. */
async function oneByOne(to: Till, batch: ChangeBatch, records: readonly ChangeRecord[]) {
  await as(to.id, async () => {
    for (const record of records) {
      const one = { ...batch, records: [record] }
      await applyBatch(to.db, one, await changedHere(to.db, 0, one.records))
    }
  })
}

describe('a bill cancelled once, whose reversal arrives first', () => {
  it('stays on the shelf when the sale comes a batch later', async () => {
    await as(a.id, () => cancelBill(a.db, { billId, reason: 'x', actorId: fx.adminId }))
    const b = { id: TILL_B, db: await emptyDb() }
    const all = await as(a.id, () => collectChanges(a.db, 0, 100_000, b.id))
    const first = { ...all, records: all.records.filter((r) => !isSale(r)) }
    const second = { ...all, records: all.records.filter(isSale) }
    expect(second.records).toHaveLength(1)

    await as(b.id, async () => {
      await applyBatch(b.db, first, await changedHere(b.db, 0, first.records))
      await applyBatch(b.db, second, await changedHere(b.db, 0, second.records))
    })

    expect(await onShelf(a)).toBe(fromUnits(10))
    expect(await onShelf(b)).toBe(fromUnits(10))
    await b.db.close()
  })

  it('stays on the shelf for a till that joins after the sale was pruned from the feed', async () => {
    await as(a.id, async () => {
      await pruneFeed(a.db, await feedHead(a.db))
      await cancelBill(a.db, { billId, reason: 'x', actorId: fx.adminId })
    })
    const b = { id: TILL_B, db: await emptyDb() }
    await pull(b, a, 5)

    expect(await onShelf(b)).toBe(fromUnits(10))
    expect(await b.db.query(`SELECT id FROM stock_ledger WHERE id LIKE '%~dup'`)).toEqual([])
    await b.db.close()
  })
})

describe('a bill cancelled on two tills, reaching a third backwards', () => {
  it('puts the goods back once, and takes back the same reversal as the others', async () => {
    const b = { id: TILL_B, db: await emptyDb() }
    await pull(b, a)
    await as(a.id, () => cancelBill(a.db, { billId, reason: 'a', actorId: fx.adminId }))
    await as(b.id, () => cancelBill(b.db, { billId, reason: 'b', actorId: fx.adminId }))
    await pull(a, b)

    const c = { id: TILL_C, db: await emptyDb() }
    const all = await as(a.id, () => collectChanges(a.db, 0, 100_000, c.id))
    await oneByOne(c, all, [...all.records].reverse())

    const dups = (t: Till) => t.db.query<{ id: string }>(`SELECT id FROM stock_ledger WHERE id LIKE '%~dup' ORDER BY id`)
    expect(await onShelf(a)).toBe(fromUnits(10))
    expect(await onShelf(c)).toBe(fromUnits(10))
    expect(await dups(c)).toEqual(await dups(a))
    await b.db.close()
    await c.db.close()
  })
})
