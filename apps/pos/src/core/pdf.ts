import { invoke } from '@tauri-apps/api/core'
import {
  Money, Quantity, joinSheets, customerAccount, businessDate, loadShopProfile, loadCustomer,
  type SqlDriver, type CustomerAccount,
} from '@shopos/core'
import type { SaveResult } from './exportFile'
import { NOTHING_DUE, loadBillsDue, type LoadedBillsDue } from './print'
import { billSheetHtml } from './printHtml'

/**
 * Documents that leave the shop.
 *
 * A receipt is for the person standing at the counter; a statement is for the
 * customer who has gone home, and a report is for the accountant. Those two
 * travel — on WhatsApp, in an email, in a folder the CA asks for once a month —
 * and a thermal receipt does not travel.
 *
 * The layout lives in Rust (`pdf.rs`) because the webview cannot write a file.
 * What lives here is the part that needs to know what a statement *is*: which
 * columns, in what order, and what the totals mean.
 *
 * One thing to know before reading the output: the PDF fonts are the standard
 * fourteen, which every reader has and none of which carries a rupee glyph. So
 * amounts are written plain and the column heading says what they are. It is
 * also why these cannot yet carry Tamil.
 */

interface PdfColumn {
  label: string
  /** Relative share of the page width; any scale will do. */
  width: number
  alignRight?: boolean
}

interface PdfDoc {
  title: string
  subtitle?: string
  meta?: [string, string][]
  columns: PdfColumn[]
  rows: string[][]
  boldRows?: number[]
  totals?: [string, string][]
  footer?: string
}

async function write(filename: string, doc: PdfDoc): Promise<SaveResult> {
  try {
    const path = await invoke<string>('export_pdf', { filename, doc })
    return { ok: true, path }
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : 'The PDF could not be saved.' }
  }
}

/** Never a dash: a column of figures reads as a column, and a gap breaks it. */
const amount = (value: number): string => (value === 0 ? '' : Money.format(value as never))

/** Safe in a filename, and still recognisably the customer. */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    || 'customer'
}

export async function statementPdf(
  db: SqlDriver,
  customerId: string,
  range: { from?: string; to?: string } = {},
): Promise<SaveResult> {
  const customer = await loadCustomer(db, customerId)
  if (!customer) return { ok: false, message: 'That customer could not be found.' }

  const account: CustomerAccount = await customerAccount(db, customerId, range)
  if (account.entries.length === 0) {
    return { ok: false, message: 'There is nothing on this account for that period.' }
  }

  const to = range.to ?? businessDate()
  const shop = await loadShopProfile(db)

  const rows: string[][] = []
  const bold: number[] = []

  /* The window has to start from somewhere, or the first balance below is a
     figure that appears out of nowhere. */
  if (range.from) {
    rows.push([range.from, '', 'Balance brought forward', '', '', Money.format(account.openingBalance)])
    bold.push(0)
  }

  for (const e of account.entries) {
    rows.push([
      e.postingDate,
      e.docNo,
      e.description,
      amount(e.debit),
      amount(e.credit),
      Money.format(e.balance),
    ])
  }

  const meta: [string, string][] = [
    ['Customer', customer.name + (customer.code ? ` (${customer.code})` : '')],
  ]
  if (customer.phone) meta.push(['Phone', customer.phone])
  if (customer.address) meta.push(['Address', customer.address])
  meta.push(['Period', range.from ? `${range.from} to ${to}` : `Everything up to ${to}`])

  const totals: [string, string][] = [
    ['Bought', Money.format(account.totals.bought)],
    ['Paid', Money.format(account.totals.paid)],
  ]
  if (account.totals.returned > 0) totals.push(['Returned', Money.format(account.totals.returned)])
  totals.push(['Balance due (Rs.)', Money.format(account.closingBalance)])

  return write(`statement-${slug(customer.name)}-${to}.pdf`, {
    title: `${shop.name} — statement of account`,
    subtitle: customer.name,
    meta,
    columns: [
      { label: 'Date', width: 1.1 },
      /* Wide enough for a real document number. "INV/MR/26-27/00016" sets at
         about 85 points, and the old 1.3 share gave it 67 — so every row on
         every statement ran its number across the description beside it. */
      { label: 'Document', width: 1.8 },
      { label: 'What it was', width: 2.7 },
      { label: 'Charged', width: 1.2, alignRight: true },
      { label: 'Paid', width: 1.2, alignRight: true },
      { label: 'Balance', width: 1.3, alignRight: true },
    ],
    rows,
    boldRows: bold,
    totals,
    footer: 'All amounts in rupees. Please check and tell us at once if anything here is wrong.',
  })
}

/**
 * Whatever table is on the reports screen, as a page an accountant can file.
 *
 * Takes the rows already built for the screen rather than re-querying, so the
 * PDF cannot disagree with what the owner was looking at when they pressed the
 * button.
 */
export async function reportPdf(
  db: SqlDriver,
  input: {
    title: string
    range: { from: string; to: string }
    columns: PdfColumn[]
    rows: string[][]
    totals?: [string, string][]
  },
): Promise<SaveResult> {
  if (input.rows.length === 0) return { ok: false, message: 'There is nothing in this range to save.' }

  const shop = await loadShopProfile(db)

  const meta: [string, string][] = [['Period', `${input.range.from} to ${input.range.to}`]]
  if (shop.gstin) meta.push(['GSTIN', shop.gstin])

  return write(`${slug(input.title)}-${input.range.from}-to-${input.range.to}.pdf`, {
    title: `${shop.name} — ${input.title.toLowerCase()}`,
    meta,
    columns: input.columns,
    rows: input.rows,
    ...(input.totals ? { totals: input.totals } : {}),
    footer: 'All amounts in rupees.',
  })
}

