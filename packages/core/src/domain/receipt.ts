import { type Money, format as fmtMoney } from '../money.js'
import { type Qty, formatQty } from '../quantity.js'
import type { DocFormat, Block } from './docFormat.js'

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

const feed = (n: number, _width?: number) => `${ESC}d${String.fromCharCode(n)}`

export const WIDTH = 42
const SNO = 2
const INDENT = SNO + 1
/** (42 - 3) / 3 — three equal number columns under the item name. */
const COL = 13

export interface ReceiptShop {
  name: string
  address?: string | null
  phone?: string | null
  gstin?: string | null
}

export interface ReceiptItem {
  name: string
  qty: Qty
  saleUnit: string
  rate: Money
  lineTotal: Money
  mrp?: Money | null
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
  grandTotal: Money
  payments: { method: string; amount: Money }[]
  pointsEarned?: number
  pointsBalance?: number
  footer?: string | null
}

export function buildReceipt(doc: ReceiptDoc): string {
  const out: string[] = [INIT]

  out.push(ALIGN_CENTER, MODE_BANNER, cut(doc.shop.name, 21), LF, MODE_NORMAL)
  if (doc.shop.address) out.push(wrap(doc.shop.address))
  if (doc.shop.phone) out.push(`Ph: ${doc.shop.phone}${LF}`)
  if (doc.shop.gstin) out.push(`GSTIN: ${doc.shop.gstin}${LF}`)

  out.push(ALIGN_LEFT, rule())
  out.push(kv(doc.docNo, formatDate(doc.postingDate)))
  if (doc.customerName) out.push(kv(cut(doc.customerName, 28), doc.cashier ?? ''))
  else if (doc.cashier) out.push(kv('', doc.cashier))
  out.push(rule())

  out.push(`${' '.repeat(INDENT)}${'Qty'.padStart(COL)}${'Rate'.padStart(COL)}${'Amount'.padStart(COL)}${LF}`)
  out.push(rule())
  doc.items.forEach((item, i) => out.push(itemRows(i, item)))
  out.push(rule())

  out.push(kv('Subtotal', fmtMoney(doc.subtotal)))
  if (doc.discount > 0) out.push(kv('Discount', `-${fmtMoney(doc.discount)}`))
  out.push(kv('Taxable value', fmtMoney(doc.taxableTotal)))
  if (doc.cgst > 0) out.push(kv('CGST', fmtMoney(doc.cgst)))
  if (doc.sgst > 0) out.push(kv('SGST', fmtMoney(doc.sgst)))
  if (doc.igst > 0) out.push(kv('IGST', fmtMoney(doc.igst)))
  out.push(rule('='))

  out.push(MODE_TALL, kv('TOTAL', fmtMoney(doc.grandTotal), 21), MODE_NORMAL)
  out.push(rule('='))

  for (const p of doc.payments) {
    out.push(kv(titleCase(p.method), fmtMoney(p.amount)))
  }

  if (doc.pointsEarned) {
    out.push(LF, kv('Points earned', String(doc.pointsEarned)))
    if (doc.pointsBalance !== undefined) out.push(kv('Points balance', String(doc.pointsBalance)))
  }

  out.push(LF, ALIGN_CENTER, MODE_SMALL)
  out.push(wrap(doc.footer ?? 'Thank you. Goods once sold are not returnable without this bill.'))
  out.push(MODE_NORMAL, ALIGN_LEFT, feed(3), CUT)

  return out.join('')
}

/**
 * Build a receipt using a format definition. Each enabled block contributes its
 * lines to the output. This allows shops to customize which fields appear and in
 * what order without touching code.
 */
