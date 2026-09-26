import { describe, it, expect } from 'vitest'
import {
  buildReceipt, visibleLines, previewLines, smallColumns, WIDTH, type ReceiptDoc,
} from '../src/domain/receipt.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

const doc: ReceiptDoc = {
  shop: {
    name: 'TRT Stationery',
    address: 'Perambalur 621212, Tamil Nadu',
    phone: '9047191778',
    gstin: '33ALNPJ1906G1ZC',
  },
  docNo: 'INV/MR/26-27/00023',
  postingDate: '2026-09-12',
  cashier: 'admin',
  customerName: 'Sri Vidya School',
  items: [
    { name: 'A4 Copier Paper 500 sheets', qty: fromUnits(2), saleUnit: 'ream', rate: rupees(340), lineTotal: rupees(680) },
    { name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece', rate: rupees(10), lineTotal: rupees(120), mrp: rupees(12) },
    { name: 'Calculator 12 digit', qty: fromUnits(1), saleUnit: 'piece', rate: rupees(650), lineTotal: rupees(650) },
  ],
  subtotal: rupees(1450),
  discount: rupees(0),
  taxableTotal: rupees(1280.36),
  cgst: rupees(84.82),
  sgst: rupees(84.82),
  igst: 0 as Money,
  grandTotal: rupees(1450),
  payments: [{ method: 'cash', amount: rupees(1450) }],
  pointsEarned: 14,
  pointsBalance: 198,
}


/**
 * Every printed line inside the columns its own face allows.
 *
 * The small print is set in font B, which fits a third more characters than
 * font A — so measuring it against the wide face's column count is measuring
 * with the wrong ruler, and would pass a line the printer will not take.
 */
function expectFitsPaper(receipt: string, columns: number) {
  for (const line of previewLines(receipt)) {
    const limit = line.small ? smallColumns(columns) : columns
    expect(line.text.length, `too wide for ${limit} columns: "${line.text}"`).toBeLessThanOrEqual(limit)
  }
}

describe('receipt width', () => {
  it('never exceeds 42 columns — a 43rd character wraps and breaks every column', () => {
    expectFitsPaper(buildReceipt(doc), WIDTH)
  })

  it('holds 42 columns even with a very long product name', () => {
    const long = {
      ...doc,
      items: [{
        name: 'Premium Extra Long Hardbound Ruled Register 800 Pages Deluxe Edition',
        qty: fromUnits(3), saleUnit: 'piece', rate: rupees(245), lineTotal: rupees(735),
      }],
    }
    expectFitsPaper(buildReceipt(long), WIDTH)
  })

  it('holds 42 columns on a large total', () => {
    const big = { ...doc, grandTotal: rupees(9_99_999.99), subtotal: rupees(9_99_999.99) }
    expectFitsPaper(buildReceipt(big), WIDTH)
  })

  it('draws separator rules at exactly the full width', () => {
    const lines = visibleLines(buildReceipt(doc))
    const rules = lines.filter((l) => /^[-=]+$/.test(l))
    expect(rules.length).toBeGreaterThan(2)
    for (const r of rules) expect(r.length).toBe(WIDTH)
  })
})

describe('receipt content', () => {
  it('opens with the printer reset and ends with a cut', () => {
    const out = buildReceipt(doc)
    expect(out.startsWith('\x1B@')).toBe(true)
    expect(out.endsWith('\x1DV\x01')).toBe(true)
  })

  it('carries the shop identity a GST bill needs', () => {
    const text = visibleLines(buildReceipt(doc)).join('\n')
    expect(text).toContain('GSTIN: 33ALNPJ1906G1ZC')
    expect(text).toContain('INV/MR/26-27/00023')
  })

  it('prints every line item', () => {
    const text = visibleLines(buildReceipt(doc)).join('\n')
    expect(text).toContain('A4 Copier Paper 500 sheets')
    expect(text).toContain('Ball Pen Blue')
    expect(text).toContain('Calculator 12 digit')
  })

  it('shows the saving only when MRP beats the selling price', () => {
    const text = visibleLines(buildReceipt(doc)).join('\n')
    expect(text).toContain('Save')
    // 12 pieces, ₹2 off each.
    expect(text).toContain('24.00')

    const noMrp = { ...doc, items: doc.items.map((i) => ({ ...i, mrp: null })) }
    expect(visibleLines(buildReceipt(noMrp)).join('\n')).not.toContain('Save')
  })

  it('counts the saving off the quantity, not off the line total', () => {
    /* The quantity used to be recovered by dividing the line total by the rate,
       which is the same number only on a line with no discount. Twelve pens at
       ₹10 with ₹20 off the line came out as ten pens, and the receipt told the
       customer they had saved ₹20 against MRP when they had saved ₹24. */
    const discounted: ReceiptDoc = {
      ...doc,
      items: [{
        name: 'Ball Pen Blue', qty: fromUnits(12), saleUnit: 'piece',
        rate: rupees(10), lineTotal: rupees(100), mrp: rupees(12),
      }],
    }
    expect(visibleLines(buildReceipt(discounted)).join('\n')).toContain('Save')
    expect(visibleLines(buildReceipt(discounted)).join('\n')).toContain('24.00')
  })

  it('prints a figure rather than NaN on a line given away', () => {
    // Money divided by money, where the money is zero. The receipt printed
    // `Save NaN` and the cashier had to explain it.
    const free: ReceiptDoc = {
      ...doc,
      items: [{
        name: 'Ruler 30cm', qty: fromUnits(2), saleUnit: 'piece',
        rate: 0 as Money, lineTotal: 0 as Money, mrp: rupees(15),
      }],
    }
    const text = visibleLines(buildReceipt(free)).join('\n')
    expect(text).not.toContain('NaN')
    expect(text).toContain('30.00')
  })

  it('breaks out the tax the way a tax invoice must', () => {
    const text = visibleLines(buildReceipt(doc)).join('\n')
    expect(text).toContain('Taxable value')
    expect(text).toContain('CGST')
    expect(text).toContain('SGST')
    expect(text).not.toContain('IGST')
  })

  it('prints IGST instead on an inter-state sale', () => {
    const inter = { ...doc, cgst: 0 as Money, sgst: 0 as Money, igst: rupees(169.64) }
    const text = visibleLines(buildReceipt(inter)).join('\n')
    expect(text).toContain('IGST')
    expect(text).not.toContain('CGST')
  })

  it('omits the discount line when nothing was taken off', () => {
    expect(visibleLines(buildReceipt(doc)).join('\n')).not.toContain('Discount')
    const discounted = { ...doc, discount: rupees(50) }
    expect(visibleLines(buildReceipt(discounted)).join('\n')).toContain('Discount')
  })

  it('lists each tender on a split payment', () => {
    const split = {
      ...doc,
      payments: [{ method: 'cash', amount: rupees(1000) }, { method: 'upi', amount: rupees(450) }],
    }
    const text = visibleLines(buildReceipt(split)).join('\n')
    expect(text).toContain('Cash')
    expect(text).toContain('UPI')
  })

  it('leaves loyalty out entirely when no points were earned', () => {
    const none = { ...doc, pointsEarned: 0 }
    expect(visibleLines(buildReceipt(none)).join('\n')).not.toContain('Points earned')
  })
})

describe('what the roll can print', () => {
  it('sends only characters a thermal printer has, one for one', () => {
    const odd = {
      ...doc,
      shop: { ...doc.shop, name: 'Sri Café — Stores' },
      customerName: 'முருகன்',
      footer: 'Thank you — it’s “fresh”',
    }
    const out = buildReceipt(odd)
    expect([...out].filter((c) => c.charCodeAt(0) > 126)).toEqual([])
    const text = visibleLines(out).join('\n')
    expect(text).toContain('Sri Cafe - Stores')
    expect(text).toContain('Thank you - it\'s "fresh"')
  })
})
