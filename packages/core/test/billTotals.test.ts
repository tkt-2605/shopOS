import { describe, it, expect } from 'vitest'
import { computeTotals, grossOf } from '../src/domain/billTotals.js'
import { rupees, paise, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'

const line = (rate: number, units: number, taxRateBp = 0, discount = 0) => ({
  qty: fromUnits(units),
  rate: rupees(rate),
  taxRateBp,
  discount: rupees(discount),
})

describe('bill totals', () => {
  it('adds up an empty bill to nothing', () => {
    const t = computeTotals([])
    expect(t).toMatchObject({ subtotal: 0, discount: 0, taxTotal: 0, grandTotal: 0 })
    expect(t.lines).toEqual([])
  })

  it('multiplies rate by quantity into the line total', () => {
    const t = computeTotals([line(340, 2)])
    expect(t.lines[0]!.gross).toBe(rupees(680))
    expect(t.subtotal).toBe(rupees(680))
    expect(t.grandTotal).toBe(rupees(680))
  })

  it('takes a line discount off before the subtotal', () => {
    const t = computeTotals([line(100, 3, 0, 50)])
    expect(t.lines[0]!.gross).toBe(rupees(300))
    expect(t.lines[0]!.lineTotal).toBe(rupees(250))
    expect(t.subtotal).toBe(rupees(250))
  })

  it('splits an inclusive tax out of what was paid', () => {
    const t = computeTotals([line(118, 1, 1800)])
    expect(t.taxableTotal).toBe(rupees(100))
    expect(t.taxTotal).toBe(rupees(18))
    expect(t.grandTotal).toBe(rupees(118))
    expect(t.taxableTotal + t.taxTotal).toBe(t.grandTotal)
  })

  it('charges tax on what was paid after a discount, not before', () => {
    const plain = computeTotals([line(118, 10, 1800)])
    const discounted = computeTotals([line(118, 10, 1800)], rupees(180))

    expect(plain.taxTotal).toBe(rupees(180))
    expect(discounted.grandTotal).toBe(rupees(1000))
    expect(discounted.taxTotal).toBeLessThan(plain.taxTotal)
    expect(discounted.taxableTotal + discounted.taxTotal).toBe(discounted.grandTotal)
  })

  it('spreads a bill discount across lines losing nothing', () => {
    const t = computeTotals([line(100, 1), line(100, 1), line(100, 1)], rupees(10))
    const shares = t.lines.map((l) => l.billDiscountShare)

    expect(shares.reduce((s, x) => s + x, 0)).toBe(rupees(10))
    expect(t.grandTotal).toBe(rupees(290))
    // A tenner across three lines cannot divide evenly; the odd paise still land.
    expect(shares).toEqual([paise(334), paise(333), paise(333)])
  })

  it('weights the discount by line size', () => {
    const t = computeTotals([line(900, 1), line(100, 1)], rupees(100))
    expect(t.lines[0]!.billDiscountShare).toBe(rupees(90))
    expect(t.lines[1]!.billDiscountShare).toBe(rupees(10))
  })

  /* The screen calls this while the cashier is mid-keystroke, so an over-large
     discount has to render as something sensible rather than throw. */
  it('clamps a discount larger than the bill and reports what it applied', () => {
    const t = computeTotals([line(100, 1)], rupees(500))
    expect(t.discount).toBe(rupees(100))
    expect(t.grandTotal).toBe(0)
  })

  it('ignores a negative discount', () => {
    const t = computeTotals([line(100, 1)], -5000 as Money)
    expect(t.discount).toBe(0)
    expect(t.grandTotal).toBe(rupees(100))
  })

  it('puts the whole tax in IGST on an inter-state sale', () => {
    const t = computeTotals([line(118, 1, 1800)], 0 as Money, 'inter_state')
    expect(t.lines[0]!.tax.igst).toBe(rupees(18))
    expect(t.lines[0]!.tax.cgst).toBe(0)
    expect(t.lines[0]!.tax.sgst).toBe(0)
  })

  it('handles a fractional quantity without losing a paisa', () => {
    const t = computeTotals([{ qty: fromUnits(2.5), rate: rupees(40), taxRateBp: 0 }])
    expect(t.grandTotal).toBe(rupees(100))
  })

  it('reconciles line by line against the bill total', () => {
    const t = computeTotals(
      [line(118, 3, 1800), line(105, 7, 500), line(50, 2, 0)],
      rupees(75),
    )
    expect(t.lines.reduce((s, l) => s + l.net, 0)).toBe(t.grandTotal)
    expect(t.lines.reduce((s, l) => s + l.tax.taxTotal, 0)).toBe(t.taxTotal)
    expect(t.lines.reduce((s, l) => s + l.billDiscountShare, 0)).toBe(t.discount)
    expect(t.subtotal - t.discount).toBe(t.grandTotal)
  })

  it('exposes the same multiplication the lines use', () => {
    expect(grossOf(rupees(12.5), fromUnits(4))).toBe(rupees(50))
  })
})

/* A shop sells mobile recharge, cigarettes and cooking gas at a few rupees a
   unit. A discount across the whole bill that lands on those lines is a loss,
   whether or not anyone meant to give it. */
describe('lines that may not be discounted', () => {
  const blocked = (rate: number, units: number, discount = 0) => ({
    ...line(rate, units, 0, discount),
    discountBlocked: true,
  })

  it('keeps a bill discount off the blocked line entirely', () => {
    const t = computeTotals([line(100, 1), blocked(100, 1)], rupees(20))

    expect(t.subtotal).toBe(rupees(200))
    expect(t.discountableSubtotal).toBe(rupees(100))
    expect(t.lines[0]!.billDiscountShare).toBe(rupees(20))
    expect(t.lines[1]!.billDiscountShare).toBe(0)
    expect(t.grandTotal).toBe(rupees(180))
  })

  it('drops a discount typed against a blocked line rather than showing one', () => {
    const t = computeTotals([blocked(100, 1, 30)])
    expect(t.lines[0]!.lineTotal).toBe(rupees(100))
    expect(t.grandTotal).toBe(rupees(100))
  })

  /* allocate() splits evenly when every weight is zero, which would put the
     discount straight onto the blocked lines. The clamp has to make that
     unreachable. */
  it('applies no discount at all to a bill of nothing but blocked lines', () => {
    const t = computeTotals([blocked(100, 1), blocked(50, 2)], rupees(30))
    expect(t.discountableSubtotal).toBe(0)
    expect(t.discount).toBe(0)
    expect(t.lines.every((l) => l.billDiscountShare === 0)).toBe(true)
    expect(t.grandTotal).toBe(rupees(200))
  })

  it('clamps a bill discount to the discountable part, not the subtotal', () => {
    const t = computeTotals([line(100, 1), blocked(900, 1)], rupees(500))
    expect(t.discount).toBe(rupees(100))
    expect(t.grandTotal).toBe(rupees(900))
  })

  /* The per-line figures are what goes on the invoice; they have to sum to it. */
  it('still loses nothing when the spread skips a line', () => {
    const t = computeTotals([line(33.33, 1), line(33.33, 1), blocked(33.34, 1)], paise(1000) as Money)
    const summed = t.lines.reduce((a, l) => a + l.net, 0)
    expect(summed).toBe(t.grandTotal)
    expect(t.lines[2]!.billDiscountShare).toBe(0)
  })
})
