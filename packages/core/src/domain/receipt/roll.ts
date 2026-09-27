import { type Money, format as fmtMoney, inWords } from '../../money.js'
import { QTY_SCALE, formatQty } from '../../quantity.js'
import type { Block, DocFormat } from '../docFormat.js'
import { rollColumns, STANDARD_RECEIPT, fillTokens } from '../docFormat.js'
import { formatRate, type ReceiptDoc, type ReceiptItem } from './doc.js'
import { factsFor } from '../docText.js'
import {
  INIT, LF, ALIGN_LEFT, ALIGN_CENTER, BOLD_ON, BOLD_OFF, MODE_NORMAL, MODE_BANNER, MODE_TALL,
  MODE_SMALL, CUT, WIDTH, feed, forThermal, rule, kv, smallColumns, cut, wrap, formatDate,
  titleCase, signed,
} from './escpos.js'

const SNO = 2
const INDENT = SNO + 1

/** Three equal number columns under the item name, whatever the paper. */
function itemColumn(width: number): number {
  return Math.floor((width - INDENT) / 3)
}

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
  return forThermal(out.join(''))
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
      return doc.payments.map((p) => kv(p.method === 'upi' ? 'UPI' : titleCase(p.method), fmtMoney(p.amount), width)).join('')

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

  if (item.batch) rows += `${' '.repeat(INDENT)}${cut(item.batch, width - INDENT)}${LF}`

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
