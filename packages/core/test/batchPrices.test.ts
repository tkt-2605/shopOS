import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits, QTY_ZERO } from '../src/quantity.js'
import { createStockEntry, submitStockEntry, type StockEntryLineInput } from '../src/services/stockEntry.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { batchesOf, priceChoicesFor } from '../src/services/batches.js'
import { allocate, batchIdFor, priceChoices, UNBATCHED_PICK, type PricedBatch } from '../src/domain/batches.js'
import { loadDraft } from '../src/services/drafts.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * The same item at two prices (070): last month's packs say MRP 12, this
 * month's say MRP 14, and both are on the shelf. The counter asks which; the
 * bill charges and prints what that pack says, and sells out of it.
 */

let fx: Fixture
let product: string

beforeEach(async () => {
  fx = await freshDb()
  product = await makeProduct(fx.db, { name: 'Glue stick', baseRate: rupees(10), taxRateBp: 0 })
  await fx.db.execute(`UPDATE products SET mrp = ? WHERE id = ?`, [rupees(12), product])
})

afterEach(async () => {
  await fx.db.close()
})

async function receive(lines: Omit<StockEntryLineInput, 'productId'>[]) {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase',
    lines: lines.map((l) => ({ productId: product, unitCost: rupees(6), ...l })),
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  const done = await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
  if (!done.ok) throw new Error(done.code)
}

async function sell(units: number, batchId?: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId: product, qty: fromUnits(units), ...(batchId ? { batchId } : {}) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const line = await fx.db.get<{ rate: number; mrp: number | null; batch_id: string | null }>(
    `SELECT rate, mrp, batch_id FROM bill_items WHERE bill_id = ?`, [draft.billId])
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  return { billId: draft.billId, total: draft.grandTotal, line: line! }
}

const balances = async () =>
  Object.fromEntries((await batchesOf(fx.db, product)).map((b) => [b.batchNo, toUnits(b.balance)]))

describe('receiving goods at a new price', () => {
  it('puts them in a batch named by the price when no number was typed', async () => {
    await receive([{ qty: fromUnits(10) }])
    await receive([{ qty: fromUnits(5), mrp: rupees(14), saleRate: rupees(13) }])

    const [batch] = await batchesOf(fx.db, product)
    expect(batch).toMatchObject({ batchNo: 'MRP 14.00', mrp: rupees(14), rate: rupees(13) })
    expect(toUnits(batch!.balance)).toBe(5)
  })

  it('is ordinary stock when the price is the item’s own', async () => {
    await receive([{ qty: fromUnits(5), mrp: rupees(12) }])
    expect(await batchesOf(fx.db, product)).toEqual([])
  })

  it('holds the rate at the new MRP when the item’s rate would sell above it', async () => {
    await receive([{ qty: fromUnits(5), mrp: rupees(8) }])
    const [batch] = await batchesOf(fx.db, product)
    expect(batch).toMatchObject({ mrp: rupees(8), rate: rupees(8) })
  })

  it('gives a typed batch number its price', async () => {
    await receive([{ qty: fromUnits(5), batchNo: 'b77', mrp: rupees(15) }])
    const [batch] = await batchesOf(fx.db, product)
    expect(batch).toMatchObject({ batchNo: 'B77', mrp: rupees(15), rate: null })
  })
})

describe('the counter asking which price', () => {
  it('asks nothing while the shelf holds one price', async () => {
    await receive([{ qty: fromUnits(10) }])
    expect(await priceChoicesFor(fx.db, product)).toEqual([])
  })

  it('offers the old packs and the new, cheapest first', async () => {
    await receive([{ qty: fromUnits(10) }])
    await receive([{ qty: fromUnits(5), mrp: rupees(14), saleRate: rupees(13) }])

    const choices = await priceChoicesFor(fx.db, product)
    expect(choices.map((c) => [c.pick, c.mrp, c.rate, toUnits(c.balance)])).toEqual([
      [UNBATCHED_PICK, rupees(12), rupees(10), 10],
      [batchIdFor(product, 'MRP 14.00'), rupees(14), rupees(13), 5],
    ])
  })

  it('stops asking once the other price has sold out', async () => {
    await receive([{ qty: fromUnits(2) }])
    await receive([{ qty: fromUnits(5), mrp: rupees(14) }])
    await sell(2, UNBATCHED_PICK)
    expect(await priceChoicesFor(fx.db, product)).toEqual([])
  })
})

