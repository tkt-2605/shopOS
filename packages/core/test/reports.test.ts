import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rupees } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'
import { createBill, submitBill, cancelBill } from '../src/services/billing.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { postMovement } from '../src/services/stock.js'
import { newId } from '../src/ids.js'
import {
  salesSummary, salesByDay, topProducts, paymentMix, taxByRate, salesByStaff, gstLines, toCsv,
  grossMargin, marginByProduct,
} from '../src/repos/reports.js'
import { freshDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

let fx: Fixture

beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

const ALL = { from: '2026-01-01', to: '2026-12-31' }

async function stockUp(db: SqlDriver, productId: string, units: number): Promise<void> {
  await db.transaction(async (tx) => {
    await postMovement(tx, {
      productId,
      qtyChange: fromUnits(units),
      unitCost: rupees(50),
      voucherType: 'opening',
      voucherId: newId(),
      postingDate: '2026-01-01',
    })
  })
}

async function sell(
  productId: string,
  units: number,
  opts: { date?: string; method?: 'cash' | 'upi' | 'card'; customerId?: string } = {},
): Promise<string> {
  const draft = await createBill(fx.db, {
    registerId: fx.seed.registerId,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    ...(opts.date ? { postingDate: opts.date } : {}),
    lines: [{ productId, qty: fromUnits(units) }],
    actorId: fx.adminId,
  })
  if (!draft.ok) throw new Error('draft failed')

  const done = await submitBill(fx.db, {
    billId: draft.billId,
    payments: [{ method: opts.method ?? 'cash', amount: draft.grandTotal }],
    actorId: fx.adminId,
  })
  if (!done.ok) throw new Error(`submit failed: ${done.code}`)
  return draft.billId
}

describe('sales reporting', () => {
  it('counts only submitted bills — drafts and cancellations are not sales', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, p, 100)

    await sell(p, 1, { date: '2026-03-01' })
    const cancelled = await sell(p, 1, { date: '2026-03-01' })
    await cancelBill(fx.db, { billId: cancelled, actorId: fx.adminId, reason: 'test' })
    await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId: p, qty: fromUnits(5) }],
      actorId: fx.adminId,
    })

    const summary = await salesSummary(fx.db, ALL)
    expect(summary.bills).toBe(1)
    expect(summary.total).toBe(rupees(118))
  })

  it('splits the total into taxable value and tax, and they add back up', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, p, 100)
    await sell(p, 3, { date: '2026-03-01' })

    const s = await salesSummary(fx.db, ALL)
    expect(s.taxable).toBe(rupees(300))
    expect(s.tax).toBe(rupees(54))
    expect(s.taxable + s.tax + s.roundOff).toBe(s.total)
  })

  it('subtracts refunds from the net, and only from the day they were made', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    const billId = await sell(p, 4, { date: '2026-03-01' })

    const line = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [billId])
    const ret = await createReturn(fx.db, {
      billId,
      lines: [{ billItemId: line!.id, qty: fromUnits(1) }],
      refundMethod: 'cash',
      actorId: fx.adminId,
      now: new Date('2026-03-05T10:00:00Z'),
    })
    if (!ret.ok) throw new Error('return failed')
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId, now: new Date('2026-03-05T10:00:00Z') })

    const s = await salesSummary(fx.db, ALL)
    expect(s.total).toBe(rupees(400))
    expect(s.returns).toBe(rupees(100))
    expect(s.net).toBe(rupees(300))

    const days = await salesByDay(fx.db, ALL)
    const sale = days.find((d) => d.date === '2026-03-01')!
    expect(sale.returns).toBe(0)
    expect(sale.net).toBe(rupees(400))

    // The day of the return has no sale, and is still a row: the rows add up to the summary.
    const refundDay = days.find((d) => d.date === '2026-03-05')
    expect(refundDay).toMatchObject({ bills: 0, returns: rupees(100), net: -rupees(100) })
    expect(days.reduce((sum, d) => sum + d.net, 0)).toBe(s.net)
  })

  it('honours the date range at both ends', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    await sell(p, 1, { date: '2026-03-01' })
    await sell(p, 1, { date: '2026-03-31' })
    await sell(p, 1, { date: '2026-04-01' })

    const march = await salesSummary(fx.db, { from: '2026-03-01', to: '2026-03-31' })
    expect(march.bills).toBe(2)
  })

  it('scopes to one counter when asked', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    await sell(p, 1, { date: '2026-03-01' })

    const other = newId()
    const now = new Date().toISOString()
    await fx.db.execute(
      `INSERT INTO registers (id, name, prefix, created_at, updated_at) VALUES (?, 'Second', 'SC', ?, ?)`,
      [other, now, now],
    )

    expect((await salesSummary(fx.db, { ...ALL, registerId: fx.seed.registerId })).bills).toBe(1)
    expect((await salesSummary(fx.db, { ...ALL, registerId: other })).bills).toBe(0)
  })

  it('ranks products by base quantity, not by whatever unit was billed', async () => {
    const box = await makeProduct(fx.db, { name: 'Pen Box', baseRate: rupees(100), taxRateBp: 0 })
    const other = await makeProduct(fx.db, { name: 'Register', baseRate: rupees(60), taxRateBp: 0 })
    await stockUp(fx.db, box, 100)
    await stockUp(fx.db, other, 100)

    await sell(box, 3, { date: '2026-03-01' })
    await sell(box, 2, { date: '2026-03-02' })
    await sell(other, 4, { date: '2026-03-02' })

    const rows = await topProducts(fx.db, ALL)
    expect(rows[0]!.name).toBe('Pen Box')
    expect(rows[0]!.revenue).toBe(rupees(500))
    expect(toUnits(rows[0]!.qty)).toBe(5)
    expect(rows[0]!.bills).toBe(2)
    expect(rows[1]!.name).toBe('Register')
  })

  it('reports the tender mix a drawer count has to match', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    await sell(p, 2, { date: '2026-03-01', method: 'cash' })
    await sell(p, 3, { date: '2026-03-01', method: 'upi' })

    const mix = await paymentMix(fx.db, ALL)
    expect(mix.map((m) => m.method)).toEqual(['upi', 'cash'])
    expect(mix.find((m) => m.method === 'cash')!.amount).toBe(rupees(200))
    expect(mix.reduce((s, m) => s + m.amount, 0)).toBe(rupees(500))
  })

  it('groups tax the way a GST return is filed — rate by rate', async () => {
    const five = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(105), taxRateBp: 500 })
    const eighteen = await makeProduct(fx.db, { name: 'Calculator', baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, five, 100)
    await stockUp(fx.db, eighteen, 100)
    await sell(five, 2, { date: '2026-03-01' })
    await sell(eighteen, 1, { date: '2026-03-01' })

    const rows = await taxByRate(fx.db, ALL)
    expect(rows.map((r) => r.rateBp)).toEqual([500, 1800])
    expect(rows[0]!.taxable).toBe(rupees(200))
    expect(rows[0]!.cgst + rows[0]!.sgst).toBe(rupees(10))
    expect(rows[1]!.cgst + rows[1]!.sgst).toBe(rupees(18))

    const summary = await salesSummary(fx.db, ALL)
    expect(rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0)).toBe(summary.tax)
  })

  it('attributes each bill to whoever billed it', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    await sell(p, 2, { date: '2026-03-01' })

    const rows = await salesByStaff(fx.db, ALL)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.username).toBe('admin')
    expect(rows[0]!.total).toBe(rupees(200))
  })

  it('emits one GST line per bill per rate, carrying the customer GSTIN', async () => {
    const five = await makeProduct(fx.db, { baseRate: rupees(105), taxRateBp: 500 })
    const eighteen = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await stockUp(fx.db, five, 100)
    await stockUp(fx.db, eighteen, 100)

    const customerId = await makeCustomer(fx.db, 'Sri Vidya School')
    await fx.db.execute(`UPDATE customers SET gstin = '33ALNPJ1906G1ZC' WHERE id = ?`, [customerId])

    const draft = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      customerId,
      postingDate: '2026-03-01',
      lines: [
        { productId: five, qty: fromUnits(1) },
        { productId: eighteen, qty: fromUnits(1) },
      ],
      actorId: fx.adminId,
    })
    if (!draft.ok) throw new Error('draft failed')
    await submitBill(fx.db, {
      billId: draft.billId,
      payments: [{ method: 'cash', amount: draft.grandTotal }],
      actorId: fx.adminId,
    })

    const lines = await gstLines(fx.db, ALL)
    expect(lines).toHaveLength(2)
    expect(new Set(lines.map((l) => l.docNo)).size).toBe(1)
    expect(lines.every((l) => l.gstin === '33ALNPJ1906G1ZC')).toBe(true)
    expect(lines.map((l) => l.rateBp)).toEqual([500, 1800])
    expect(lines.reduce((s, l) => s + l.total, 0)).toBe(rupees(223))
  })

  it('names an unidentified buyer rather than leaving the column blank', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await stockUp(fx.db, p, 100)
    await sell(p, 1, { date: '2026-03-01' })

    const lines = await gstLines(fx.db, ALL)
    expect(lines[0]!.customerName).toBe('Walk-in')
    expect(lines[0]!.gstin).toBe('')
  })

  it('reads back as an empty report rather than throwing when nothing sold', async () => {
    const s = await salesSummary(fx.db, ALL)
    expect(s).toMatchObject({ bills: 0, total: 0, net: 0, averageBill: 0 })
    expect(await salesByDay(fx.db, ALL)).toEqual([])
    expect(await topProducts(fx.db, ALL)).toEqual([])
  })
})

