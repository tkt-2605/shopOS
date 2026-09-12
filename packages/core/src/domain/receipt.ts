import { type Money, format as fmtMoney } from '../money.js'
import { type Qty, formatQty } from '../quantity.js'

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

function itemRows(index: number, item: ReceiptItem): string {
  const sno = String(index + 1).padStart(SNO)
  const name = cut(item.name, WIDTH - INDENT)

  const qtyText = formatQty(item.qty)
  const unit = cut(item.saleUnit, Math.max(1, COL - qtyText.length - 1))
  const qty = `${qtyText} ${unit}`.padStart(COL)
  const rate = fmtMoney(item.rate).padStart(COL)
  const amount = fmtMoney(item.lineTotal).padStart(COL)

  let rows = `${sno} ${name}${LF}${' '.repeat(INDENT)}${qty}${rate}${amount}${LF}`

  // Only when the shelf price beat the printed MRP — a customer likes seeing it,
  // and it is silent otherwise rather than printing "Save 0.00".
  if (item.mrp && item.mrp > item.rate) {
    const units = item.lineTotal / item.rate
    const saved = Math.round((item.mrp - item.rate) * units)
    const left = `MRP ${fmtMoney(item.mrp)}`
    const right = `Save ${fmtMoney(saved as Money)}`
    const gap = Math.max(1, WIDTH - INDENT - left.length - right.length)
    rows += `${' '.repeat(INDENT)}${left}${' '.repeat(gap)}${right}${LF}`
  }

  return rows
}

function rule(ch = '-'): string {
  return ch.repeat(WIDTH) + LF
}

/** Left text, right text, padded apart to exactly `width` columns. */
function kv(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}${LF}`
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
