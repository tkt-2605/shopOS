import type { Money } from '../../money.js'
import { type Qty, QTY_SCALE } from '../../quantity.js'
import type { DocWording } from '../wording.js'
import type { Raster } from './raster.js'

/*
 * What a printed document says, before anything decides how it looks.
 *
 * The roll, the A4 sheet and the preview all render this one shape, so it
 * lives apart from every renderer: the sheet's template engine reads it
 * without reaching into the roll's printer codes to get it.
 */

export interface ReceiptShop {
  name: string
  address?: string | null
  phone?: string | null
  /* Sheet-only: no block prints it, but a shop that writes its own A4 template
     can ask for it, and a token that resolves to nothing is a token that lies. */
  email?: string | null
  gstin?: string | null
  /**
   * The shop's mark, as a `data:` URI.
   *
   * The image itself rather than a path, because this module is pure and the
   * sheet it renders has to be printable from a browser tab and from the app
   * window alike — neither of which can be handed a filename and asked to go
   * and read it.
   */
  logo?: string | null
}

/** The shop's logo as the roll's dots, already reduced -- see `raster.ts`. */
export type { Raster }

export interface ReceiptItem {
  name: string
  qty: Qty
  saleUnit: string
  rate: Money
  lineTotal: Money
  mrp?: Money | null
  /** The batches the line came out of, already worded ("Batch B101 Exp 03/2027"). See `batchTextFor`. */
  batch?: string | null

  /* A sheet has room for a column per line that a 42-column roll does not, so
     these are optional: the thermal renderer never reads them, and the A4 one
     leaves the column out when they are absent. */
  hsnCode?: string | null
  taxableValue?: Money
  cgst?: Money
  sgst?: Money
  igst?: Money
  /** GST compensation cess on the line, when it carries one. */
  cess?: Money
  /**
   * False when `rate` was quoted before tax -- a wholesale rate. Absent or true
   * is a shelf price with the tax inside it. `lineTotal` has the tax in it
   * either way, so a reader adding the lines up never has to ask.
   */
  rateIncludesTax?: boolean
  /**
   * The rate this line was charged at, in basis points.
   *
   * Rule 46(k) asks the invoice to state the rate of tax per line, not only the
   * amount. A customer handed CGST 45.00 and SGST 45.00 against a taxable value
   * of 500.00 can work out that it was 18% between them; they should not have
   * to.
   */
  taxRateBp?: number
}

/**
 * Who the document was issued to, and where the supply was made.
 *
 * Rule 46(b), (e) and (f): an invoice carries the recipient's name, address and
 * GSTIN, and the place of supply along with the name of the state. The state
 * *name*, spelled out — an invoice that says "33" and nothing else satisfies
 * nobody reading it.
 *
 * Every one of these is optional and every one of them may be null, because a
 * counter sale to somebody who did not give a name is a real thing and the
 * document has to be printable anyway. What a renderer must never do is fill a
 * gap with a guess; see `supplyType`.
 */
export interface PlaceOfSupply {
  code: string
  name: string
}

/** One row of the rate-wise summary a sheet carries and a roll cannot. */
export interface RateSummaryRow {
  rateBp: number
  taxable: Money
  cgst: Money
  sgst: Money
  igst: Money
  /** Present only when some line at this rate carried a cess. */
  cess?: Money
}

export interface ReceiptDoc {
  shop: ReceiptShop
  docNo: string
  postingDate: string
  cashier?: string | null
  customerName?: string | null
  items: ReceiptItem[]
  subtotal: Money
  discount: Money
  taxableTotal: Money
  cgst: Money
  sgst: Money
  igst: Money
  /** GST compensation cess, totalled. Absent or zero prints nothing. */
  cess?: Money
  /**
   * The paise added or dropped to reach a round figure, signed.
   *
   * Printed on its own line whenever it is not zero, because a customer
   * comparing the lines to the total has to be able to find the difference.
   * Absent means a document raised before the shop had an answer, and prints
   * nothing — not a zero.
   */
  roundOff?: Money
  grandTotal: Money
  /** `tendered` is the cash handed over, when the counter asked; the roll prints the change. */
  payments: { method: string; amount: Money; tendered?: Money | null }[]
  pointsEarned?: number
  pointsBalance?: number
  footer?: string | null

  /* Sheet-only, for the same reason as the item fields above. */
  customerAddress?: string | null
  customerGstin?: string | null
  terms?: string | null

