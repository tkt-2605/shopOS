import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { splitTax, addTax } from '../src/domain/tax.js'
import { computeTotals } from '../src/domain/billTotals.js'
import { createBill, submitBill, amendBill, cancelBill } from '../src/services/billing.js'
import { processReturn } from '../src/services/returns.js'
import { createPriceList, setItemPrice, setCustomerPriceList } from '../src/services/pricing.js'
import { saveProductDetails } from '../src/services/products.js'
import { taxByRate, gstLines } from '../src/repos/reports/gst.js'
import { setSetting } from '../src/services/settings.js'
import { paise, rupees, type Money } from '../src/money.js'
import { fromUnits, QTY_SCALE, type Qty } from '../src/quantity.js'
import { freshDb, makeCustomer, type Fixture } from './helpers.js'

/**
 * GST compensation cess, and rates quoted before tax (migration 063).
 *
 * From the review of 4 October: nothing could hold a cess, so tobacco and
 * aerated drinks were taxed at the wrong rate or not at all; and every rate
 * was a shelf price, so a wholesaler's list -- quoted before GST -- could not
 * be billed without the cashier doing the arithmetic.
 */

const ONE = fromUnits(1)

describe('cess in the arithmetic', () => {
  it('changes nothing at all when there is none', () => {
    for (let total = 1; total < 50_000; total += 37) {
      for (const rate of [0, 500, 1200, 1800, 2800]) {
        const without = splitTax(paise(total), rate, 'intra_state')
        const withZero = splitTax(paise(total), rate, 'intra_state', 0)
        expect(withZero).toEqual(without)
        expect(withZero.cess).toBe(0)
      }
    }
  })

  it('backs GST and cess out of a shelf price together, and loses nothing', () => {
    // An aerated drink: 28% GST and 12% cess, ₹40 on the shelf.
    for (const supply of ['intra_state', 'inter_state'] as const) {
      const t = splitTax(rupees(40), 2800, supply, 1200)
      expect(t.taxableValue + t.cgst + t.sgst + t.igst + t.cess).toBe(rupees(40))
      expect(t.taxTotal).toBe(t.cgst + t.sgst + t.igst + t.cess)
      expect(t.cess).toBe(Math.round((t.taxableValue * 1200) / 10_000))
      if (supply === 'intra_state') expect(t.cgst).toBe(t.sgst)
    }
  })

  it('puts cess on top of a rate quoted before tax', () => {
    const t = addTax(rupees(100), 2800, 'intra_state', 1200)
    expect(t).toMatchObject({ taxableValue: rupees(100), cgst: rupees(14), sgst: rupees(14), cess: rupees(12) })
    expect(t.taxTotal).toBe(rupees(40))
  })
})

describe('a line quoted before tax', () => {
  const line = (rate: Money, rateIncludesTax: boolean) =>
    ({ qty: ONE as Qty, rate, taxRateBp: 1800, rateIncludesTax })

  it('adds the tax on top, and the customer pays rate plus tax', () => {
    const t = computeTotals([line(rupees(100), false)])
    expect(t.taxableTotal).toBe(rupees(100))
    expect(t.taxTotal).toBe(rupees(18))
    expect(t.taxAdded).toBe(rupees(18))
    expect(t.grandTotal).toBe(rupees(118))
    expect(t.lines[0]!.net).toBe(rupees(118))
  })

  it('takes a discount off before the tax, which is charged on what was charged', () => {
    const t = computeTotals([line(rupees(100), false)], rupees(10))
    expect(t.taxableTotal).toBe(rupees(90))
    expect(t.taxTotal).toBe(paise(1620))
    expect(t.grandTotal).toBe(paise(10_620))
  })

  it('sits beside a shelf price on one bill, each read the way it was quoted', () => {
    const t = computeTotals([line(rupees(118), true), line(rupees(100), false)])
    expect(t.lines.map((l) => l.net)).toEqual([rupees(118), rupees(118)])
    expect(t.lines[0]!.tax.taxableValue).toBe(rupees(100))
    expect(t.lines[1]!.tax.taxableValue).toBe(rupees(100))
    expect(t.taxAdded).toBe(rupees(18))
    expect(t.grandTotal).toBe(rupees(236))
  })

  it('is a shelf price when nothing says otherwise, which is every line before 063', () => {
    const t = computeTotals([{ qty: ONE as Qty, rate: rupees(118), taxRateBp: 1800 }])
    expect(t.grandTotal).toBe(rupees(118))
    expect(t.taxAdded).toBe(0)
  })
})

let fx: Fixture
beforeEach(async () => {
  fx = await freshDb()
  await setSetting(fx.db, 'shop_state_code', '33')
})
afterEach(async () => { await fx.db.close() })

const ctx = { get actorId(): string { return fx.adminId } }

async function product(input: { name: string; rate: Money; gst: number; cess?: number }): Promise<string> {
  const saved = await saveProductDetails(fx.db, ctx, {
    name: input.name, brand: null, hsnCode: '22021010', taxRateBp: input.gst,
    ...(input.cess !== undefined ? { cessRateBp: input.cess } : {}),
    baseRate: input.rate, mrp: null, baseUnit: 'piece',
    discountBlocked: false, loyaltyBlocked: false, returnBlocked: false, isStockTracked: false,
    reorderLevel: null, reorderQty: null,
  })
  if (!saved.ok) throw new Error(saved.code)
  return saved.productId
}

