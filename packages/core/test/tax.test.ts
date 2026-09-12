import { describe, it, expect } from 'vitest'
import { paise, rupees, add } from '../src/money.js'
import { splitTax, addTax, supplyTypeFor, percentToBp } from '../src/domain/tax.js'

describe('splitTax (tax-inclusive, the Indian retail case)', () => {
  it('reconciles exactly — taxable + cgst + sgst equals the line total', () => {
    const total = rupees(118)
    const t = splitTax(total, percentToBp(18))
    expect(add(t.taxableValue, t.cgst, t.sgst)).toBe(total)
    expect(t.taxableValue).toBe(rupees(100))
    expect(t.cgst).toBe(rupees(9))
    expect(t.sgst).toBe(rupees(9))
  })

  it('puts the odd paisa on CGST so the halves still sum to the tax total', () => {
    const t = splitTax(paise(10_501), percentToBp(5))
    expect(add(t.cgst, t.sgst)).toBe(t.taxTotal)
    expect(t.cgst + t.sgst).toBe(t.taxTotal)
    expect(Math.abs(t.cgst - t.sgst)).toBeLessThanOrEqual(1)
  })

  it('reconciles across every rate and a wide range of amounts', () => {
    for (const percent of [0, 0.25, 3, 5, 12, 18, 28]) {
      for (let p = 1; p <= 5000; p += 7) {
        const total = paise(p)
        const t = splitTax(total, percentToBp(percent))
        expect(add(t.taxableValue, t.cgst, t.sgst, t.igst)).toBe(total)
      }
    }
  })

  it('charges IGST instead of CGST/SGST on inter-state supply', () => {
    const total = rupees(118)
    const t = splitTax(total, percentToBp(18), 'inter_state')
    expect(t.igst).toBe(rupees(18))
    expect(t.cgst).toBe(0)
    expect(t.sgst).toBe(0)
    expect(add(t.taxableValue, t.igst)).toBe(total)
  })

  it('treats a zero rate as fully taxable value', () => {
    const t = splitTax(rupees(50), 0)
    expect(t.taxableValue).toBe(rupees(50))
    expect(t.taxTotal).toBe(0)
  })

  it('rejects a negative rate', () => {
    expect(() => splitTax(rupees(10), -100)).toThrow(/non-negative/)
  })
})

describe('addTax (tax-exclusive)', () => {
  it('adds tax on top', () => {
    const t = addTax(rupees(100), percentToBp(18))
    expect(t.taxTotal).toBe(rupees(18))
    expect(add(t.cgst, t.sgst)).toBe(t.taxTotal)
  })
})

describe('supplyTypeFor', () => {
  it('is intra-state when the codes match', () => {
    expect(supplyTypeFor('33', '33')).toBe('intra_state')
  })

  it('is inter-state when they differ', () => {
    expect(supplyTypeFor('33', '29')).toBe('inter_state')
  })

  it('defaults to intra-state when the customer state is unknown', () => {
    expect(supplyTypeFor('33', null)).toBe('intra_state')
  })
})
