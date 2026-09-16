import { type Money, format as fmtMoney, inWords } from '../money.js'
import type { DocWording } from './wording.js'
import { QTY_SCALE, type Qty, formatQty } from '../quantity.js'
import type { Block, DocFormat, Facts } from './docFormat.js'
import { rollColumns, STANDARD_RECEIPT, fillTokens } from './docFormat.js'

/**
 * ESC/POS receipt for an 80mm thermal printer, Font A = 42 columns.
 *
 * The width and the two-line item layout are hardware facts, not preferences:
 * a 43rd character wraps and throws the whole column alignment out. Everything
 * here is padded to exactly 42.
 */

const ESC = '\x1B'
const GS = '\x1D'

const INIT = `${ESC}@`
const LF = '\n'
const ALIGN_LEFT = `${ESC}a\x00`
const ALIGN_CENTER = `${ESC}a\x01`
const BOLD_ON = `${ESC}E\x01`
const BOLD_OFF = `${ESC}E\x00`
const MODE_NORMAL = `${ESC}!\x00`
/** Double width + double height + bold. */
const MODE_BANNER = `${ESC}!\x38`
/** Double height + bold. */
const MODE_TALL = `${ESC}!\x18`
/** Font B, condensed — small print only. */
const MODE_SMALL = `${ESC}!\x01`
const CUT = `${GS}V\x01`

const feed = (n: number) => `${ESC}d${String.fromCharCode(n)}`

/** The 80mm roll, which is what the statement and every legacy caller assume. */
export const WIDTH = rollColumns('thermal_80')
const SNO = 2
const INDENT = SNO + 1

/** Three equal number columns under the item name, whatever the paper. */
function itemColumn(width: number): number {
  return Math.floor((width - INDENT) / 3)
}

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

export interface ReceiptItem {
  name: string
  qty: Qty
  saleUnit: string
  rate: Money
  lineTotal: Money
  mrp?: Money | null

  /* A sheet has room for a column per line that a 42-column roll does not, so
     these are optional: the thermal renderer never reads them, and the A4 one
     leaves the column out when they are absent. */
  hsnCode?: string | null
  taxableValue?: Money
  cgst?: Money
  sgst?: Money
  igst?: Money
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
  payments: { method: string; amount: Money }[]
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

    byRate.set(rateBp, {
      rateBp,
      taxable: (row.taxable + item.taxableValue) as Money,
      cgst: (row.cgst + (item.cgst ?? 0)) as Money,
      sgst: (row.sgst + (item.sgst ?? 0)) as Money,
      igst: (row.igst + (item.igst ?? 0)) as Money,
    })
  }

  return [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp)
}

/**
 * The handful of words that differ between one kind of document and another.
 *
 * A quotation printed under "Invoice no." and "Billed to" says something untrue
 * about itself, and a purchase order says it twice over — the party named on it
 * is the supplier, and the shop is the one that will be billed. This travels
 * with the document and not with the format, because the shop chooses its
 * format and does not get to choose what a purchase order is.
 */
/* Declared in `wording.ts` and re-exported here, where every caller already
   looks for them. See that file for why they had to leave this one. */
export type { DocWording } from './wording.js'
export { BILL_WORDING } from './wording.js'

/**
 * The receipt, block by block.
 *
 * There is one builder, not one per format. The format decides which blocks
 * appear and in what order; the blocks themselves are the same code that has
 * always printed them. Two builders kept in step by hand is how the paper and
 * the preview start disagreeing, and the preview is the thing a shopkeeper
 * trusts when deciding whether to change anything.
 *
 * Called with no format, this prints exactly what it printed before formats
 * existed. `receiptFormat.test.ts` asserts that byte for byte.
 */
export function buildReceipt(doc: ReceiptDoc, format: DocFormat = STANDARD_RECEIPT): string {
  const width = rollColumns(format.paper)
  const out: string[] = [INIT]

  for (const block of format.blocks) {
    if (block.on) out.push(renderBlock(block, doc, width))
  }

  out.push(feed(3), CUT)
  return out.join('')
}

const DEFAULT_FOOTER = 'Thank you. Goods once sold are not returnable without this bill.'

/** Whether the document charged tax under any head at all. */
function taxCharged(doc: ReceiptDoc): boolean {
  return doc.cgst > 0 || doc.sgst > 0 || doc.igst > 0
}