describe('selling a batch with its own price', () => {
  beforeEach(async () => {
    await receive([{ qty: fromUnits(10) }])
    await receive([{ qty: fromUnits(5), mrp: rupees(14), saleRate: rupees(13) }])
  })

  it('charges the batch’s rate, prints its MRP and sells out of it', async () => {
    const newBatch = batchIdFor(product, 'MRP 14.00')
    const sale = await sell(2, newBatch)

    expect(sale.line).toEqual({ rate: rupees(13), mrp: rupees(14), batch_id: newBatch })
    expect(sale.total).toBe(rupees(26))
    expect(await balances()).toEqual({ 'MRP 14.00': 3 })
  })

  it('sells the old packs at the old price, out of the old stock', async () => {
    const sale = await sell(2, UNBATCHED_PICK)
    expect(sale.line).toEqual({ rate: rupees(10), mrp: rupees(12), batch_id: null })
    // The new batch is untouched: the two packs came off the old shelf.
    expect(await balances()).toEqual({ 'MRP 14.00': 5 })
  })

  it('keeps the batch on a held bill brought back', async () => {
    const newBatch = batchIdFor(product, 'MRP 14.00')
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: product, qty: fromUnits(1), batchId: newBatch }],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error(draft.code)
    const held = await loadDraft(fx.db, draft.billId)
    expect(held?.lines[0]).toMatchObject({ batchId: newBatch, rate: rupees(13) })
  })

  it('refuses a rate sent as the shop’s that is not the batch’s', async () => {
    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{
        productId: product, qty: fromUnits(1), batchId: batchIdFor(product, 'MRP 14.00'),
        resolved: { rate: rupees(10), source: 'base_rate', sourceId: null },
      }],
      actorId: fx.adminId,
    })
    expect(draft).toMatchObject({ ok: false, code: 'RATE_NOT_THE_RULE', rule: rupees(13) })
  })
})

describe('price choices, without a database', () => {
  const item = { mrp: rupees(12), rate: rupees(10) }
  const priced = (batchNo: string, units: number, mrp: Money | null, expiryDate: string | null = null): PricedBatch =>
    ({ batchId: batchNo, batchNo, expiryDate, balance: fromUnits(units), mrp, rate: null })

  it('makes batches at one price one choice, sold soonest expiry first', () => {
    const choices = priceChoices(
      [priced('LATE', 2, rupees(14), '2099-01-31'), priced('EARLY', 3, rupees(14), '2098-01-31')],
      QTY_ZERO, item,
    )
    expect(choices).toHaveLength(1)
    expect(choices[0]).toMatchObject({ pick: 'EARLY', batchNos: ['EARLY', 'LATE'], rate: rupees(10) })
    expect(toUnits(choices[0]!.balance)).toBe(5)
  })

  it('takes the stock without a batch first when that is what was picked', () => {
    const plan = allocate([priced('NEW', 5, rupees(14))], fromUnits(3), fromUnits(4), {
      today: '2026-10-08', pick: UNBATCHED_PICK,
    })
    expect(toUnits(plan.unbatched)).toBe(3)
    expect(plan.takes.map((t) => [t.batchId, toUnits(t.qty)])).toEqual([['NEW', 1]])
  })
})

describe('cash handed over (070)', () => {
  async function draft() {
    await receive([{ qty: fromUnits(10) }])
    const bill = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: product, qty: fromUnits(3) }],
      actorId: fx.adminId,
    })
    if (!bill.ok) throw new Error(bill.code)
    return bill
  }

  it('is recorded beside the cash tender, and only the bill’s amount is taken', async () => {
    const bill = await draft()
    const done = await submitBill(fx.db, {
      billId: bill.billId,
      payments: [{ method: 'cash', amount: bill.grandTotal, tendered: rupees(50) }],
      actorId: fx.adminId,
    })
    expect(done.ok).toBe(true)
    const row = await fx.db.get<{ amount: number; tendered: number }>(
      `SELECT amount, tendered FROM bill_payments WHERE bill_id = ?`, [bill.billId])
    expect(row).toEqual({ amount: rupees(30), tendered: rupees(50) })
  })

  it('is refused when it is less than the amount, or on a tender that is not cash', async () => {
    const bill = await draft()
    for (const payment of [
      { method: 'cash' as const, amount: bill.grandTotal, tendered: rupees(20) },
      { method: 'upi' as const, amount: bill.grandTotal, tendered: rupees(50) },
    ]) {
      const done = await submitBill(fx.db, { billId: bill.billId, payments: [payment], actorId: fx.adminId })
      expect(done).toMatchObject({ ok: false, code: 'INVALID_PAYMENT' })
    }
  })
})
