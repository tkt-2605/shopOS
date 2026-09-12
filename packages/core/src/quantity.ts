/**
 * Quantities are integers scaled by 10^4, in the product's base unit.
 * Floats here caused the original system's stock preflight to reject sales
 * of fractional-kg items it actually had in stock.
 */

export const QTY_SCALE = 10_000
const DECIMALS = 4

export type Qty = number & { readonly __qty: unique symbol }

export const QTY_ZERO = 0 as Qty

export function qty(scaled: number): Qty {
  if (!Number.isInteger(scaled)) throw new RangeError(`qty must be scaled integer, got ${scaled}`)
  if (!Number.isSafeInteger(scaled)) throw new RangeError(`qty out of safe range: ${scaled}`)
  return scaled as Qty
}

export function fromUnits(units: number): Qty {
  return qty(Math.round(units * QTY_SCALE))
}

export function parseQty(input: string): Qty | null {
  const cleaned = input.replace(/[,\s]/g, '')
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? fromUnits(n) : null
}

export function toUnits(q: Qty): number {
  return q / QTY_SCALE
}

export function addQty(...qs: Qty[]): Qty {
  return qty(qs.reduce<number>((a, b) => a + b, 0))
}

export function subQty(a: Qty, b: Qty): Qty {
  return qty(a - b)
}

export function negQty(q: Qty): Qty {
  return qty(-q)
}

export function cmpQty(a: Qty, b: Qty): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

export function isPositive(q: Qty): boolean {
  return q > 0
}

/** Exact, because both sides are integers. This is the stock preflight check. */
export function hasAtLeast(available: Qty, required: Qty): boolean {
  return available >= required
}

/** Converts a quantity expressed in a sale unit into base units. */
export function toBaseUnits(saleQty: Qty, baseUnitsPerSaleUnit: Qty): Qty {
  return qty(Math.round((saleQty * baseUnitsPerSaleUnit) / QTY_SCALE))
}

export function formatQty(q: Qty): string {
  const s = (q / QTY_SCALE).toFixed(DECIMALS)
  return s.replace(/\.?0+$/, '')
}
