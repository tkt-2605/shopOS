import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { reorderList, bySupplier } from '../src/repos/reorder.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { createSupplier } from '../src/services/suppliers.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'
import { newId } from '../src/ids.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const NOW = new Date('2026-09-13T10:00:00')

async function stockUp(db: SqlDriver, productId: string, units: number, cost = 5000): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: cost as Money,
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

async function setReorder(productId: string, level: number, orderQty?: number): Promise<void> {
  await fx.db.execute(
    `UPDATE products SET reorder_level = ?, reorder_qty = ? WHERE id = ?`,
    [fromUnits(level), orderQty === undefined ? null : fromUnits(orderQty), productId],
  )
}

async function sell(productId: string, units: number, postingDate = '2026-09-10'): Promise<string> {
  const bill = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    lines: [{ productId, qty: fromUnits(units) }],
    postingDate,
    actorId: fx.adminId,
  })
  if (!bill.ok) throw new Error(bill.code)
  await submitBill(fx.db, {
    billId: bill.billId,
    payments: [{ method: 'cash', amount: bill.grandTotal }],
    actorId: fx.adminId,
    now: new Date(`${postingDate}T12:00:00`),
  })
  return bill.billId
}

async function supplier(name: string): Promise<{ id: string; name: string }> {
  const created = await createSupplier(fx.db, { name, actorId: fx.adminId })
  if (!created.ok) throw new Error(created.code)
  return { id: created.supplierId, name }
}

async function buy(
  productId: string, units: number, rate: Money,
  from: { id: string; name: string }, on: string,
): Promise<void> {
  const entry = await createStockEntry(fx.db, {
    entryType: 'purchase',
    postingDate: on,
    supplierId: from.id,
    supplierName: from.name,
    lines: [{ productId, qty: fromUnits(units), unitCost: rate }],
    actorId: fx.adminId,
  })
  if (!entry.ok) throw new Error(entry.code)
  await submitStockEntry(fx.db, { entryId: entry.entryId, actorId: fx.adminId })
}

describe('what appears on the buying list', () => {
  it('is what has fallen to its reorder level', async () => {
    const low = await makeProduct(fx.db, { name: 'Milk' })
    const fine = await makeProduct(fx.db, { name: 'Candles' })
    await stockUp(fx.db, low, 4)
    await stockUp(fx.db, fine, 40)
    await setReorder(low, 5)
    await setReorder(fine, 5)

    const rows = await reorderList(fx.db, { now: NOW })
    expect(rows.map((r) => r.name)).toEqual(['Milk'])
  })

  it('includes an item sitting exactly on the line', async () => {
    const p = await makeProduct(fx.db, { name: 'Exactly at the level' })
    await stockUp(fx.db, p, 5)
    await setReorder(p, 5)
    expect((await reorderList(fx.db, { now: NOW })).map((r) => r.name)).toEqual(['Exactly at the level'])
  })

  /* A list built from every product a shop has ever sold is noise nobody reads
     twice. Only what the owner marked appears. */
  it('leaves out what has no reorder level set', async () => {
    const p = await makeProduct(fx.db, { name: 'Never marked' })
    await stockUp(fx.db, p, 3)
    await sell(p, 3)
    expect(await reorderList(fx.db, { now: NOW })).toHaveLength(0)
  })

  it('can be asked for what is out of stock regardless', async () => {
    const p = await makeProduct(fx.db, { name: 'Out, never marked' })
    await stockUp(fx.db, p, 3)
    await sell(p, 3)

    expect(await reorderList(fx.db, { now: NOW })).toHaveLength(0)
    const rows = await reorderList(fx.db, { now: NOW, includeOutOfStock: true })
    expect(rows.map((r) => r.name)).toEqual(['Out, never marked'])
  })

  it('leaves out what is not stock-tracked and what is retired', async () => {
    const service = await makeProduct(fx.db, { name: 'Recharge' })
    const retired = await makeProduct(fx.db, { name: 'Discontinued' })
    await fx.db.execute(`UPDATE products SET is_stock_tracked = 0 WHERE id = ?`, [service])
    await fx.db.execute(`UPDATE products SET is_active = 0 WHERE id = ?`, [retired])
    await setReorder(service, 5)
    await setReorder(retired, 5)

    expect(await reorderList(fx.db, { now: NOW })).toHaveLength(0)
  })
})

