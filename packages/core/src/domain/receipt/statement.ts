import { format as fmtMoney, type Money } from '../../money.js'
import type { ReceiptShop } from './doc.js'
import {
  INIT, LF, ALIGN_LEFT, ALIGN_CENTER, BOLD_ON, BOLD_OFF, MODE_NORMAL, MODE_TALL, MODE_SMALL, CUT,
  WIDTH, feed, rule, kv, cut, wrap, formatDate,
} from './escpos.js'

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
