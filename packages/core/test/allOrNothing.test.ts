import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBill, submitBill } from '../src/services/billing.js'
import { processReturn } from '../src/services/returns.js'
import { addVersions, splitIntoVersions } from '../src/services/variants.js'
import { createStockEntry, submitStockEntry } from '../src/services/stockEntry.js'
import { stockValue } from '../src/services/stock.js'
import {
  setUnits, setItemPrice, setLadder, setCustomerLadder, setUnitPrices, settleDoublePrice, listItemPrices,
} from '../src/services/pricing.js'
import { setFeature } from '../src/services/features.js'
import { defaultPriceListId } from '../src/repos/pricing.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'

/**
 * The four flows the atomicity audit of 13 Nov found could be left half-done,
 * each made to fail partway -- a temporary trigger that throws at the second
 * write -- and then looked at: nothing of the attempt may be left behind.
 * Before `allOrNothing` each of these left the first write standing.
 */

let fx: Fixture
let pen: string
let everyone: string
const ctx = () => ({ actorId: fx.adminId })

beforeEach(async () => {
  fx = await freshDb()
  pen = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
  everyone = (await defaultPriceListId(fx.db))!
})
afterEach(async () => { await fx.db.close() })

/** Throws on the write named, for this connection only. */
async function failOn(table: string, when: string, event = 'INSERT') {
  await fx.db.execute(`CREATE TEMP TRIGGER fail_here BEFORE ${event} ON ${table} FOR EACH ROW WHEN ${when}
    BEGIN SELECT RAISE(ABORT, 'failed partway'); END`)
}
const count = async (sql: string, args: string[] = []) => (await fx.db.get<{ n: number }>(sql, args))!.n

async function stockIn(productId: string, qty: number, cost: Money) {
  const e = await createStockEntry(fx.db, { entryType: 'opening', lines: [{ productId, qty: fromUnits(qty), unitCost: cost }], actorId: fx.adminId })
  if (!e.ok) throw new Error(e.code)
  await submitStockEntry(fx.db, { entryId: e.entryId, actorId: fx.adminId })
}

describe('a return taken in one step', () => {
  it('failing at submit leaves no draft on the bill and spends no number', async () => {
    await stockIn(pen, 10, rupees(5))
    const bill = await createBill(fx.db, { registerId: fx.seed.registerId, lines: [{ productId: pen, qty: fromUnits(2) }], actorId: fx.adminId })
    if (!bill.ok) throw new Error(bill.code)
    await submitBill(fx.db, { billId: bill.billId, payments: [{ method: 'cash', amount: rupees(20) }], actorId: fx.adminId })
    const item = (await fx.db.get<{ id: string }>('SELECT id FROM bill_items WHERE bill_id = ?', [bill.billId]))!
    const numbers = await fx.db.query('SELECT * FROM doc_sequences ORDER BY 1')

    await failOn('sales_returns', 'NEW.docstatus = 1', 'UPDATE')
    await expect(processReturn(fx.db, {
      billId: bill.billId, lines: [{ billItemId: item.id, qty: fromUnits(1) }], refundMethod: 'cash', actorId: fx.adminId,
    })).rejects.toThrow()

    expect(await count('SELECT count(*) AS n FROM sales_returns')).toBe(0)
    expect(await count('SELECT count(*) AS n FROM sales_return_items')).toBe(0)
    expect(await fx.db.query('SELECT * FROM doc_sequences ORDER BY 1')).toEqual(numbers)
  })
})

describe('old stock split onto variants', () => {
  it('failing at posting leaves no adjustment behind and the stock where it was', async () => {
    await stockIn(pen, 10, rupees(6))
    const made = await addVersions(fx.db, ctx(), { parentId: pen, labels: ['Blue'] })
    if (!made.ok) throw new Error(made.code)
    const before = await stockValue(fx.db, pen)

    await failOn('stock_entries', 'NEW.docstatus = 1', 'UPDATE')
    await expect(splitIntoVersions(fx.db, ctx(), { parentId: pen, lines: [{ productId: made.created[0]!.id, qty: fromUnits(4) }] }))
      .rejects.toThrow()

    expect(await count(`SELECT count(*) AS n FROM stock_entries WHERE reference = 'Split into variants'`)).toBe(0)
    expect(await stockValue(fx.db, pen)).toEqual(before)
  })
})

