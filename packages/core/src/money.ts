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