describe('csv', () => {
  it('quotes a field containing a comma and doubles an embedded quote', async () => {
    const csv = toCsv(['name', 'amount'], [['Pen, blue', 100], ['6" ruler', 20]])
    expect(csv).toBe('name,amount\r\n"Pen, blue",100\r\n"6"" ruler",20\r\n')
  })

  it('leaves an ordinary field alone', async () => {
    expect(toCsv(['a'], [['plain']])).toBe('a\r\nplain\r\n')
  })
})

describe('gross margin', () => {
  it('compares revenue and cost on the same basis — both without GST', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(118), taxRateBp: 1800 })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(50), unitCost: rupees(60),
        voucherType: 'stock_entry', voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    await sell(p, 10, { date: '2026-03-01' })

    const m = await grossMargin(fx.db, ALL)
    expect(m.revenue).toBe(rupees(1000))
    expect(m.cost).toBe(rupees(600))
    expect(m.margin).toBe(rupees(400))
    expect(m.marginBp).toBe(4000)
    expect(m.uncostedLines).toBe(0)
  })

  it('takes returned goods back out of both revenue and cost', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(50), unitCost: rupees(40),
        voucherType: 'stock_entry', voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    const billId = await sell(p, 10, { date: '2026-03-01' })
    const line = await fx.db.get<{ id: string }>(`SELECT id FROM bill_items WHERE bill_id = ?`, [billId])
    const ret = await createReturn(fx.db, {
      billId, lines: [{ billItemId: line!.id, qty: fromUnits(4) }],
      refundMethod: 'cash', actorId: fx.adminId, now: new Date('2026-03-02T10:00:00Z'),
    })
    if (!ret.ok) throw new Error('return failed')
    await submitReturn(fx.db, { returnId: ret.returnId, actorId: fx.adminId, now: new Date('2026-03-02T10:00:00Z') })

    const m = await grossMargin(fx.db, ALL)
    expect(m.revenue).toBe(rupees(600))
    expect(m.cost).toBe(rupees(240))
    expect(m.margin).toBe(rupees(360))
  })

  it('says plainly how many lines it could not cost', async () => {
    const p = await makeProduct(fx.db, { baseRate: rupees(100), taxRateBp: 0 })
    // Opening stock with no cost recorded — the shop never told us what it paid.
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: p, qtyChange: fromUnits(20),
        voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
      })
    })
    await sell(p, 5, { date: '2026-03-01' })

    const m = await grossMargin(fx.db, ALL)
    expect(m.revenue).toBe(rupees(500))
    expect(m.cost).toBe(0)
    expect(m.uncostedLines).toBe(1)
  })

  it('ranks products by what they actually earn, not by what they sell for', async () => {
    const cheapFast = await makeProduct(fx.db, { name: 'Pen', baseRate: rupees(10), taxRateBp: 0 })
    const dearSlow = await makeProduct(fx.db, { name: 'Calculator', baseRate: rupees(600), taxRateBp: 0 })
    await fx.db.transaction(async (tx) => {
      await postMovement(tx, {
        productId: cheapFast, qtyChange: fromUnits(500), unitCost: rupees(2),
        voucherType: 'stock_entry', voucherId: newId(), postingDate: '2026-01-01',
      })
      await postMovement(tx, {
        productId: dearSlow, qtyChange: fromUnits(10), unitCost: rupees(560),
        voucherType: 'stock_entry', voucherId: newId(), postingDate: '2026-01-01',
      })
    })

    await sell(cheapFast, 200, { date: '2026-03-01' })
    await sell(dearSlow, 2, { date: '2026-03-01' })

    const rows = await marginByProduct(fx.db, ALL)
    // The calculator brings in more money; the pens make more of it.
    expect(rows[0]!.name).toBe('Pen')
    expect(rows[0]!.margin).toBe(rupees(1600))
    expect(rows[0]!.marginBp).toBe(8000)
    expect(rows[1]!.name).toBe('Calculator')
    expect(rows[1]!.margin).toBe(rupees(80))
  })

  it('is empty rather than wrong when nothing sold', async () => {
    const m = await grossMargin(fx.db, ALL)
    expect(m).toEqual({ revenue: 0, cost: 0, margin: 0, marginBp: 0, uncostedLines: 0 })
    expect(await marginByProduct(fx.db, ALL)).toEqual([])
  })
})