describe('how much to order', () => {
  it('is the fixed quantity when the distributor sells in cases', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 2)
    await setReorder(p, 5, 24)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(toUnits(row!.suggestedQty)).toBe(24)
  })

  it('is the reorder level when nothing fixed is set', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 2)
    await setReorder(p, 10)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(toUnits(row!.suggestedQty)).toBe(10)
  })

  it('covers the hole as well when the shelf has gone negative', async () => {
    const p = await makeProduct(fx.db)
    await fx.db.execute(
      `INSERT INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, ?, 0, ?)`,
      [p, fromUnits(-3), new Date().toISOString()],
    )
    await setReorder(p, 10)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(toUnits(row!.suggestedQty)).toBe(13)
  })
})

describe('deciding, not just listing', () => {
  it('says what has been selling, in base units', async () => {
    const p = await makeProduct(fx.db, { name: 'Pens' })
    await stockUp(fx.db, p, 30)
    await sell(p, 18)
    await setReorder(p, 20)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(toUnits(row!.soldRecently)).toBe(18)
  })

  it('does not count what came back as sold', async () => {
    const p = await makeProduct(fx.db, { name: 'Returned' })
    await stockUp(fx.db, p, 30)
    const billId = await sell(p, 10)
    const item = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [billId])
    await fx.db.execute(`UPDATE bill_items SET returned_qty = ? WHERE id = ?`, [fromUnits(4), item!.id])
    await setReorder(p, 25)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(toUnits(row!.soldRecently)).toBe(6)
  })

  it('ignores sales older than the window', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 30)
    await sell(p, 12, '2026-05-01')
    await setReorder(p, 40)

    const [row] = await reorderList(fx.db, { now: NOW, windowDays: 30 })
    expect(toUnits(row!.soldRecently)).toBe(0)
    expect(row!.daysOfCover).toBeNull()
  })

  it('works out how many days are left at that rate', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 60)
    await sell(p, 30)
    await setReorder(p, 100)

    const [row] = await reorderList(fx.db, { now: NOW, windowDays: 30 })
    // Thirty sold in thirty days is one a day; thirty left is thirty days.
    expect(toUnits(row!.onHand)).toBe(30)
    expect(row!.daysOfCover).toBe(30)
  })

  it('names who it was last bought from, and at what price', async () => {
    const p = await makeProduct(fx.db)
    const older = await supplier('Old Agency')
    const recent = await supplier('Sakthi Agencies')
    await buy(p, 10, rupees(40), older, '2026-03-01')
    await buy(p, 10, rupees(46), recent, '2026-08-20')
    await setReorder(p, 50)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(row!.lastSupplierName).toBe('Sakthi Agencies')
    expect(row!.lastPurchaseRate).toBe(rupees(46))
    expect(row!.lastPurchasedOn).toBe('2026-08-20')
  })

  it('says nothing rather than guessing when it has never been bought', async () => {
    const p = await makeProduct(fx.db)
    await stockUp(fx.db, p, 1)
    await setReorder(p, 5)

    const [row] = await reorderList(fx.db, { now: NOW })
    expect(row!.lastSupplierName).toBeNull()
    expect(row!.lastPurchaseRate).toBeNull()
  })
})

describe('grouping the list the way an order is placed', () => {
  it('puts one call per distributor, and the unknowns last', async () => {
    const a = await makeProduct(fx.db, { name: 'From Sakthi' })
    const b = await makeProduct(fx.db, { name: 'Also from Sakthi' })
    const c = await makeProduct(fx.db, { name: 'Never bought' })
    const sakthi = await supplier('Sakthi Agencies')

    await buy(a, 2, rupees(10), sakthi, '2026-09-01')
    await buy(b, 2, rupees(10), sakthi, '2026-09-01')
    await stockUp(fx.db, c, 1)
    for (const p of [a, b, c]) await setReorder(p, 20)

    const groups = bySupplier(await reorderList(fx.db, { now: NOW }))
    expect(groups).toHaveLength(2)
    expect(groups[0]!.supplierName).toBe('Sakthi Agencies')
    expect(groups[0]!.rows).toHaveLength(2)
    expect(groups[1]!.supplierId).toBeNull()
    expect(groups[1]!.rows.map((r) => r.name)).toEqual(['Never bought'])
  })
})
