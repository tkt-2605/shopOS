import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { createStockEntry, submitStockEntry, cancelStockEntry, type StockEntryLineInput, type StockEntryType } from '../src/services/stockEntry.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn, cancelReturn } from '../src/services/returns.js'
import { currentStock, recomputeStock } from '../src/services/stock.js'
import { batchesOf, batchesOnVoucher, batchTextFor, expiringBatches, planSale } from '../src/services/batches.js'
import { batchIdFor } from '../src/domain/batches.js'
import { businessDate } from '../src/dates.js'
import { collectChanges, applyBatch } from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Batch numbers and expiry dates, through every document that moves stock.
 *
 * The stock ledger does not know batches exist. These tests hold the other
 * half: that what the batches say adds up to what happened, on a delivery, a
 * sale, a return and the cancelling of each -- and that two tills end up
 * holding one batch, not two.
 */

const GOOD = '2099-12-31'
const SOONER = '2098-06-30'
const EXPIRED = '2020-01-31'

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { name: 'Paracetamol 500', baseRate: rupees(20), taxRateBp: 0 })
})

afterEach(async () => {
  setDeviceId(null)
  await fx.db.close()
})

async function receive(
  lines: Omit<StockEntryLineInput, 'productId'>[],
  entryType: StockEntryType = 'purchase',
  db: SqlDriver = fx.db,
) {
  const entry = await createStockEntry(db, {
    entryType,
    lines: lines.map((l) => ({ productId: product, unitCost: rupees(10), ...l })),
    actorId: fx.adminId,
  })
  if (!entry.ok) return entry
  return submitStockEntry(db, { entryId: entry.entryId, actorId: fx.adminId })
}

async function sell(units: number, batchPicks?: Record<number, string>) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId: product, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: 'cash', amount: draft.grandTotal }],
    ...(batchPicks ? { batchPicks } : {}),
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [draft.billId])
  return { billId: draft.billId, itemId: item!.id }
}

async function balances(db: SqlDriver = fx.db): Promise<Record<string, number>> {
  const rows = await batchesOf(db, product)
  return Object.fromEntries(rows.map((r) => [r.batchNo, toUnits(r.balance)]))
}

describe('receiving goods into a batch', () => {
  it('records the batch and what came in', async () => {
    const done = await receive([{ qty: fromUnits(10), batchNo: 'b 101', expiryDate: GOOD }])
    expect(done.ok).toBe(true)

    const [row] = await batchesOf(fx.db, product)
    expect(row).toMatchObject({ batchNo: 'B 101', expiryDate: GOOD })
    expect(toUnits(row!.balance)).toBe(10)
    expect(toUnits(await currentStock(fx.db, product)), 'the ledger moved as it always did').toBe(10)
  })

  it('adds a second delivery of the same batch to it', async () => {
    await receive([{ qty: fromUnits(10), batchNo: 'B101', expiryDate: GOOD }])
    await receive([{ qty: fromUnits(5), batchNo: 'b101', expiryDate: GOOD }])
    expect(await balances()).toEqual({ B101: 15 })
  })

  it('refuses a batch given a different expiry from the one on record', async () => {
    await receive([{ qty: fromUnits(10), batchNo: 'B101', expiryDate: GOOD }])
    const again = await receive([{ qty: fromUnits(5), batchNo: 'B101', expiryDate: SOONER }])
    expect(again).toMatchObject({ ok: false, code: 'EXPIRY_MISMATCH', recorded: GOOD })
    expect(toUnits(await currentStock(fx.db, product)), 'and nothing was half-written').toBe(10)
  })

  it('refuses two lines of one delivery that disagree about a batch', async () => {
    const done = await receive([
      { qty: fromUnits(1), batchNo: 'B1', expiryDate: GOOD },
      { qty: fromUnits(1), batchNo: 'B1', expiryDate: SOONER },
    ])
    expect(done).toMatchObject({ ok: false, code: 'EXPIRY_MISMATCH' })
  })

  it('gives a batch recorded without a date the first date it is given', async () => {
    await receive([{ qty: fromUnits(1), batchNo: 'B1' }])
    await receive([{ qty: fromUnits(1), batchNo: 'B1', expiryDate: GOOD }])
    const [row] = await batchesOf(fx.db, product)
    expect(row?.expiryDate).toBe(GOOD)
  })

  it('leaves a line with no batch exactly as before', async () => {
    await receive([{ qty: fromUnits(10) }])
    expect(await batchesOf(fx.db, product)).toEqual([])
    expect(toUnits(await currentStock(fx.db, product))).toBe(10)
  })

  it('takes a batch back out when the entry is cancelled', async () => {
    const entry = await createStockEntry(fx.db, {
      entryType: 'purchase',
      lines: [{ productId: product, qty: fromUnits(10), unitCost: rupees(10), batchNo: 'B1', expiryDate: GOOD }],
      actorId: fx.adminId,
    })
    if (!entry.ok) throw new Error(entry.code)
    await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
    await cancelStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
    expect(await balances()).toEqual({ B1: 0 })
  })
})