describe('a double price settled', () => {
  it('failing as the list rate comes off leaves the selling rate as it was', async () => {
    await setItemPrice(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rate: rupees(9) })
    await failOn('item_prices', 'NEW.deleted_at IS NOT NULL', 'UPDATE')
    await fx.db.execute(`CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON item_prices BEGIN SELECT RAISE(ABORT, 'failed partway'); END`)

    await expect(settleDoublePrice(fx.db, ctx(), { productId: pen, keep: 'list' })).rejects.toThrow()
    const row = await fx.db.get<{ base_rate: number }>('SELECT base_rate FROM products WHERE id = ?', [pen])
    expect(row!.base_rate).toBe(rupees(10))
  })
})

describe('a ladder saved', () => {
  const rungs = (pairs: [number, number][]) => pairs.map(([q, r]) => ({ minQty: fromUnits(q), rate: rupees(r) }))
  beforeEach(async () => { await setFeature(fx.db, ctx(), 'tieredPricing', true) })

  it('on a list: a rung failing partway leaves the old ladder whole', async () => {
    const first = await setLadder(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rungs: rungs([[10, 9], [20, 8]]) })
    expect(first.ok).toBe(true)
    const before = (await listItemPrices(fx.db, { productId: pen })).map((r) => [r.minQty, r.rate])

    await failOn('item_prices', `NEW.min_qty = ${fromUnits(50)}`)
    await expect(setLadder(fx.db, ctx(), { productId: pen, priceListId: everyone, saleUnit: 'piece', rungs: rungs([[10, 8.5], [50, 7]]) }))
      .rejects.toThrow()
    expect((await listItemPrices(fx.db, { productId: pen })).map((r) => [r.minQty, r.rate])).toEqual(before)
  })

  it("for one customer: the same", async () => {
    const customer = await makeCustomer(fx.db)
    await setCustomerLadder(fx.db, ctx(), { customerId: customer, productId: pen, saleUnit: 'piece', rungs: rungs([[10, 9], [20, 8]]) })
    const read = () => fx.db.query('SELECT min_qty, rate FROM customer_item_prices WHERE deleted_at IS NULL ORDER BY min_qty')
    const before = await read()

    await failOn('customer_item_prices', `NEW.min_qty = ${fromUnits(50)}`)
    await expect(setCustomerLadder(fx.db, ctx(), { customerId: customer, productId: pen, saleUnit: 'piece', rungs: rungs([[10, 8.5], [50, 7]]) }))
      .rejects.toThrow()
    expect(await read()).toEqual(before)
  })
})

describe("an item's unit prices saved", () => {
  it('the second unit failing leaves the first unit\'s new price unwritten, and no MRP moved', async () => {
    await setUnits(fx.db, ctx(), pen, [{ saleUnit: 'box', baseUnits: fromUnits(10) }, { saleUnit: 'pack', baseUnits: fromUnits(5) }])
    await failOn('item_prices', `NEW.sale_unit = 'pack'`)
    await expect(setUnitPrices(fx.db, ctx(), {
      productId: pen,
      units: [{ saleUnit: 'box', mrp: rupees(100), rate: rupees(90) }, { saleUnit: 'pack', mrp: rupees(50), rate: rupees(45) }],
    })).rejects.toThrow()

    expect(await count(`SELECT count(*) AS n FROM item_prices WHERE product_id = ? AND deleted_at IS NULL`, [pen])).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM product_units WHERE product_id = ? AND mrp IS NOT NULL`, [pen])).toBe(0)
  })
})