async function sell(productId: string, customerId?: string) {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId, lines: [{ productId, qty: ONE }],
    ...(customerId ? { customerId } : {}), actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error(draft.code)
  const done = await submitBill(fx.db, {
    billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(done.code)
  return draft
}

describe('a product with a cess, through a bill, a return and the GST export', () => {
  it('charges it, reverses it, and files it in its own column', async () => {
    const cola = await product({ name: 'Cola 300ml', rate: rupees(40), gst: 2800, cess: 1200 })
    const bill = await sell(cola)
    expect(bill.grandTotal).toBe(rupees(40))

    const line = await fx.db.get<{ id: string; cess_amount: number; cess_rate_bp: number; taxable_value: number }>(
      `SELECT id, cess_amount, cess_rate_bp, taxable_value FROM bill_items WHERE bill_id = ?`, [bill.billId])
    expect(line!.cess_rate_bp).toBe(1200)
    expect(line!.cess_amount).toBeGreaterThan(0)

    const sold = (await taxByRate(fx.db, { from: '0000-01-01', to: '9999-12-31' }))[0]!
    expect(sold.cess).toBe(line!.cess_amount)

    const ret = await processReturn(fx.db, {
      billId: bill.billId, lines: [{ billItemId: line!.id, qty: ONE }], refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error(ret.code)
    const after = (await taxByRate(fx.db, { from: '0000-01-01', to: '9999-12-31' }))[0]!
    expect(after.cess).toBe(0)
    expect(after.taxable).toBe(0)

    const export_ = await gstLines(fx.db, { from: '0000-01-01', to: '9999-12-31' })
    for (const row of export_) {
      expect(row.total).toBe(row.taxable + row.cgst + row.sgst + row.igst + row.cess)
    }
  })

  it('is left alone by a save that does not mention it', async () => {
    const cola = await product({ name: 'Cola 300ml', rate: rupees(40), gst: 2800, cess: 1200 })
    await saveProductDetails(fx.db, ctx, {
      id: cola, name: 'Cola 300 ml', brand: null, hsnCode: '22021010', taxRateBp: 2800,
      baseRate: rupees(40), mrp: null, baseUnit: 'piece',
      discountBlocked: false, loyaltyBlocked: false, returnBlocked: false, isStockTracked: false,
      reorderLevel: null, reorderQty: null,
    })
    const row = await fx.db.get<{ cess_rate_bp: number }>(`SELECT cess_rate_bp FROM products WHERE id = ?`, [cola])
    expect(row!.cess_rate_bp).toBe(1200)
  })

  it('is not charged by a shop on the composition scheme, any more than GST is', async () => {
    await setSetting(fx.db, 'shop_tax_scheme', 'composition')
    const cola = await product({ name: 'Cola 300ml', rate: rupees(40), gst: 2800, cess: 1200 })
    const bill = await sell(cola)
    const line = await fx.db.get<{ cess_amount: number }>(
      `SELECT cess_amount FROM bill_items WHERE bill_id = ?`, [bill.billId])
    expect(line!.cess_amount).toBe(0)
    expect(bill.grandTotal).toBe(rupees(40))
  })
})

describe('a wholesale customer on a list quoted before tax', () => {
  async function wholesale(): Promise<{ customer: string; rice: string }> {
    const rice = await product({ name: 'Rice 25kg', rate: rupees(1300), gst: 500 })
    const list = await createPriceList(fx.db, ctx, { name: 'Wholesale', ratesIncludeTax: false })
    if (!list.ok) throw new Error(list.code)
    await setItemPrice(fx.db, ctx, { productId: rice, priceListId: list.priceListId, saleUnit: 'piece', rate: rupees(1000) })
    const customer = await makeCustomer(fx.db, 'Anand Stores')
    await setCustomerPriceList(fx.db, ctx, customer, list.priceListId)
    return { customer, rice }
  }

  it('pays the list rate plus GST, and the bill says the rate was before tax', async () => {
    const { customer, rice } = await wholesale()
    const bill = await sell(rice, customer)
    expect(bill.grandTotal).toBe(rupees(1050))
    const line = await fx.db.get<{ rate: number; taxable_value: number; line_total: number; rate_includes_tax: number }>(
      `SELECT rate, taxable_value, line_total, rate_includes_tax FROM bill_items WHERE bill_id = ?`, [bill.billId])
    expect(line).toEqual({ rate: rupees(1000), taxable_value: rupees(1000), line_total: rupees(1050), rate_includes_tax: 0 })
  })

  it('while a walk-in buying the same thing pays the shelf price', async () => {
    const { rice } = await wholesale()
    const bill = await sell(rice)
    expect(bill.grandTotal).toBe(rupees(1300))
  })

  it('keeps the line read before tax when the bill is cancelled and amended', async () => {
    const { customer, rice } = await wholesale()
    const bill = await sell(rice, customer)
    const cancelled = await cancelBill(fx.db, { billId: bill.billId, actorId: fx.adminId })
    expect(cancelled.ok).toBe(true)
    const amended = await amendBill(fx.db, { billId: bill.billId, actorId: fx.adminId })
    if (!amended.ok) throw new Error(amended.code)
    expect(amended.grandTotal).toBe(rupees(1050))
  })

  it('refunds what was paid, tax and all, on a return', async () => {
    const { customer, rice } = await wholesale()
    const bill = await sell(rice, customer)
    const line = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [bill.billId])
    const ret = await processReturn(fx.db, {
      billId: bill.billId, lines: [{ billItemId: line!.id, qty: ONE }], refundMethod: 'cash', actorId: fx.adminId,
    })
    if (!ret.ok) throw new Error(ret.code)
    const credit = await fx.db.get<{ refund_amount: number; taxable_value: number }>(
      `SELECT refund_amount, taxable_value FROM sales_return_items`)
    expect(credit).toEqual({ refund_amount: rupees(1050), taxable_value: rupees(1000) })
  })
})

// Kept so the QTY_SCALE import documents what ONE means.
void QTY_SCALE