function renderBlock(block: Block, doc: ReceiptDoc, width: number): string {
  switch (block.kind) {
    case 'shop': {
      const out = [ALIGN_CENTER, MODE_BANNER, cut(doc.shop.name, Math.floor(width / 2)), LF, MODE_NORMAL]
      // Double-width banner, so the name gets half the columns and no more.
      if (doc.shop.address) out.push(wrap(doc.shop.address, width))
      if (doc.shop.phone) out.push(`Ph: ${doc.shop.phone}${LF}`)
      if (doc.shop.gstin) out.push(`GSTIN: ${doc.shop.gstin}${LF}`)
      return out.join('')
    }

    case 'title': {
      /* A document that knows what it is outranks the label the shop typed,
         which was typed for its bills — the same precedence the sheet renderer
         uses, so a credit note is not a "Tax Invoice" on one paper and a credit
         note on the other. */
      const label = doc.wording?.title ?? block.opts?.label?.trim()
      if (!label) return ''

      const out = [ALIGN_CENTER, MODE_TALL, cut(label, Math.floor(width / 2)), LF, MODE_NORMAL]
      // Rule 49. Small print, but print: it is the sentence that makes a Bill
      // of Supply legal rather than a tax invoice missing its tax.
      if (doc.schemeStatement) out.push(MODE_SMALL, wrap(doc.schemeStatement, smallColumns(width)), MODE_NORMAL)
      out.push(ALIGN_LEFT)
      return out.join('')
    }

    case 'meta': {
      const out = [ALIGN_LEFT, rule('-', width), kv(doc.docNo, formatDate(doc.postingDate), width)]
      if (doc.customerName) {
        out.push(kv(cut(doc.customerName, Math.floor((width * 2) / 3)), doc.cashier ?? '', width))
      } else if (doc.cashier) {
        out.push(kv('', doc.cashier, width))
      }
      out.push(rule('-', width))
      return out.join('')
    }

    case 'party': {
      if (!doc.customerName) return ''
      return [
        ALIGN_LEFT,
        `${BOLD_ON}Customer${BOLD_OFF}${LF}`,
        wrap(doc.customerName, width),
        rule('-', width),
      ].join('')
    }

    case 'items': {
      const col = itemColumn(width)
      const out = [
        `${' '.repeat(INDENT)}${'Qty'.padStart(col)}${'Rate'.padStart(col)}${'Amount'.padStart(col)}${LF}`,
        rule('-', width),
      ]
      doc.items.forEach((item, i) => out.push(itemRows(i, item, width)))
      out.push(rule('-', width))
      return out.join('')
    }

    case 'totals': {
      const out = [kv('Subtotal', fmtMoney(doc.subtotal), width)]
      if (doc.discount > 0) out.push(kv('Discount', `-${fmtMoney(doc.discount)}`, width))
      /* Left off a document that charged no tax and took nothing off, where it
         would be the subtotal again under a heading that claims something the
         document is not allowed to claim -- a bill of supply has no taxable
         value, it has a value. */
      if (taxCharged(doc) || doc.taxableTotal !== doc.subtotal) {
        out.push(kv('Taxable value', fmtMoney(doc.taxableTotal), width))
      }
      if (doc.cgst > 0) out.push(kv('CGST', fmtMoney(doc.cgst), width))
      if (doc.sgst > 0) out.push(kv('SGST', fmtMoney(doc.sgst), width))
      if (doc.igst > 0) out.push(kv('IGST', fmtMoney(doc.igst), width))
      /* Signed, and shown with its sign: "Round off -0.40" says the shop gave
         forty paise up, which is a different sentence from "Round off 0.40". */
      if (doc.roundOff) out.push(kv('Round off', signed(doc.roundOff), width))
      out.push(rule('=', width))
      out.push(MODE_TALL, kv('TOTAL', fmtMoney(doc.grandTotal), Math.floor(width / 2)), MODE_NORMAL)
      out.push(rule('=', width))
      return out.join('')
    }

    case 'tax_summary': {
      // Deliberately not the same lines as `totals`: this one is the block a
      // shop turns on *instead*, having turned the tax lines off up there.
      if (doc.cgst === 0 && doc.sgst === 0 && doc.igst === 0) return ''
      const out = [`${BOLD_ON}Tax${BOLD_OFF}${LF}`, kv('Taxable value', fmtMoney(doc.taxableTotal), width)]

      /* Rate by rate when the document knows its rates, because a bill carrying
         5% and 18% goods says almost nothing with one CGST figure across both.
         One line per rate and no more: the per-line split a sheet prints has
         nowhere to go in 42 columns, and a roll that runs to a second page is a
         roll the shop stops using. */
      for (const r of doc.rateSummary ?? []) {
        const tax = (r.cgst + r.sgst + r.igst) as Money
        out.push(kv(`${formatRate(r.rateBp)} on ${fmtMoney(r.taxable)}`, fmtMoney(tax), width))
      }

      /* The heads stay, under the rate lines rather than instead of them. Rule
         46(m) wants the amount charged under each head named, and this roll is
         the tax invoice for a counter sale — there is no sheet behind it. */
      if (doc.cgst > 0) out.push(kv('CGST', fmtMoney(doc.cgst), width))
      if (doc.sgst > 0) out.push(kv('SGST', fmtMoney(doc.sgst), width))
      if (doc.igst > 0) out.push(kv('IGST', fmtMoney(doc.igst), width))

      out.push(rule('-', width))
      return out.join('')
    }

    case 'payments':
      return doc.payments.map((p) => kv(titleCase(p.method), fmtMoney(p.amount), width)).join('')

    case 'loyalty': {
      if (!doc.pointsEarned) return ''
      const out = [LF, kv('Points earned', String(doc.pointsEarned), width)]
      if (doc.pointsBalance !== undefined) {
        out.push(kv('Points balance', String(doc.pointsBalance), width))
      }
      return out.join('')
    }

    case 'terms':
      return [
        LF, ALIGN_CENTER, MODE_SMALL,
        /* Measured in font B's columns, not font A's. This block is the only
           one that switches the printer to the condensed face, and wrapping it
           against the wide face broke the sentence a third of the way early —
           two ragged lines where one and a bit would do, and the ragged edge
           reads as a centring fault rather than as the wrong ruler. */
        wrap(doc.footer ?? DEFAULT_FOOTER, smallColumns(width)),
        MODE_NORMAL, ALIGN_LEFT,
      ].join('')

    case 'signature':
      return [LF, LF, kv('', '________________', width), kv('', 'Signature', width)].join('')

    case 'space':
      return LF.repeat(Math.min(Math.max(block.opts?.lines ?? 1, 1), 6))

    case 'text': {
      const body = block.opts?.body?.trim()
      if (!body) return ''
      return wrap(fillTokens(body, factsFor(doc)), width)
    }

    case 'amount_in_words':
      return wrap(inWords(doc.grandTotal), width)

    /* The roll has no pictures: a thermal printer burns dots and an image has
       to be rasterised into them first. `checkFormat` refuses to save a roll
       format with this on, so reaching here means one written by hand. */
    case 'logo':
      return ''
  }
}

