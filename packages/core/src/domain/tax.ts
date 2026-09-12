import { type Money, paise, sub, ZERO } from '../money.js'

/**
 * Indian GST on tax-inclusive retail prices: the shelf price includes tax, so the
 * taxable value is back-derived from it.
 *
 * Rates are basis points (18% = 1800) and every figure is integer paise, so
 * taxable + cgst + sgst reconciles to the line total exactly — no residual paise
 * to chase at filing time.
 */

export const BP_SCALE = 10_000

export type SupplyType = 'intra_state' | 'inter_state'

export interface TaxBreakdown {
  taxableValue: Money
  taxTotal: Money
  cgst: Money
  sgst: Money
  igst: Money
  rateBp: number
}

export function splitTax(lineTotal: Money, rateBp: number, supply: SupplyType = 'intra_state'): TaxBreakdown {
  assertRate(rateBp)

  if (rateBp === 0 || lineTotal === 0) {
    return { taxableValue: lineTotal, taxTotal: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, rateBp }
  }

  const taxableValue = paise(Math.round((lineTotal * BP_SCALE) / (BP_SCALE + rateBp)))
  const taxTotal = sub(lineTotal, taxableValue)

  if (supply === 'inter_state') {
    return { taxableValue, taxTotal, cgst: ZERO, sgst: ZERO, igst: taxTotal, rateBp }
  }

  // Half each, with the odd paise on CGST so the pair always sums to taxTotal.
  const cgst = paise(Math.trunc(taxTotal / 2))
  const sgst = sub(taxTotal, cgst)
  return { taxableValue, taxTotal, cgst, sgst, igst: ZERO, rateBp }
}

/** For a tax-exclusive rate, where tax is added on top. */
export function addTax(taxableValue: Money, rateBp: number, supply: SupplyType = 'intra_state'): TaxBreakdown {
  assertRate(rateBp)

  if (rateBp === 0 || taxableValue === 0) {
    return { taxableValue, taxTotal: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, rateBp }
  }

  const taxTotal = paise(Math.round((taxableValue * rateBp) / BP_SCALE))

  if (supply === 'inter_state') {
    return { taxableValue, taxTotal, cgst: ZERO, sgst: ZERO, igst: taxTotal, rateBp }
  }

  const cgst = paise(Math.trunc(taxTotal / 2))
  const sgst = sub(taxTotal, cgst)
  return { taxableValue, taxTotal, cgst, sgst, igst: ZERO, rateBp }
}

export function supplyTypeFor(supplierStateCode: string | null, customerStateCode: string | null): SupplyType {
  if (!supplierStateCode || !customerStateCode) return 'intra_state'
  return supplierStateCode === customerStateCode ? 'intra_state' : 'inter_state'
}

export function percentToBp(percent: number): number {
  return Math.round(percent * 100)
}

export function bpToPercent(bp: number): number {
  return bp / 100
}

function assertRate(rateBp: number): void {
  if (!Number.isInteger(rateBp) || rateBp < 0) {
    throw new RangeError(`tax rate must be non-negative basis points, got ${rateBp}`)
  }
}
