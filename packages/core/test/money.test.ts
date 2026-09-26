import { describe, it, expect } from 'vitest'
import { paise, rupees, parseMoney, add, sub, scale, allocate, format, toRupees, inWords } from '../src/money.js'

describe('money', () => {
  it('rejects non-integer paise', () => {
    expect(() => paise(10.5)).toThrow(/integer paise/)
  })

  it('converts rupees without float drift', () => {
    expect(rupees(0.1) + rupees(0.2)).toBe(rupees(0.3))
    expect(add(rupees(19.99), rupees(0.01))).toBe(rupees(20))
  })

  it('parses user input', () => {
    expect(parseMoney('1,234.50')).toBe(paise(123450))
    expect(parseMoney('₹12')).toBe(paise(1200))
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('abc')).toBeNull()
  })

  it('formats in Indian grouping', () => {
    expect(format(paise(123456789))).toBe('12,34,567.89')
  })

  it('round-trips rupees', () => {
    expect(toRupees(paise(12345))).toBe(123.45)
  })
})

describe('allocate', () => {
  it('never loses a paisa', () => {
    const parts = allocate(paise(100), [1, 1, 1])
    expect(parts).toHaveLength(3)
    expect(add(...parts)).toBe(paise(100))
  })

  it('distributes remainder to the largest fractions', () => {
    expect(allocate(paise(100), [1, 1, 1])).toEqual([34, 33, 33])
  })

  it('splits proportionally', () => {
    const parts = allocate(paise(1000), [3, 1])
    expect(parts).toEqual([750, 250])
  })

  it('handles zero weights by splitting evenly', () => {
    const parts = allocate(paise(10), [0, 0])
    expect(add(...parts)).toBe(paise(10))
  })

  it('handles negative totals (refunds)', () => {
    const parts = allocate(paise(-100), [1, 1, 1])
    expect(add(...parts)).toBe(paise(-100))
  })

  it('survives a fuzz of random splits', () => {
    for (let i = 0; i < 500; i++) {
      const total = paise(Math.floor(Math.random() * 1_000_000))
      const n = 1 + Math.floor(Math.random() * 8)
      const weights = Array.from({ length: n }, () => Math.random() * 100)
      expect(add(...allocate(total, weights))).toBe(total)
    }
  })
})

describe('scale', () => {
  it('rounds half away from zero', () => {
    expect(scale(paise(100), 0.125)).toBe(paise(13))
    expect(scale(paise(-100), 0.125)).toBe(paise(-13))
  })

  it('is exact for whole ratios', () => {
    expect(scale(paise(333), 3)).toBe(paise(999))
  })
})

describe('sub', () => {
  it('goes negative for refunds', () => {
    expect(sub(paise(100), paise(250))).toBe(paise(-150))
  })
})

describe('the amount in words', () => {
  it('spells a plain amount', () => {
    expect(inWords(rupees(1000))).toBe('Rupees One Thousand Only')
    expect(inWords(rupees(21))).toBe('Rupees Twenty One Only')
  })

  it('groups in lakhs and crores, not in millions', () => {
    expect(inWords(rupees(1_200_000))).toBe('Rupees Twelve Lakh Only')
    expect(inWords(rupees(25_000_000))).toBe('Rupees Two Crore Fifty Lakh Only')
    expect(inWords(rupees(123_456))).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only')
  })

  it('carries the paise', () => {
    expect(inWords(paise(125_050))).toBe('Rupees One Thousand Two Hundred Fifty and Fifty Paise Only')
  })

  it('says zero rather than nothing at all', () => {
    expect(inWords(paise(0))).toBe('Rupees Zero Only')
  })

  it('says so when the figure is a refund', () => {
    expect(inWords(paise(-15000))).toBe('Minus Rupees One Hundred Fifty Only')
  })

  it('ends in Only, so nothing can be added after it', () => {
    expect(inWords(rupees(7))).toMatch(/ Only$/)
  })
})

describe('parseMoney reads digits, not a float', () => {
  it('rounds a third decimal on the digit typed', () => {
    // 0.285 is 28.4999… as a float, which rounded to 28.
    expect(parseMoney('0.285')).toBe(29)
    expect(parseMoney('0.2849')).toBe(28)
    expect(parseMoney('-0.285')).toBe(-29)
  })

  it('takes the shapes a counter types', () => {
    expect(parseMoney('₹1,23,456.5')).toBe(12_345_650)
    expect(parseMoney('5.')).toBe(500)
    expect(parseMoney('.5')).toBe(50)
    expect(Object.is(parseMoney('-0'), 0)).toBe(true)
  })

  it('refuses what is not an amount', () => {
    for (const bad of ['', '.', '-', '1e5', '1.2.3', 'abc', '--1']) expect(parseMoney(bad)).toBeNull()
  })
})