/** The flat record a `text` block's {{tokens}} are looked up in. */
function factsFor(doc: ReceiptDoc): Facts {
  return {
    'shop.name': doc.shop.name,
    'shop.address': doc.shop.address ?? '',
    'shop.phone': doc.shop.phone ?? '',
    'shop.gstin': doc.shop.gstin ?? '',
    'doc.no': doc.docNo,
    'doc.date': formatDate(doc.postingDate),
    'customer.name': doc.customerName ?? '',
    total: fmtMoney(doc.grandTotal),
  }
}

/* ------------------------------------------------------- the statement --- */

export interface StatementLine {
  docNo: string
  postingDate: string
  /** Already in words: "Goods", "Payment — UPI", "Balance brought forward". */
  description: string
  /** What it added to the account. */
  debit: Money
  /** What it took off. */
  credit: Money
  /** What was owed after it. */
  balance: Money
}

export interface StatementDoc {
  shop: ReceiptShop
  customerName: string
  customerCode: string | null
  customerPhone: string | null
  /** The window. Null `from` means the whole account. */
  from: string | null
  to: string
  /** Owed at the start of the window. */
  openingBalance: Money
  lines: StatementLine[]
  closingBalance: Money
  totals: { bought: Money; paid: Money; returned: Money }
  footer?: string | null
}

