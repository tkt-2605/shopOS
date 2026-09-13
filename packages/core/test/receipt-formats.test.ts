import { describe, it, expect } from 'vitest'
import { buildReceipt, buildReceiptWithFormat, visibleLines } from '../src/domain/receipt.js'
import { THERMAL_DEFAULT } from '../src/domain/docFormat.js'
import { rupees } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import type { ReceiptDoc } from '../src/domain/receipt.js'

const sampleDoc: ReceiptDoc = {
  shop: {
    name: 'Test Shop',
    address: '123 Main St',
    phone: '98765 43210',
    gstin: '12AB C D E F 0001',
  },
  docNo: 'INV/001',
  postingDate: '2026-01-15',
  cashier: 'Ravi',
  customerName: 'Raj Kumar',
  items: [
    {
      name: 'Apples',
      qty: fromUnits(2),
      saleUnit: 'kg',
      rate: rupees(100),
      lineTotal: rupees(200),
    },
  ],
  subtotal: rupees(200),
  discount: rupees(0),
  taxableTotal: rupees(200),
  cgst: rupees(18),
  sgst: rupees(18),
  igst: rupees(0),
  grandTotal: rupees(236),
  payments: [{ method: 'cash', amount: rupees(236) }],
  footer: 'Thank you',
}

describe('receipt with formats', () => {
  it('builds a receipt using the default thermal format', () => {
    const receipt = buildReceiptWithFormat(sampleDoc, THERMAL_DEFAULT)
    const lines = visibleLines(receipt)

    expect(lines.some((l) => l.includes('Test Shop'))).toBe(true)
    expect(lines.some((l) => l.includes('INV/001'))).toBe(true)
    expect(receipt.length).toBeGreaterThan(0)
  })

  it('fits all lines within the thermal 58mm width (32 chars)', () => {
    const receipt = buildReceiptWithFormat(sampleDoc, THERMAL_DEFAULT)
    const lines = visibleLines(receipt)

    for (const line of lines) {
      if (line.trim()) {
        expect(line.length).toBeLessThanOrEqual(32)
      }
    }
  })

  it('disables blocks when they are turned off', () => {
    const noTermsFormat = {
      ...THERMAL_DEFAULT,
      blocks: THERMAL_DEFAULT.blocks.map((b) =>
        b.kind === 'terms' ? { ...b, on: false } : b,
      ),
    }

    const receipt = buildReceiptWithFormat(sampleDoc, noTermsFormat)

    expect(receipt.includes('Thank you')).toBe(false)
  })

  it('maintains backward compatibility with buildReceipt', () => {
    const legacy = buildReceipt(sampleDoc)
    const withFormat = buildReceiptWithFormat(sampleDoc, THERMAL_DEFAULT)

    expect(legacy.length).toBeGreaterThan(0)
    expect(withFormat.length).toBeGreaterThan(0)
  })
})
