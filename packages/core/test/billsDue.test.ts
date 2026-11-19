import { describe, it, expect } from 'vitest'
import { Receipt, joinSheets } from '../src/api/sales.js'
import type { Money } from '../src/money.js'
import { fromUnits, toUnits } from '../src/quantity.js'

/*
 * A list of a customer's unpaid bills with one total: a reference, never a
 * document. These hold the two things it promises -- only bills with
 * something owing get on it, and the total is what they still owe.
 */

const m = (paise: number) => paise as Money
const bill = (billId: string, postingDate: string, creditTotal: number, allocated: number) => ({
  billId, docNo: `INV-${billId}`, postingDate,
  creditTotal: m(creditTotal), allocated: m(allocated), outstanding: m(creditTotal - allocated),
})

const open = [
  bill('3', '2026-11-10', 30_000, 0),
  bill('1', '2026-11-01', 50_000, 20_000),
  bill('2', '2026-11-05', 10_000, 10_000),
]

describe('bills due', () => {
  it('lists only what was ticked, oldest first, and totals what is still owed', () => {
    const due = Receipt.billsDue(open, ['3', '1'])
    expect(due.bills.map((b) => b.billId)).toEqual(['1', '3'])
    expect(due.total).toBe(60_000)
  })

  it('leaves off a ticked bill that has been paid off', () => {
    expect(Receipt.billsDue(open, ['2']).bills).toEqual([])
    expect(Receipt.billsDue(open, ['2', '3']).total).toBe(30_000)
  })

  it('leaves off a ticked bill that is no longer open at all', () => {
    expect(Receipt.billsDue(open, ['gone', '3']).bills.map((b) => b.billId)).toEqual(['3'])
  })

  const item = (productId: string, productName: string, units: number, lineTotal: number, returned = 0) => ({
    productId, productName, saleUnit: 'piece', qty: fromUnits(units), lineTotal: m(lineTotal), returnedQty: fromUnits(returned),
  })

  it('adds the same item at the same price into one line, and keeps another price apart', () => {
    const lines = Receipt.combinedItems([
      { items: [item('pen', 'Pen', 10, 10_000), item('book', 'Book', 2, 8_000)] },
      { items: [item('pen', 'Pen', 5, 5_000, 1), item('pen', 'Pen', 3, 2_700)] },
    ])
    expect(lines.map((l) => [l.name, toUnits(l.qty), l.each, l.amount, toUnits(l.returnedQty)])).toEqual([
      ['Pen', 15, 1_000, 15_000, 1],
      ['Book', 2, 4_000, 8_000, 0],
      ['Pen', 3, 900, 2_700, 0],
    ])
  })

  it('prints one long bill: every item, what was paid, the total due and the bills it came from', () => {
    const due = Receipt.billsDue(open, ['1', '3'])
    const items = Receipt.combinedItems([
      { items: [item('pen', 'Pen', 40, 40_000), item('book', 'Book', 2, 10_000)] },
      { items: [item('pen', 'Pen', 30, 30_000)] },
    ])
    const lines = Receipt.visibleLines(Receipt.buildBillsDue({
      shop: { name: 'TRT Stationery', address: null, phone: null, gstin: null },
      customerName: 'Meena Stores', customerCode: 'C-7', customerPhone: null,
      asAt: '2026-11-18', bills: due.bills, items, billsTotal: m(80_000), total: due.total,
    }))
    expect(lines.some((l) => l.includes('BILLS DUE'))).toBe(true)
    expect(lines.some((l) => l.includes('70 piece x 10.00') && l.includes('700.00'))).toBe(true)
    expect(lines.some((l) => l.includes('2 piece x 50.00') && l.includes('100.00'))).toBe(true)
    expect(lines.some((l) => l.includes('Items') && l.includes('800.00'))).toBe(true)
    expect(lines.some((l) => l.includes('Discount and round off'))).toBe(false)
    expect(lines.some((l) => l.includes('Paid and returned') && l.includes('200.00'))).toBe(true)
    expect(lines.some((l) => l.includes('TOTAL DUE') && l.includes('600.00'))).toBe(true)
    expect(lines.some((l) => l.includes('INV-1') && l.includes('INV-3'))).toBe(true)
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('not a new bill. Nothing was sold or taken from stock.')
  })
})

describe('several invoices as one document', () => {
  const sheet = (n: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${n}</title><style>@page { size: A4; }</style></head><body><table class="page">${n}</table></body></html>`

  it('keeps one head and starts each later invoice on a new page', () => {
    const html = joinSheets([sheet('INV-1'), sheet('INV-2'), sheet('INV-3')], 'Meena Stores, 3 invoices')
    expect(html.match(/<head>/g)).toHaveLength(1)
    expect(html.match(/<body>/g)).toHaveLength(1)
    expect(html).toContain('<title>Meena Stores, 3 invoices</title>')
    expect(html).toContain('@page { size: A4; }')
    expect(html.match(/break-before: page/g)).toHaveLength(2)
    expect(html.indexOf('INV-1</table>')).toBeLessThan(html.indexOf('INV-2</table>'))
    expect(html.indexOf('INV-2</table>')).toBeLessThan(html.indexOf('INV-3</table>'))
  })

  it('is empty when there is nothing to join', () => {
    expect(joinSheets([], 'none')).toBe('')
  })
})