  /**
   * Where the supply was made, as a code and the name of that state.
   *
   * The recipient's details stay flat — `customerName`, `customerAddress`,
   * `customerGstin` — rather than being gathered into a `recipient` object as
   * the phase spec sketches it. They were already flat, the template tokens and
   * the thermal blocks already read them there, and a second name for the
   * customer alongside `customerName` is how two fields that mean one thing
   * start disagreeing.
   *
   * This one is a pair because it has to print as both: "Place of supply: 27 —
   * Maharashtra". It used to be the shop's own state, unconditionally, on every
   * invoice including the ones billed to another state.
   */
  placeOfSupply?: PlaceOfSupply | null
  /** The recipient's own state, which is not always where the supply happened. */
  customerState?: PlaceOfSupply | null

  /**
   * Which pair of taxes this document charged, as the bill recorded it.
   *
   * Passed rather than worked out from the amounts, because a bill of entirely
   * exempt goods carries no tax at all and there is nothing in the figures to
   * tell an exempt inter-state supply from an exempt local one. Absent means
   * the document predates the question, and the renderer leaves the columns
   * where they are rather than guessing.
   */
  supplyType?: 'intra_state' | 'inter_state'

  /**
   * Rule 46(p). Nothing in this product raises a bill under reverse charge, so
   * this is false wherever it is set — but the invoice still has to say so, and
   * a field that is always absent is one nobody notices is missing.
   */
  reverseCharge?: boolean

  /** Rate by rate, which is how a GST return is filed and how a CA reads a bill. */
  rateSummary?: RateSummaryRow[]

  /**
   * The invoice this document is raised against, and its date.
   *
   * Rule 53(1)(e): a credit note has to carry both. Without them it is a piece
   * of paper saying money was returned, attached to nothing.
   */
  againstDocNo?: string | null
  againstDate?: string | null

  /**
   * The sentence a shop is required to print because of the scheme it is under
   * — Rule 49's "composition taxable person, not eligible to collect tax on
   * supplies". Absent for a shop that owes no such statement.
   */
  schemeStatement?: string | null

  /** After this date a quoted price is no longer the shop's promise. */
  validUntil?: string | null
  notes?: string | null

  /**
   * The logo as the thermal printer's dots (070). The roll cannot read the
   * `data:` URI the sheet uses -- a printer burns dots -- so the app reduces
   * the image once and hands it here. Absent prints no logo on the roll.
   */
  logoRaster?: Raster | null

  /**
   * What this document calls itself. Left out, it calls itself a bill, which is
   * what every caller before documents existed meant.
   */
  wording?: DocWording
}

/**
 * A rate as a shopkeeper writes it: 1800 basis points is "18%", 250 is "2.5%".
 *
 * Never "18.00%". A trailing zero on a tax rate reads as a precision the rate
 * does not have, and every rate in the schedule is a whole or a half.
 */
export function formatRate(rateBp: number): string {
  const percent = rateBp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`
}

/**
 * The lines gathered rate by rate.
 *
 * Built from the document's own lines rather than re-read from anywhere, so a
 * summary can never disagree with the table above it. Lines that carry no tax
 * figures at all are left out: a document raised before the columns existed
 * gets no summary rather than a summary of zeroes.
 */
export function rateSummaryOf(items: ReceiptItem[]): RateSummaryRow[] {
  const byRate = new Map<number, RateSummaryRow>()

  for (const item of items) {
    if (item.taxableValue === undefined) continue
    const rateBp = item.taxRateBp ?? 0
    const row = byRate.get(rateBp)
      ?? { rateBp, taxable: 0 as Money, cgst: 0 as Money, sgst: 0 as Money, igst: 0 as Money }

    const cess = (row.cess ?? 0) + (item.cess ?? 0)
    byRate.set(rateBp, {
      rateBp,
      taxable: (row.taxable + item.taxableValue) as Money,
      cgst: (row.cgst + (item.cgst ?? 0)) as Money,
      sgst: (row.sgst + (item.sgst ?? 0)) as Money,
      igst: (row.igst + (item.igst ?? 0)) as Money,
      // Only when there is one, so a shop that sells nothing under cess sees no column for it.
      ...(cess > 0 ? { cess: cess as Money } : {}),
    })
  }

  return [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp)
}

/**
 * What the customer saved against the MRP on this bill, discounts included:
 * the MRP of every line that carries one, less what the line came to.
 *
 * Only shelf-priced lines, as with the per-line saving: an MRP has the tax
 * inside it, and a rate quoted before tax is not comparable with it. A line
 * sold above its MRP saves nothing rather than taking from the others.
 */
export function savingsOf(doc: Pick<ReceiptDoc, 'items'>): Money {
  let saved = 0
  for (const item of doc.items) {
    if (!item.mrp || item.rateIncludesTax === false) continue
    const atMrp = Math.round((item.mrp * item.qty) / QTY_SCALE)
    saved += Math.max(0, atMrp - item.lineTotal)
  }
  return saved as Money
}
