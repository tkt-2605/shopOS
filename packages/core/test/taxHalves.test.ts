import { describe, it, expect } from 'vitest'
import { splitTax, addTax, BP_SCALE } from '../src/domain/tax.js'
import { paise, type Money } from '../src/money.js'

/**
 * CGST and SGST are the same number.
 *
 * They are two levies on one taxable value at one half-rate each, so there is no
 * arithmetic under which they differ. Before this file existed, they differed on
 * 29 of the 51 lines in the owner's real database — and the entire suite passed,
 * because not one test had ever compared the two halves to each other.
 *
 * That is the lesson worth keeping: the bug was not hard to see, it was never
 * looked at. Every assertion below is deliberately about a *relationship*
 * between outputs rather than a remembered constant, because a constant would
 * have been copied from the broken implementation.
 */

/** The rates an Indian shop actually charges, plus the two nobody remembers. */
const RATES = [0, 25, 300, 500, 1200, 1800, 2800]

/** Awkward on purpose: primes, and amounts whose half-rate lands on .5 */
const AMOUNTS = [1, 7, 99, 100, 1339, 1500, 3000, 5085, 30357, 34000, 99991, 1768000]

describe('an intra-state sale', () => {
  it('splits a tax-inclusive price into two equal halves, always', () => {
    for (const rateBp of RATES) {
      for (const total of AMOUNTS) {
        const tax = splitTax(paise(total), rateBp)
        expect(tax.cgst, `${total} @ ${rateBp}bp`).toBe(tax.sgst)
      }
    }
  })

  it('still adds up to the price on the shelf', () => {
    // The customer pays the marked price. Whatever rounding the halves force,
    // it is absorbed by the taxable value and never by the total.
    for (const rateBp of RATES) {
      for (const total of AMOUNTS) {
        const tax = splitTax(paise(total), rateBp)
        expect(tax.taxableValue + tax.cgst + tax.sgst, `${total} @ ${rateBp}bp`).toBe(total)
        expect(tax.taxTotal).toBe(tax.cgst + tax.sgst)
        expect(tax.igst).toBe(0)
      }
    }
  })

  it('keeps each half within a paisa of the half-rate on the taxable value', () => {
    // The equality must not have been bought by drifting away from the rate.
    for (const rateBp of RATES) {
      for (const total of AMOUNTS) {
        const tax = splitTax(paise(total), rateBp)
        const expected = (tax.taxableValue * (rateBp / 2)) / BP_SCALE
        expect(Math.abs(tax.cgst - expected), `${total} @ ${rateBp}bp`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('adds tax on top of an exclusive price in equal halves too', () => {
    for (const rateBp of RATES) {
      for (const taxable of AMOUNTS) {
        const tax = addTax(paise(taxable), rateBp)
        expect(tax.cgst, `${taxable} @ ${rateBp}bp`).toBe(tax.sgst)
        expect(tax.taxableValue).toBe(taxable)
        expect(tax.taxTotal).toBe(tax.cgst + tax.sgst)
      }
    }
  })
})

describe('the lines that were wrong in the shop', () => {
  /**
   * Taken from `bill_items` in the owner's database, where each of these was
   * stored with SGST one paisa above CGST.
   */
  const REAL: Array<{ lineTotal: number; rateBp: number; half: number }> = [
    { lineTotal: 34000, rateBp: 1200, half: 1821 }, // was 1821 / 1822
    { lineTotal: 6000, rateBp: 1800, half: 458 },   // was  457 /  458
    { lineTotal: 3000, rateBp: 1200, half: 161 },   // was  160 /  161
    { lineTotal: 3200, rateBp: 1200, half: 171 },   // was  171 /  172
    { lineTotal: 10000, rateBp: 1200, half: 536 },  // was  535 /  536
    { lineTotal: 9000, rateBp: 1800, half: 686 },   // was  686 /  687
    { lineTotal: 1500, rateBp: 1200, half: 80 },    // was   80 /   81
    { lineTotal: 8500, rateBp: 1800, half: 648 },   // was  648 /  649
  ]

  /* The agreed half is not always the lower of the two stored figures, and it
     is worth saying why: it is `round()` on the half-rate, so 6000 @ 18% gives
     457.65 and settles at 458 on both sides, where the old code had 457/458.
     Four of these eight round up and four round down. Anyone assuming the fix
     simply drops the odd paisa has the wrong model of it. */

  it('now charges the same on both halves', () => {
    for (const { lineTotal, rateBp, half } of REAL) {
      const tax = splitTax(paise(lineTotal), rateBp)
      expect(tax.cgst, `${lineTotal} @ ${rateBp}bp`).toBe(half)
      expect(tax.sgst, `${lineTotal} @ ${rateBp}bp`).toBe(half)
      expect(tax.taxableValue + 2 * half).toBe(lineTotal)
    }
  })

  it('moves the paisa into the taxable value, not out of the total', () => {
    // 34000 at 12%: the old code stored taxable 30357 and tax 3643 (1821+1822).
    // The new one stores taxable 30358 and tax 3642 (1821+1821). The shelf
    // price is untouched; what moved is which side of the line the paisa is on.
    const tax = splitTax(paise(34000), 1200)
    expect(tax.taxableValue).toBe(30358)
    expect(tax.taxTotal).toBe(3642)
  })
})

describe('an inter-state sale', () => {
  it('is one levy, so nothing has to be made even', () => {
    for (const rateBp of RATES) {
      for (const total of AMOUNTS) {
        const tax = splitTax(paise(total), rateBp, 'inter_state')
        expect(tax.cgst).toBe(0)
        expect(tax.sgst).toBe(0)
        expect(tax.taxableValue + tax.igst, `${total} @ ${rateBp}bp`).toBe(total)
      }
    }
  })

  it('keeps the exact back-derived taxable value', () => {
    /* IGST has no half to match, so forcing it to the even-tax rounding would
       make it wrong for no reason. The consequence is that one shelf price can
       have a taxable value a paisa apart depending on where the customer is,
       which is correct and is asserted here so nobody "fixes" it later. */
    const exact = Math.round((34000 * BP_SCALE) / (BP_SCALE + 1200))
    expect(splitTax(paise(34000), 1200, 'inter_state').taxableValue).toBe(exact)
    expect(splitTax(paise(34000), 1200, 'intra_state').taxableValue).toBe(exact + 1)
  })
})

describe('the edges', () => {
  it('charges nothing at a zero rate', () => {
    const tax = splitTax(paise(34000), 0)
    expect(tax.taxableValue).toBe(34000)
    expect(tax.taxTotal).toBe(0)
    expect(tax.cgst).toBe(tax.sgst)
  })

  it('never invents tax on a sale too small to carry any', () => {
    const tax = splitTax(paise(1), 1800)
    expect(tax.cgst).toBe(tax.sgst)
    expect(tax.taxableValue + tax.taxTotal).toBe(1)
  })

  it('refuses a rate that is not basis points', () => {
    expect(() => splitTax(paise(100), -1)).toThrow(RangeError)
    expect(() => splitTax(paise(100), 12.5)).toThrow(RangeError)
  })

  it('never returns a negative taxable value', () => {
    // The taxable value is `lineTotal − 2 × half`, so a rate high enough to
    // round the halves up past the price would invert it.
    for (const total of AMOUNTS) {
      const tax = splitTax(paise(total), 2800)
      expect(tax.taxableValue, `${total} @ 2800bp`).toBeGreaterThanOrEqual(0 as Money)
    }
  })
})
