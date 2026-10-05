import { type Money, add, paise, sub, ZERO } from '../money.js'

/**
 * Indian GST on tax-inclusive retail prices: the shelf price includes tax, so the
 * taxable value is back-derived from it.
 *
 * Rates are basis points (18% = 1800) and every figure is integer paise, so
 * taxable + cgst + sgst reconciles to the line total exactly — no residual paise
 * to chase at filing time.
 *
 * ## The two halves are equal, and that is what decides the rounding
 *
 * CGST and SGST are separate levies — the CGST Act and the State Act — imposed
 * on the *same* taxable value at the *same* half of the notified rate. They
 * cannot differ. An invoice reading CGST 1821 and SGST 1822 is facially wrong,
 * and GSTR-1's rate-wise summary will not reconcile against a recomputed half.
 *
 * This file used to compute the total tax and then split it, giving the odd
 * paisa to one side. On the owner's own database that produced unequal halves
 * on **29 of 51 lines**. (The comment even claimed the paisa went to CGST while
 * the code gave it to SGST, which is how long it had gone unread.)
 *
 * So each half is derived from the taxable value, and the leftover paisa is
 * absorbed by the quantity that is actually derived. For an inclusive shelf
 * price that is the taxable value, not the tax: the customer pays the price on
 * the shelf, so `lineTotal` is fixed and `taxable = lineTotal − 2 × half`.
 * Both invariants then hold at once — the halves are equal, and the three
 * figures still sum to what was charged.
 *
 * Inter-state is not subject to the evenness constraint, because IGST is one
 * levy and has no half to match. It keeps the exact rounding, which means the
 * taxable value for a given shelf price can differ by a paisa between an
 * intra-state and an inter-state sale. That is correct: the alternative is
 * making IGST wrong to match a constraint that does not apply to it.
 *
 * ## Cess
 *
 * GST compensation cess is charged on the same taxable value as GST, at its own
 * rate, and filed in its own column. On an inclusive price it is backed out
 * together with GST -- the shelf price includes both -- and then worked out on
 * the taxable value exactly as each GST half is. With a cess of zero every
 * figure is what it was before cess existed.
 */

export const BP_SCALE = 10_000

export type SupplyType = 'intra_state' | 'inter_state'

export interface TaxBreakdown {
  taxableValue: Money
  /** GST and cess together: what the line carries on top of its taxable value. */
  taxTotal: Money
  cgst: Money
  sgst: Money
  igst: Money
  cess: Money
  rateBp: number
  cessRateBp: number
}

export function splitTax(
  lineTotal: Money,
  rateBp: number,
  supply: SupplyType = 'intra_state',
  cessRateBp = 0,
): TaxBreakdown {
  assertRate(rateBp)
  assertRate(cessRateBp)

  if ((rateBp === 0 && cessRateBp === 0) || lineTotal === 0) {
    return untaxed(lineTotal, rateBp, cessRateBp)
  }

  const backDerived = paise(Math.round((lineTotal * BP_SCALE) / (BP_SCALE + rateBp + cessRateBp)))
  const cess = cessOn(backDerived, cessRateBp)

  if (supply === 'inter_state') {
    const igst = sub(sub(lineTotal, backDerived), cess)
    return {
      taxableValue: backDerived, taxTotal: add(igst, cess),
      cgst: ZERO, sgst: ZERO, igst, cess, rateBp, cessRateBp,
    }
  }

  /* Each half from the taxable value at half the rate, then the taxable value
     re-derived from what the two halves actually came to. The order matters:
     halving a rounded total is what produced 1821/1822. */
  const half = halfOf(backDerived, rateBp)
  const taxTotal = add(paise(half * 2), cess)
  const taxableValue = sub(lineTotal, taxTotal)
  return { taxableValue, taxTotal, cgst: half, sgst: half, igst: ZERO, cess, rateBp, cessRateBp }
}

function untaxed(value: Money, rateBp: number, cessRateBp: number): TaxBreakdown {
  return {
    taxableValue: value, taxTotal: ZERO, cgst: ZERO, sgst: ZERO, igst: ZERO, cess: ZERO, rateBp, cessRateBp,
  }
}

/** Cess on a taxable value, rounded the way each GST half is. */
function cessOn(taxableValue: Money, cessRateBp: number): Money {
  return paise(Math.round((taxableValue * cessRateBp) / BP_SCALE))
}

/**
 * One half of the tax on `taxableValue`, which is both CGST and SGST.
 *
 * `rateBp / 2` rather than halving the result: 12% of 30357 is 3642.84, and
 * rounding that to 3643 before halving is the whole bug. 6% of 30357 is
 * 1821.42, which rounds to 1821 on both sides.
 */
function halfOf(taxableValue: Money, rateBp: number): Money {
  return paise(Math.round((taxableValue * (rateBp / 2)) / BP_SCALE))
}

/** For a tax-exclusive rate, where tax is added on top. */
export function addTax(
  taxableValue: Money,
  rateBp: number,
  supply: SupplyType = 'intra_state',
  cessRateBp = 0,
): TaxBreakdown {
  assertRate(rateBp)
  assertRate(cessRateBp)

  if ((rateBp === 0 && cessRateBp === 0) || taxableValue === 0) {
    return untaxed(taxableValue, rateBp, cessRateBp)
  }

  const cess = cessOn(taxableValue, cessRateBp)

  if (supply === 'inter_state') {
    const igst = paise(Math.round((taxableValue * rateBp) / BP_SCALE))
    return {
      taxableValue, taxTotal: add(igst, cess), cgst: ZERO, sgst: ZERO, igst, cess, rateBp, cessRateBp,
    }
  }

  /* The easier of the two: `taxableValue` is given, so nothing has to absorb a
     leftover paisa — the total is simply whatever the two equal halves add to. */
  const half = halfOf(taxableValue, rateBp)
  return {
    taxableValue, taxTotal: add(paise(half * 2), cess), cgst: half, sgst: half, igst: ZERO, cess, rateBp, cessRateBp,
  }
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