/**
 * The page a shopkeeper hands across the counter.
 *
 * The credit screen could always show a balance and never put it on paper,
 * which is the half that matters: handing over the page is the weekly ritual in
 * a khata shop, and a balance the customer cannot take away is a balance they
 * come back to argue about.
 *
 * Laid out the way a bank states an account, because that is the shape everyone
 * already knows how to read: one line per document, what it added, what it took
 * off, and what was owed after it. Forty-two columns is not enough for three
 * money columns side by side, so the amount sits on the document line and the
 * balance sits under it — which also lets a long description have the width it
 * needs.
 */
export function buildStatement(doc: StatementDoc): string {
  const out: string[] = [INIT]

  out.push(ALIGN_CENTER, MODE_TALL, cut(doc.shop.name, 21), LF, MODE_NORMAL)
  if (doc.shop.address) out.push(wrap(doc.shop.address))
  if (doc.shop.phone) out.push(`Ph: ${doc.shop.phone}${LF}`)
  out.push(LF, BOLD_ON, 'STATEMENT OF ACCOUNT', LF, BOLD_OFF)

  out.push(ALIGN_LEFT, rule())
  out.push(kv(cut(doc.customerName, 28), doc.customerCode ?? ''))
  if (doc.customerPhone) out.push(`${doc.customerPhone}${LF}`)
  out.push(
    doc.from
      ? `${formatDate(doc.from)} to ${formatDate(doc.to)}${LF}`
      : `As at ${formatDate(doc.to)}${LF}`,
  )
  out.push(rule())

  if (doc.from) {
    out.push(kv('Balance brought forward', fmtMoney(doc.openingBalance)))
    out.push(rule())
  }

  for (const line of doc.lines) {
    const moved = line.debit > 0 ? fmtMoney(line.debit) : `-${fmtMoney(line.credit)}`
    out.push(kv(`${shortDate(line.postingDate)} ${cut(line.docNo, 14)}`, moved))
    out.push(`${MODE_SMALL}${' '.repeat(6)}${cut(line.description, 22)}`)
    out.push(`${'Bal '.padStart(WIDTH - 6 - Math.min(line.description.length, 22) - 10)}${fmtMoney(line.balance)}${MODE_NORMAL}${LF}`)
  }

  out.push(rule('='))
  out.push(MODE_TALL, kv('BALANCE DUE', fmtMoney(doc.closingBalance), 21), MODE_NORMAL)
  out.push(rule('='))

  // The three figures a customer looks for before they look at the balance.
  out.push(MODE_SMALL)
  out.push(kv('Bought this period', fmtMoney(doc.totals.bought)))
  out.push(kv('Paid this period', fmtMoney(doc.totals.paid)))
  if (doc.totals.returned > 0) out.push(kv('Returned this period', fmtMoney(doc.totals.returned)))
  out.push(MODE_NORMAL)

  out.push(LF, ALIGN_CENTER, MODE_SMALL)
  out.push(wrap(doc.footer ?? 'Please check and tell us at once if anything here is wrong.'))
  out.push(MODE_NORMAL, ALIGN_LEFT, feed(3), CUT)

  return out.join('')
}

/** Day and month only: the year is on the header line and the column is narrow. */
function shortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 5)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function itemRows(index: number, item: ReceiptItem, width = WIDTH): string {
  const sno = String(index + 1).padStart(SNO)
  const col = itemColumn(width)
  const name = cut(item.name, width - INDENT)

  const qtyText = formatQty(item.qty)
  const unit = cut(item.saleUnit, Math.max(1, col - qtyText.length - 1))
  const qty = `${qtyText} ${unit}`.padStart(col)
  const rate = fmtMoney(item.rate).padStart(col)
  const amount = fmtMoney(item.lineTotal).padStart(col)

  let rows = `${sno} ${name}${LF}${' '.repeat(INDENT)}${qty}${rate}${amount}${LF}`

  if (item.mrp && item.mrp > item.rate) {
    /* The quantity is on the line. It used to be recovered by dividing the line
       total by the rate, which is a different number whenever the line carries a
       discount -- the saving was then understated by the discount, which is the
       opposite of the truth -- and is `Infinity` on a free line, printing
       `Save NaN` on the customer's receipt. Money is never divided by money. */
    const saved = Math.round(((item.mrp - item.rate) * item.qty) / QTY_SCALE)
    const left = `MRP ${fmtMoney(item.mrp)}`
    const right = `Save ${fmtMoney(saved as Money)}`
    const gap = Math.max(1, width - INDENT - left.length - right.length)
    rows += `${' '.repeat(INDENT)}${left}${' '.repeat(gap)}${right}${LF}`
  }

  return rows
}

