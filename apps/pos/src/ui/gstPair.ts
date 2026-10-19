import { Money, Tax } from '@shopos/core'

/*
 * One amount shown two ways, before GST and with it, for a screen where the
 * person types whichever their paper gives them: a supplier's quote is often
 * before tax, a printed bill often with it. Whichever box was typed in is kept
 * exactly as typed; the other is worked out from it. Nothing to switch.
 *
 * The arithmetic is core's own -- `addTax` one way, `splitTax` the other -- so
 * a figure worked out here is the figure the service would work out. Intra-
 * state, as every screen's preview is: an inter-state supply comes to the same
 * total, split as IGST.
 */

export type Side = 'before' | 'with'

export interface Pair {
  /** What each box shows. The typed side is the text as typed. */
  before: string
  with: string
  /** The amount before GST, or null when what was typed is not an amount. */
  beforeValue: Money.Money | null
}

/** Basis points from a typed percentage, nothing for a blank or a typo. */
export function bpOf(percent: string): number {
  const n = Number(percent)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0
}

/** The typed amount on its side, the other side worked out at this GST and cess. */
export function pairOf(typed: string, side: Side, rateBp: number, cessBp: number): Pair {
  const value = Money.parseMoney(typed)
  if (value === null || value < 0) return { before: side === 'before' ? typed : '', with: side === 'with' ? typed : '', beforeValue: null }
  try {
    if (side === 'before') {
      const tax = Tax.addTax(value, rateBp, 'intra_state', cessBp).taxTotal
      return { before: typed, with: Money.format((value + tax) as Money.Money), beforeValue: value }
    }
    const before = Tax.splitTax(value, rateBp, 'intra_state', cessBp).taxableValue
    return { before: Money.format(before), with: typed, beforeValue: before }
  } catch {
    // A rate past what GST allows: say nothing on the other side rather than a wrong figure.
    return { before: side === 'before' ? typed : '', with: side === 'with' ? typed : '', beforeValue: side === 'before' ? value : null }
  }
}