describe('writing goods off a batch', () => {
  it('takes wastage out of the batch it names', async () => {
    await receive([
      { qty: fromUnits(10), batchNo: 'OLD', expiryDate: EXPIRED },
      { qty: fromUnits(10), batchNo: 'NEW', expiryDate: GOOD },
    ])
    const done = await receive([{ qty: fromUnits(4), batchNo: 'old' }], 'wastage')
    expect(done.ok).toBe(true)
    expect(await balances()).toEqual({ OLD: 6, NEW: 10 })
  })

  it('refuses to write off more than the batch holds', async () => {
    await receive([
      { qty: fromUnits(3), batchNo: 'OLD', expiryDate: EXPIRED },
      { qty: fromUnits(10), batchNo: 'NEW', expiryDate: GOOD },
    ])
    const done = await receive([{ qty: fromUnits(4), batchNo: 'OLD' }], 'wastage')
    expect(done).toMatchObject({ ok: false, code: 'BATCH_WOULD_GO_NEGATIVE', batchNo: 'OLD' })
  })

  it('refuses a batch the shop never received', async () => {
    await receive([{ qty: fromUnits(3) }])
    const done = await receive([{ qty: fromUnits(1), batchNo: 'NOPE' }], 'wastage')
    expect(done).toMatchObject({ ok: false, code: 'UNKNOWN_BATCH' })
  })
})

describe('selling out of batches', () => {
  it('comes out of the soonest to expire, and says which on the bill', async () => {
    await receive([
      { qty: fromUnits(10), batchNo: 'LATE', expiryDate: GOOD },
      { qty: fromUnits(3), batchNo: 'EARLY', expiryDate: SOONER },
    ])
    const sale = await sell(5)

    expect(await balances()).toEqual({ EARLY: 0, LATE: 8 })
    const lines = await batchesOnVoucher(fx.db, 'bill', sale.billId)
    expect(lines.get(sale.itemId)?.map((b) => [b.batchNo, toUnits(b.qty)])).toEqual([['EARLY', 3], ['LATE', 2]])
    expect((await batchTextFor(fx.db, sale.billId)).get(sale.itemId))
      .toBe('Batch EARLY x3 Exp 06/2098, LATE x2 Exp 12/2099')
  })

  it('comes out of the batch the cashier picked', async () => {
    await receive([
      { qty: fromUnits(10), batchNo: 'LATE', expiryDate: GOOD },
      { qty: fromUnits(10), batchNo: 'EARLY', expiryDate: SOONER },
    ])
    await sell(2, { 1: batchIdFor(product, 'LATE') })
    expect(await balances()).toEqual({ EARLY: 10, LATE: 8 })
  })

  it('sells stock from before batches were used ahead of an expired pack', async () => {
    await receive([{ qty: fromUnits(5) }])
    await receive([{ qty: fromUnits(5), batchNo: 'OLD', expiryDate: EXPIRED }])

    const plan = await planSale(fx.db, product, fromUnits(6), { today: businessDate() })
    expect(toUnits(plan.unbatched)).toBe(5)
    expect(plan.expired, 'the counter is told the sixth reaches an expired batch').toBe(true)

    await sell(6)
    expect(await balances()).toEqual({ OLD: 4 })
  })

  it('puts the batches back when the bill is cancelled', async () => {
    await receive([{ qty: fromUnits(10), batchNo: 'B1', expiryDate: GOOD }])
    const sale = await sell(4)
    await cancelBill(fx.db, { billId: sale.billId, actorId: fx.adminId })
    expect(await balances()).toEqual({ B1: 10 })
  })

  it('costs nothing and changes nothing for an item that has never had a batch', async () => {
    await receive([{ qty: fromUnits(10) }])
    await sell(4)
    const moves = await fx.db.get<{ n: number }>(`SELECT count(*) AS n FROM batch_movements`)
    expect(moves?.n).toBe(0)
    expect(toUnits(await currentStock(fx.db, product))).toBe(6)
  })

  it('leaves the ledger and its valuation exactly as they were', async () => {
    await receive([{ qty: fromUnits(10), batchNo: 'B1', expiryDate: GOOD }])
    await sell(4)
    expect(await recomputeStock(fx.db)).toEqual([])
  })
})