function rule(ch = '-', width = WIDTH): string {
  return ch.repeat(width) + LF
}

/** Left text, right text, padded apart to exactly `width` columns. */
function kv(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}${LF}`
}

/**
 * How many characters fit on a line of the condensed face.
 *
 * Font B is 9 dots wide where font A is 12, so it fits a third more: 56 columns
 * on an 80mm roll against 42, and 42 on a 58mm roll against 32.
 */
export function smallColumns(width: number): number {
  return Math.floor((width * 4) / 3)
}

function cut(text: string, max: number): string {
  return String(text ?? '').slice(0, max)
}

function wrap(text: string, width = WIDTH): string {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line !== '') lines.push(line)
  return lines.join(LF) + LF
}

function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export type PreviewAlign = 'left' | 'centre' | 'right'

/** How a line is set on the paper, for a preview that is not lying about it. */
export interface PreviewLine {
  text: string
  align: PreviewAlign
  bold: boolean
  /** Double width and height: the shop name across the top. */
  banner: boolean
  /** Double height only. */
  tall: boolean
  /** Font B, condensed. */
  small: boolean
}

/**
 * The receipt as a person would see it come out of the printer.
 *
 * `visibleLines` throws the alignment and emphasis away, which is right for
 * measuring column widths and wrong for showing someone their own receipt: a
 * centred double-width shop name rendered flush left reads as a gap in the
 * layout rather than as the banner it is.
 *
 * The column arithmetic is untouched — `text` is the same characters
 * `visibleLines` gives. Only the styling is carried alongside instead of
 * discarded.
 */
export function previewLines(receipt: string): PreviewLine[] {
  const lines: PreviewLine[] = []

  let align: PreviewAlign = 'left'
  let bold = false
  let banner = false
  let tall = false
  let small = false
  let text = ''

  /* The style as it was when the line's first character was written, not as it
     is at the newline. `BOLD_OFF` comes before the line break, so reading the
     state at the end would report every fully-bold line as not bold. */
  let started: Omit<PreviewLine, 'text'> | null = null

  const endLine = () => {
    lines.push({ text, ...(started ?? { align, bold, banner, tall, small }) })
    text = ''
    started = null
  }

  for (let i = 0; i < receipt.length; i++) {
    const ch = receipt[i]!

    if (ch === LF) {
      endLine()
      continue
    }

    if (ch === ESC) {
      const code = receipt[i + 1]
      const arg = receipt.charCodeAt(i + 2)

      if (code === '@') { i += 1; continue }
      if (code === 'a') {
        align = arg === 1 ? 'centre' : arg === 2 ? 'right' : 'left'
        i += 2
        continue
      }
      if (code === 'E') { bold = arg === 1; i += 2; continue }
      if (code === 'd') { i += 2; continue }
      if (code === '!') {
        /* The mode byte is a set of flags: 0x01 font B, 0x08 emphasis,
           0x10 double height, 0x20 double width. */
        small = (arg & 0x01) !== 0
        const wide = (arg & 0x20) !== 0
        const high = (arg & 0x10) !== 0
        banner = wide && high
        tall = high && !wide
        bold = (arg & 0x08) !== 0
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (ch === GS) {
      // GS V, the cut. Nothing a person sees.
      i += 2
      continue
    }

    if (text === '') started = { align, bold, banner, tall, small }
    text += ch
  }

  // Unconditional, so the line count matches `visibleLines`, which splits on the
  // final newline and therefore ends with an empty line of its own.
  endLine()
  return lines
}

/** Strips ESC/POS control sequences, so a test can measure printed width. */
export function visibleLines(receipt: string): string[] {
  return receipt
    .replace(/\x1B@/g, '')
    .replace(/\x1B![\s\S]/g, '')
    .replace(/\x1Ba[\s\S]/g, '')
    .replace(/\x1BE[\s\S]/g, '')
    .replace(/\x1Bd[\s\S]/g, '')
    .replace(/\x1DV[\s\S]/g, '')
    .split('\n')
}

/** An amount that means something different when it is negative. */
export function signed(amount: Money): string {
  return amount < 0 ? `-${fmtMoney(Math.abs(amount) as Money)}` : `+${fmtMoney(amount)}`
}
