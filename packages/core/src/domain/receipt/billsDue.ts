import { format as fmtMoney, type Money, ZERO, add, sub } from '../../money.js'
import { addQty, formatQty, QTY_SCALE, type Qty } from '../../quantity.js'
import type { ReceiptShop } from './doc.js'
import {
  INIT, LF, ALIGN_LEFT, ALIGN_CENTER, BOLD_ON, BOLD_OFF, MODE_NORMAL, MODE_TALL, MODE_SMALL, CUT,
  feed, rule, kv, cut, wrap, formatDate,
} from './escpos.js'

/*
 * Several unpaid bills of one customer's as one long bill: every item on
 * them, the same item at the same price added into one line, and one total.
 *
 * A reference and nothing more. It has no number, nothing is saved when it is
 * made, and nothing posts: each bill on it is already a tax invoice with its
 * own entries, and a second document claiming the same goods would declare
 * the tax on them twice. That is why ERPNext's merge-log consolidation is on
 * the not-building list, and why this is a print, not a document. The
 * payment is taken the ordinary way, against the account.
 */

/** One bill as the list needs it. Shaped like `CustomerStatementRow`. */
export interface BillDue {
  billId: string
  docNo: string
  postingDate: string
  /** What went on the account when the bill was made. */
  creditTotal: Money
  /** Paid against it since. */
  allocated: Money
  /** Still owed on it. */
  outstanding: Money
}

export interface BillsDue {
  bills: BillDue[]
  total: Money
}

/**
 * The chosen bills that still have something owing, oldest first, and what
 * they come to.
 *
 * `open` is the customer's open bills as read now, so a bill picked on a
 * screen that was paid off since -- on this till or another -- drops out
 * here rather than appearing on paper as owed. A paid bill cannot get onto
 * the page by any route.
 */
export function billsDue(open: readonly BillDue[], chosen: readonly string[]): BillsDue {
  const wanted = new Set(chosen)
  const bills = open
    .filter((b) => wanted.has(b.billId) && b.outstanding > 0)
    .sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.docNo.localeCompare(b.docNo))
  return { bills, total: bills.reduce<Money>((s, b) => add(s, b.outstanding), ZERO) }
}

/** An item line of a bill, as the combined bill needs it. */
export interface DueItemIn {
  productId: string
  productName: string
  saleUnit: string
  qty: Qty
  /** With tax, as the bill charged it. */
  lineTotal: Money
  returnedQty: Qty
}

/** One line of the combined bill. */
export interface CombinedLine {
  name: string
  saleUnit: string
  qty: Qty
  /** Each, with tax: what the line comes to over its quantity. */
  each: Money
  amount: Money
  /** Of `qty`, how many have come back since. Zero almost always. */
  returnedQty: Qty
}

/** Each, with tax, from a line's total -- to the paisa, for showing and for grouping. */
function eachOf(lineTotal: Money, q: Qty): Money {
  return (q > 0 ? Math.round((lineTotal * QTY_SCALE) / q) : lineTotal) as Money
}

/**
 * Every item line of the given bills, oldest bill first. The same item, in
 * the same unit, at the same price each, becomes one line with the
 * quantities added; at a different price it stays a line of its own, so
 * every line still reads quantity times price.
 */
export function combinedItems(bills: readonly { items: readonly DueItemIn[] }[]): CombinedLine[] {
  const lines = new Map<string, CombinedLine>()
  for (const bill of bills) {
    for (const it of bill.items) {
      const each = eachOf(it.lineTotal, it.qty)
      const key = `${it.productId}|${it.saleUnit}|${each}`
      const was = lines.get(key)
      if (was) {
        was.qty = addQty(was.qty, it.qty)
        was.amount = add(was.amount, it.lineTotal)
        was.returnedQty = addQty(was.returnedQty, it.returnedQty)
      } else {
        lines.set(key, { name: it.productName, saleUnit: it.saleUnit, qty: it.qty, each, amount: it.lineTotal, returnedQty: it.returnedQty })
      }
    }
  }
  return [...lines.values()]
}

export interface BillsDueDoc {
  shop: ReceiptShop
  customerName: string
  customerCode: string | null
  customerPhone: string | null
  /** The day it was printed. */
  asAt: string
  bills: BillDue[]
  items: CombinedLine[]
  /** What the bills came to, discount and round off included. */
  billsTotal: Money
  total: Money
  footer?: string | null
}

/** The roll version, for handing across the counter. */
export function buildBillsDue(doc: BillsDueDoc): string {
  const out: string[] = [INIT]

  out.push(ALIGN_CENTER, MODE_TALL, cut(doc.shop.name, 21), LF, MODE_NORMAL)
  if (doc.shop.address) out.push(wrap(doc.shop.address))
  if (doc.shop.phone) out.push(`Ph: ${doc.shop.phone}${LF}`)
  out.push(LF, BOLD_ON, 'BILLS DUE', LF, BOLD_OFF)

  out.push(ALIGN_LEFT, rule())
  out.push(kv(cut(doc.customerName, 28), doc.customerCode ?? ''))
  if (doc.customerPhone) out.push(`${doc.customerPhone}${LF}`)
  out.push(`As at ${formatDate(doc.asAt)}${LF}`)
  out.push(rule())

  for (const line of doc.items) {
    out.push(wrap(line.name))
    out.push(kv(`  ${formatQty(line.qty)} ${cut(line.saleUnit, 8)} x ${fmtMoney(line.each)}`, fmtMoney(line.amount)))
    if (line.returnedQty > 0) out.push(MODE_SMALL, `  ${formatQty(line.returnedQty)} returned since${LF}`, MODE_NORMAL)
  }

  out.push(rule())
  const items = doc.items.reduce<Money>((s, l) => add(s, l.amount), ZERO)
  out.push(kv('Items', fmtMoney(items)))
  /* The bills' own discounts and round off: the items add up to a little
     more or less than the bills did, and the bills are what is owed. */
  const adjust = sub(doc.billsTotal, items)
  if (adjust !== 0) out.push(kv('Discount and round off', fmtMoney(adjust)))
  const settled = sub(doc.billsTotal, doc.total)
  if (settled !== 0) out.push(kv('Paid and returned', fmtMoney(-settled as Money)))

  out.push(rule('='))
  out.push(MODE_TALL, kv('TOTAL DUE', fmtMoney(doc.total), 21), MODE_NORMAL)
  out.push(rule('='))

  out.push(MODE_SMALL)
  out.push(wrap(`From ${doc.bills.length} bill${doc.bills.length === 1 ? '' : 's'}: ${doc.bills.map((b) => b.docNo).join(', ')}`))
  out.push(LF, ALIGN_CENTER)
  out.push(wrap('A list of bills already given, not a new bill. Nothing was sold or taken from stock.'))
  if (doc.footer) out.push(wrap(doc.footer))
  out.push(MODE_NORMAL, ALIGN_LEFT, feed(3), CUT)

  return out.join('')
}