describe('a return', () => {
  it('goes back into the batches the line came out of', async () => {
    await receive([
      { qty: fromUnits(2), batchNo: 'EARLY', expiryDate: SOONER },
      { qty: fromUnits(10), batchNo: 'LATE', expiryDate: GOOD },
    ])
    const sale = await sell(5)
    expect(await balances()).toEqual({ EARLY: 0, LATE: 7 })

    const ret = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(3) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error(ret.code)
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId })
    expect(await balances()).toEqual({ EARLY: 2, LATE: 8 })

    // A second return of the rest finds only what is still out.
    const rest = await createReturn(fx.db, {
      billId: sale.billId, lines: [{ billItemId: sale.itemId, qty: fromUnits(2) }],
      refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!rest.ok) throw new Error(rest.code)
    await submitReturn(fx.db, { returnId: rest.returnId, actorId: fx.adminId })
    expect(await balances()).toEqual({ EARLY: 2, LATE: 10 })

    await cancelReturn(fx.db, { returnId: rest.returnId, actorId: fx.adminId })
    expect(await balances(), 'and a cancelled return takes them out again').toEqual({ EARLY: 2, LATE: 8 })
  })
})

describe('what is about to expire', () => {
  it('lists batches with stock inside the window, soonest first', async () => {
    const today = '2026-09-27'
    await receive([
      { qty: fromUnits(5), batchNo: 'GONE', expiryDate: '2026-08-31' },
      { qty: fromUnits(5), batchNo: 'SOON', expiryDate: '2026-11-30' },
      { qty: fromUnits(5), batchNo: 'FINE', expiryDate: GOOD },
    ])
    await receive([{ qty: fromUnits(5), batchNo: 'SOLD', expiryDate: '2026-10-31' }])
    await receive([{ qty: fromUnits(5), batchNo: 'SOLD' }], 'wastage')

    const list = await expiringBatches(fx.db, { today, withinDays: 90 })
    expect(list.map((b) => b.batchNo)).toEqual(['GONE', 'SOON'])
    expect(list[0]?.productName).toBe('Paracetamol 500')
  })
})

describe('two tills', () => {
  const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
  const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

  async function as<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = deviceId()
    setDeviceId(id)
    try { return await fn() } finally { setDeviceId(before) }
  }

  it('each receiving the same batch while apart hold one batch with both deliveries', async () => {
    const b = await emptyDb()
    try {
      await as(TILL_B, async () => applyBatch(b, await as(TILL_A, () => collectChanges(fx.db, 0, 5000, TILL_B))))

      const cursorA = (await fx.db.get<{ s: number }>(`SELECT coalesce(max(seq), 0) AS s FROM change_feed`))!.s
      const cursorB = (await b.get<{ s: number }>(`SELECT coalesce(max(seq), 0) AS s FROM change_feed`))!.s

      await as(TILL_A, () => receive([{ qty: fromUnits(10), batchNo: 'B1', expiryDate: GOOD }]))
      await as(TILL_B, () => receive([{ qty: fromUnits(4), batchNo: 'b1', expiryDate: GOOD }], 'purchase', b))

      const fromA = await as(TILL_A, () => collectChanges(fx.db, cursorA, 5000, TILL_B))
      const fromB = await as(TILL_B, () => collectChanges(b, cursorB, 5000, TILL_A))
      await as(TILL_B, () => applyBatch(b, fromA))
      await as(TILL_A, () => applyBatch(fx.db, fromB))

      expect(await balances(fx.db)).toEqual({ B1: 14 })
      expect(await balances(b)).toEqual({ B1: 14 })
      /* Only the batch tables are asked about. The second till here was never
         given a number series of its own, so its stock entry clashes with the
         first on doc_no and is set aside -- which is the point of the test as
         much as an accident of it: the movements travel on their own, so the
         balances above are right even with the entry they came from parked. */
      const clashed = await fx.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM sync_quarantine WHERE table_name IN ('batches', 'batch_movements')`,
      )
      expect(clashed?.n, 'no batch clashed on the way').toBe(0)
    } finally {
      await b.close()
    }
  })
})
