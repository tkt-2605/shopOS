import { describe, it, expect } from 'vitest'
import { Money } from '@shopos/core'
import { pairOf, bpOf } from '../src/ui/gstPair'
import { discountAmount } from '../src/core/billCarts'

/**
 * The edges of typing a cost either side of GST (`ui/gstPair.ts`) and of a
 * discount typed as rupees or a percentage (`discountAmount`).
 */

const value = (shown: string) => Money.parseMoney(shown.replace(/,/g, ''))

describe('one cost, either side of GST', () => {
  it('comes back to what was typed, within a paisa, when switched there and back', () => {
    for (const bp of [0, 500, 1200, 1800, 2800]) {
      for (const cess of [0, 1200]) {
        for (const typed of ['0.01', '1.00', '6.50', '99.99', '118.00', '1234.56']) {
          const withGst = pairOf(typed, 'before', bp, cess).with
          const back = pairOf(withGst, 'with', bp, cess).beforeValue
          expect(Math.abs((back ?? NaN) - (value(typed) ?? NaN))).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('shows the same figure both ways at no GST', () => {
    expect(pairOf('42.00', 'before', 0, 0)).toMatchObject({ before: '42.00', beforeValue: 4200 })
    expect(value(pairOf('42.00', 'before', 0, 0).with)).toBe(4200)
    expect(pairOf('42.00', 'with', 0, 0).beforeValue).toBe(4200)
  })

  it('keeps the typed text as typed and says nothing for a typo, a blank or a minus', () => {
    for (const typed of ['', 'abc', '-5', '1.2.3']) {
      const pair = pairOf(typed, 'with', 1800, 0)
      expect(pair).toEqual({ before: '', with: typed, beforeValue: null })
    }
  })

  it('reads a GST percentage as basis points, and nothing for a blank, a typo or below zero', () => {
    expect(bpOf('18')).toBe(1800)
    expect(bpOf('0.25')).toBe(25)
    expect(bpOf('')).toBe(0)
    expect(bpOf('x')).toBe(0)
    expect(bpOf('-5')).toBe(0)
  })
})

describe('a discount as rupees or a percentage', () => {
  it('reads past spaces around what was typed', () => {
    expect(discountAmount({ discount: ' 10 ', discountPercent: true }, 50000)).toBe(5000)
    expect(discountAmount({ discount: ' 10 ', discountPercent: false }, 50000)).toBe(1000)
  })

  it('takes nothing off for a blank, a zero or a percentage below zero', () => {
    for (const discount of ['', '0', '-10']) {
      expect(discountAmount({ discount, discountPercent: true }, 50000)).toBe(0)
    }
    expect(discountAmount({ discount: '', discountPercent: false }, 50000)).toBe(0)
  })

  it('takes everything off at a hundred percent and no more, and nothing off a bill with nothing to discount', () => {
    expect(discountAmount({ discount: '100', discountPercent: true }, 50000)).toBe(50000)
    expect(discountAmount({ discount: '50', discountPercent: true }, 0)).toBe(0)
  })

  it('rounds a percentage to the nearest paisa', () => {
    expect(discountAmount({ discount: '33.333', discountPercent: true }, 100)).toBe(33)
    expect(discountAmount({ discount: '7.5', discountPercent: true }, 999)).toBe(75)
  })
})
