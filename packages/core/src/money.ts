/**
 * All money is integer paise. Never a float — the POS compares totals for equality
 * and reconciles drawer counts, and 0.1 + 0.2 in a till is a support call.
 */

export type Money = number & { readonly __money: unique symbol }

export const ZERO = 0 as Money

export function paise(n: number): Money {
  if (!Number.isInteger(n)) throw new RangeError(`money must be integer paise, got ${n}`)
  if (!Number.isSafeInteger(n)) throw new RangeError(`money out of safe range: ${n}`)
  return n as Money
}

export function rupees(n: number): Money {
  return paise(Math.round(n * 100))
}

/** Parses user input: "1,234.50", "1234.5", "₹12". Returns null if unparseable. */
export function parseMoney(input: string): Money | null {
  const cleaned = input.replace(/[₹,\s]/g, '')
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? rupees(n) : null
}

export function toRupees(m: Money): number {
  return m / 100
}

export function add(...ms: Money[]): Money {
  return paise(ms.reduce<number>((a, b) => a + b, 0))
}

export function sub(a: Money, b: Money): Money {
  return paise(a - b)
}

export function neg(m: Money): Money {
  return paise(-m)
}

export function isZero(m: Money): boolean {
  return m === 0
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

export function max(a: Money, b: Money): Money {
  return a >= b ? a : b
}

export function min(a: Money, b: Money): Money {
  return a <= b ? a : b
}

/** Multiply by a plain ratio, rounding half away from zero. */
export function scale(m: Money, ratio: number): Money {
  if (!Number.isFinite(ratio)) throw new RangeError(`ratio must be finite, got ${ratio}`)
  return paise(roundHalfAwayFromZero(m * ratio))
}

/**
 * Splits an amount into parts proportional to `weights`, losing nothing.
 * Remainder paise go to the largest fractional parts first, so the result
 * always sums back to `total` exactly. Used for return proration and any
 * per-line apportionment.
 */
export function allocate(total: Money, weights: number[]): Money[] {
  if (weights.length === 0) return []
  if (weights.some((w) => w < 0)) throw new RangeError('weights must be non-negative')

  const weightTotal = weights.reduce((a, b) => a + b, 0)
  if (weightTotal === 0) {
    const even = distributeEvenly(total, weights.length)
    return even
  }

  const exact = weights.map((w) => (total * w) / weightTotal)
  const floors = exact.map((e) => Math.trunc(e))
  let remainder = total - floors.reduce((a, b) => a + b, 0)

  const order = exact
    .map((e, i) => ({ i, frac: Math.abs(e - Math.trunc(e)) }))
    .sort((a, b) => b.frac - a.frac)

  const out = [...floors]
  const step = remainder >= 0 ? 1 : -1
  let cursor = 0
  while (remainder !== 0) {
    const target = order[cursor % order.length]
    if (target === undefined) break
    out[target.i] = (out[target.i] ?? 0) + step
    remainder -= step
    cursor++
  }

  return out.map((n) => paise(n))
}

function distributeEvenly(total: Money, count: number): Money[] {
  const base = Math.trunc(total / count)
  const out = new Array<number>(count).fill(base)
  let remainder = total - base * count
  const step = remainder >= 0 ? 1 : -1
  let i = 0
  while (remainder !== 0) {
    out[i % count] = (out[i % count] ?? 0) + step
    remainder -= step
    i++
  }
  return out.map((n) => paise(n))
}

function roundHalfAwayFromZero(n: number): number {
  return n >= 0 ? Math.round(n) : -Math.round(-n)
}

const INR = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function format(m: Money): string {
  return INR.format(toRupees(m))
}

export function formatWithSymbol(m: Money): string {
  return `₹${format(m)}`
}

/* --------------------------------------------------------- words --- */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** Under a thousand, which is as far as any single Indian group goes. */
function underThousand(n: number): string {
  if (n === 0) return ''
  if (n < 20) return ONES[n]!
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]!}` : '')
  return `${ONES[Math.floor(n / 100)]!} Hundred` + (n % 100 ? ` ${underThousand(n % 100)}` : '')
}

/**
 * A whole number in Indian words: crore, lakh, thousand, hundred.
 *
 * Not the western grouping. Twelve lakh is not "one point two million" on an
 * invoice a shop hands a customer in Tamil Nadu, and a figure in words exists
 * precisely so that the two readings cannot differ.
 */
export function numberInWords(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `Minus ${numberInWords(-n)}`
  if (n === 0) return 'Zero'

  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const rest = n % 1000

  if (crore > 0) parts.push(`${numberInWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${underThousand(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${underThousand(thousand)} Thousand`)
  if (rest > 0) parts.push(underThousand(rest))

  return parts.join(' ')
}

/**
 * The amount spelled out, the way an invoice spells it.
 *
 * The figure in words is not decoration. It is the line a customer and a shop
 * fall back on when the digits are argued about — a smudged 7, a 1 that could
 * be a 4 — which is why it carries the paise too, and why it ends in "Only":
 * nothing can be added after it.
 */
export function inWords(m: Money): string {
  const negative = m < 0
  const total = Math.abs(Math.round(m))
  const whole = Math.floor(total / 100)
  const fraction = total % 100

  const rupeesPart = `Rupees ${numberInWords(whole)}`
  const paisePart = fraction > 0 ? ` and ${numberInWords(fraction)} Paise` : ''

  return `${negative ? 'Minus ' : ''}${rupeesPart}${paisePart} Only`
}
