import { Quantity } from '@shopos/core'
import type { LadderRow } from '../../ui/LadderEditor'
import type { Side } from '../../ui/gstPair'

/*
 * A product as the form holds it while it is being typed: strings where the
 * shop types numbers, parsed only when it is saved.
 */

export interface BarcodeDraft {
  barcode: string
  label: string
}

export interface UnitDraft {
  saleUnit: string
  /** How many base units one of these is: a ream is 500 sheets. */
  baseUnits: string
}

export interface Draft {
  id: string | null
  name: string
  brand: string
  /** First is the primary — the one printed on a shelf tag and shown in lists. */
  barcodes: BarcodeDraft[]
  /** Bigger units this item also sells in. The base unit is not one of them. */
  units: UnitDraft[]
  categoryId: string
  /** The item this one is a version of, and what makes it different. */
  parentProductId: string
  variantLabel: string
  /** One rung per row: buy this many or more, pay this each. */
  ladder: LadderRow[]
  hsnCode: string
  /**
   * No GST on this item at all. Saved as a rate of nothing and no cess -- the
   * same as typing 0 -- so a bill, a return and the GST export read it exactly
   * as they read a 0% item; the tick only spares the shop the two boxes.
   */
  noGst: boolean
  taxPercent: string
  /** GST compensation cess, as a percentage. Blank is none. */
  cessPercent: string
  baseRate: string
  /** Which side of GST `baseRate` was typed on. Kept with it; see `prices.ts`. */
  rateSide: Side
  /** The printed price on the packet. Blank when there is none. */
  mrp: string
  /**
   * What one costs, before tax, per base unit (074). Blank is none. A default
   * for Stock In and purchase orders, never a valuation.
   */
  costPrice: string
  /** Which side of GST `costPrice` was typed on. */
  costSide: Side
  baseUnit: string
  discountBlocked: boolean
  loyaltyBlocked: boolean
  returnBlocked: boolean
  /**
   * Whether the shop counts this one.
   *
   * `products.is_stock_tracked` has been read since migration 001 — by
   * `checkAvailability`, which skips an untracked item entirely, and by the
   * reorder report, which leaves it out — and no screen ever wrote it. So every
   * item was counted whether or not it had a shelf, and a shop on the `block`
   * policy could not sell a delivery charge twice.
   *
   * It governs those two questions and no others. A sale still posts a stock
   * movement either way, so the ledger and the valuation are unchanged; what
   * stops is the counter refusing, and the item appearing on a list of things
   * to buy more of.
   */
  stockTracked: boolean
  /** The amount is typed at the counter on every sale: the loose item (068). */
  openPrice: boolean
  reorderLevel: string
  reorderQty: string
}

export const BLANK: Draft = {
  id: null, name: '', brand: '', barcodes: [{ barcode: '', label: '' }], units: [],
  categoryId: '', parentProductId: '', variantLabel: '', ladder: [], hsnCode: '', noGst: false, taxPercent: '12', cessPercent: '',
  baseRate: '', rateSide: 'with', mrp: '', costPrice: '', costSide: 'before', baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false,
  returnBlocked: false, stockTracked: true, openPrice: false,
  reorderLevel: '', reorderQty: '',
}

/** Blank means "not set", which is not the same as a level of zero. */
export function levelOf(raw: string): Quantity.Qty | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return Quantity.parseQty(trimmed)
}