/**
 * The chosen unpaid bills as a page, for the customer who settles once a
 * month and wants the list on WhatsApp. A reference only, like the slip:
 * nothing is saved and nothing gets a number. The open bills are read again
 * here, so a bill paid since it was ticked does not appear as owed.
 */
export async function billsDuePdf(
  db: SqlDriver,
  customerId: string,
  billIds: readonly string[],
): Promise<SaveResult> {
  const customer = await loadCustomer(db, customerId)
  if (!customer) return { ok: false, message: 'That customer could not be found.' }

  const due = await loadBillsDue(db, customerId, billIds)
  if (!due) return { ok: false, message: NOTHING_DUE }

  const asAt = businessDate()
  const shop = await loadShopProfile(db)

  const meta: [string, string][] = [
    ['Customer', customer.name + (customer.code ? ` (${customer.code})` : '')],
  ]
  if (customer.phone) meta.push(['Phone', customer.phone])
  if (customer.address) meta.push(['Address', customer.address])
  meta.push(['As at', asAt])

  return write(`bills-due-${slug(customer.name)}-${asAt}.pdf`, {
    title: `${shop.name} — bills due`,
    subtitle: customer.name,
    meta,
    columns: [
      { label: 'Item', width: 3.2 },
      { label: 'Qty', width: 1.1, alignRight: true },
      { label: 'Each', width: 1.1, alignRight: true },
      { label: 'Amount', width: 1.3, alignRight: true },
    ],
    rows: due.items.map((l) => [
      l.returnedQty > 0 ? `${l.name} (${Quantity.formatQty(l.returnedQty)} returned since)` : l.name,
      `${Quantity.formatQty(l.qty)} ${l.saleUnit}`,
      Money.format(l.each),
      Money.format(l.amount),
    ]),
    totals: totalsOf(due),
    footer: `All amounts in rupees. From ${due.bills.length} bill${due.bills.length === 1 ? '' : 's'}: ${due.bills.map((b) => b.docNo).join(', ')}. A list of bills already given, not a new bill; nothing was sold or taken from stock.`,
  })
}

/** The lines under the items, as the slip has them. */
function totalsOf(due: LoadedBillsDue): [string, string][] {
  const items = due.items.reduce((s, l) => s + l.amount, 0)
  const out: [string, string][] = [['Items', Money.format(items as Money.Money)]]
  const adjust = due.billsTotal - items
  if (adjust !== 0) out.push(['Discount and round off', Money.format(adjust as Money.Money)])
  const settled = due.billsTotal - due.total
  if (settled !== 0) out.push(['Paid and returned', Money.format(-settled as Money.Money)])
  out.push(['Total due (Rs.)', Money.format(due.total)])
  return out
}

/** Where `invoicesPdf` has got to, for the screen that waits on it. */
export type InvoicesProgress =
  | { stage: 'pages'; done: number; total: number }
  | { stage: 'printing'; total: number }

/** Said by the Rust side when Cancel stopped it; not an error to show. */
const STOPPED = 'Stopped.'

/**
 * Each ticked bill's own A4 invoice, the one the customer was given, in one
 * PDF: a page or more per bill, oldest first. A reference only, like the one
 * long bill: nothing is saved to the books and nothing gets a number.
 *
 * The pages are built one bill at a time so the screen can count them and
 * Cancel is heard between bills; then Edge prints the lot once, which is why
 * two hundred bills take seconds and not minutes. Cancel during that stops Edge.
 */
export async function invoicesPdf(
  db: SqlDriver,
  customerId: string,
  billIds: readonly string[],
  progress: (p: InvoicesProgress) => void,
  cancelled: () => boolean,
): Promise<SaveResult | { ok: false; stopped: true }> {
  const customer = await loadCustomer(db, customerId)
  if (!customer) return { ok: false, message: 'That customer could not be found.' }
  const due = await loadBillsDue(db, customerId, billIds)
  if (!due) return { ok: false, message: NOTHING_DUE }

  const sheets: string[] = []
  for (const [i, bill] of due.bills.entries()) {
    if (cancelled()) return { ok: false, stopped: true }
    progress({ stage: 'pages', done: i, total: due.bills.length })
    const sheet = await billSheetHtml(db, bill.billId)
    if (!sheet.ok) return { ok: false, message: `${bill.docNo}: ${sheet.message}` }
    sheets.push(sheet.html)
    // Lets the screen draw the count and a Cancel click land between bills.
    await new Promise((r) => setTimeout(r, 0))
  }
  if (cancelled()) return { ok: false, stopped: true }
  progress({ stage: 'printing', total: due.bills.length })

  const filename = `invoices-${slug(customer.name)}-${businessDate()}.pdf`
  try {
    const path = await invoke<string>('bills_pdf', { filename, html: joinSheets(sheets, `${customer.name}, ${due.bills.length} invoices`) })
    return { ok: true, path }
  } catch (err) {
    if (err === STOPPED) return { ok: false, stopped: true }
    return { ok: false, message: typeof err === 'string' ? err : 'The PDF could not be made.' }
  }
}

/** Stops `invoicesPdf` while Edge is printing; between bills it hears `cancelled`. */
export async function cancelInvoicesPdf(): Promise<void> {
  await invoke('bills_pdf_cancel').catch(() => {})
}