export function buildReceiptWithFormat(doc: ReceiptDoc, format: DocFormat): string {
  const out: string[] = [INIT]
  const width = format.paper === 'thermal_58' ? 32 : 48

  for (const block of format.blocks) {
    if (!block.on) continue

    switch (block.kind) {
      case 'logo':
        // Logo handling deferred: requires image support
        break

      case 'shop':
        out.push(ALIGN_CENTER, MODE_BANNER, cut(doc.shop.name, Math.floor(width / 2)), LF, MODE_NORMAL)
        if (doc.shop.address) out.push(wrap(doc.shop.address, width))
        if (doc.shop.phone) out.push(`Ph: ${doc.shop.phone}${LF}`)
        if (doc.shop.gstin) out.push(`GSTIN: ${doc.shop.gstin}${LF}`)
        break

      case 'title':
        out.push(ALIGN_CENTER, `${block.opts?.label ?? 'BILL'}${LF}`)
        break

      case 'meta':
        out.push(ALIGN_LEFT, rule('-', width))
        out.push(kv(doc.docNo, formatDate(doc.postingDate), width))
        if (doc.customerName) out.push(kv(cut(doc.customerName, Math.floor(width * 0.67)), doc.cashier ?? '', width))
        else if (doc.cashier) out.push(kv('', doc.cashier, width))
        out.push(rule('-', width))
        break

      case 'party':
        if (doc.customerName) {
          out.push(kv('Customer', cut(doc.customerName, width - 12), width))
        }
        break

      case 'items':
        const indent = 3
        const col = Math.floor((width - indent) / 3)
        out.push(
          `${' '.repeat(indent)}${'Qty'.padStart(col)}${'Rate'.padStart(col)}${'Amt'.padStart(col)}${LF}`,
        )
        out.push(rule('-', width))
        doc.items.forEach((item, i) => out.push(itemRows(i, item, width)))
        out.push(rule('-', width))
        break

      case 'totals':
        out.push(kv('Subtotal', fmtMoney(doc.subtotal), width))
        if (doc.discount > 0) out.push(kv('Discount', `-${fmtMoney(doc.discount)}`, width))
        out.push(kv('Taxable', fmtMoney(doc.taxableTotal), width))
        if (doc.cgst > 0) out.push(kv('CGST', fmtMoney(doc.cgst), width))
        if (doc.sgst > 0) out.push(kv('SGST', fmtMoney(doc.sgst), width))
        if (doc.igst > 0) out.push(kv('IGST', fmtMoney(doc.igst), width))
        out.push(rule('=', width))
        out.push(MODE_TALL, kv('TOTAL', fmtMoney(doc.grandTotal), Math.floor(width * 0.5)), MODE_NORMAL)
        out.push(rule('=', width))
        break

      case 'tax_summary':
        if (doc.cgst > 0 || doc.sgst > 0 || doc.igst > 0) {
          out.push(ALIGN_CENTER, 'TAX SUMMARY', LF)
          if (doc.cgst > 0) out.push(kv('CGST', fmtMoney(doc.cgst), width))
          if (doc.sgst > 0) out.push(kv('SGST', fmtMoney(doc.sgst), width))
          if (doc.igst > 0) out.push(kv('IGST', fmtMoney(doc.igst), width))
        }
        break

      case 'payments':
        for (const p of doc.payments) {
          out.push(kv(titleCase(p.method), fmtMoney(p.amount), width))
        }
        break

      case 'amount_in_words':
        // TODO: rupees-in-words library
        break

      case 'terms':
        if (doc.footer) {
          out.push(LF, ALIGN_CENTER, MODE_SMALL)
          out.push(wrap(doc.footer, width))
          out.push(MODE_NORMAL, ALIGN_LEFT)
        }
        break

      case 'signature':
        out.push(LF, `Authorized Signature${LF}`, LF)
        break

      case 'space':
        const lines = (block.opts?.lines as number) ?? 1
        for (let i = 0; i < lines; i++) out.push(LF)
        break

      case 'text':
        // Custom text block: render as-is for now
        if (block.opts?.text) {
          out.push(String(block.opts.text), LF)
        }
        break
    }
  }

  out.push(feed(3, width), CUT)
  return out.join('')
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

function itemRows(index: number, item: ReceiptItem, width?: number): string {
  const w = width ?? WIDTH
  const sno = String(index + 1).padStart(SNO)
  const indent = 3
  const col = Math.floor((w - indent) / 3)
  const name = cut(item.name, w - indent)

  const qtyText = formatQty(item.qty)
  const unit = cut(item.saleUnit, Math.max(1, col - qtyText.length - 1))
  const qty = `${qtyText} ${unit}`.padStart(col)
  const rate = fmtMoney(item.rate).padStart(col)
  const amount = fmtMoney(item.lineTotal).padStart(col)

  let rows = `${sno} ${name}${LF}${' '.repeat(indent)}${qty}${rate}${amount}${LF}`

  if (item.mrp && item.mrp > item.rate) {
    const units = item.lineTotal / item.rate
    const saved = Math.round((item.mrp - item.rate) * units)
    const left = `MRP ${fmtMoney(item.mrp)}`
    const right = `Save ${fmtMoney(saved as Money)}`
    const gap = Math.max(1, w - indent - left.length - right.length)
    rows += `${' '.repeat(indent)}${left}${' '.repeat(gap)}${right}${LF}`
  }

  return rows
}

function rule(ch = '-', width?: number): string {
  const w = width ?? WIDTH
  return ch.repeat(w) + LF
}

/** Left text, right text, padded apart to exactly `colWidth` columns. */
function kv(left: string, right: string, colWidth?: number): string {
  const width = colWidth ?? WIDTH
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}${LF}`
}

function cut(text: string, max: number): string {
  return String(text ?? '').slice(0, max)
}

function wrap(text: string, colWidth?: number): string {
  const width = colWidth ?? WIDTH
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
