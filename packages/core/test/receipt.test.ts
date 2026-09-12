import { describe, it, expect } from 'vitest'
import { buildReceipt, visibleLines, WIDTH, type ReceiptDoc } from '../src/domain/receipt.js'
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

describe('receipt width', () => {
  it('never exceeds 42 columns — a 43rd character wraps and breaks every column', () => {
    for (const line of visibleLines(buildReceipt(doc))) {
      expect(line.length, `too wide: "${line}"`).toBeLessThanOrEqual(WIDTH)
    }
  })

  it('holds 42 columns even with a very long product name', () => {
    const long = {
      ...doc,
      items: [{
        name: 'Premium Extra Long Hardbound Ruled Register 800 Pages Deluxe Edition',
        qty: fromUnits(3), saleUnit: 'piece', rate: rupees(245), lineTotal: rupees(735),
      }],
    }
    for (const line of visibleLines(buildReceipt(long))) {
      expect(line.length).toBeLessThanOrEqual(WIDTH)
    }
  })

  it('holds 42 columns on a large total', () => {
    const big = { ...doc, grandTotal: rupees(9_99_999.99), subtotal: rupees(9_99_999.99) }
    for (const line of visibleLines(buildReceipt(big))) {
      expect(line.length).toBeLessThanOrEqual(WIDTH)
    }
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
    expect(text).toContain('Upi')
  })

  it('leaves loyalty out entirely when no points were earned', () => {
    const none = { ...doc, pointsEarned: 0 }
    expect(visibleLines(buildReceipt(none)).join('\n')).not.toContain('Points earned')
  })
})
