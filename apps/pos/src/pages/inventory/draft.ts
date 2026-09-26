import { Quantity } from '@shopos/core'
import type { LadderRow } from '../../ui/LadderEditor'

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
  taxPercent: string
  baseRate: string
  /** The printed price on the packet. Blank when there is none. */
  mrp: string
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
  reorderLevel: string
  reorderQty: string
}

export const BLANK: Draft = {
  id: null, name: '', brand: '', barcodes: [{ barcode: '', label: '' }], units: [],
  categoryId: '', parentProductId: '', variantLabel: '', ladder: [], hsnCode: '', taxPercent: '12',
  baseRate: '', mrp: '', baseUnit: 'piece', discountBlocked: false, loyaltyBlocked: false,
  returnBlocked: false, stockTracked: true,
  reorderLevel: '', reorderQty: '',
}

/** Blank means "not set", which is not the same as a level of zero. */
export function levelOf(raw: string): Quantity.Qty | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return Quantity.parseQty(trimmed)
}
