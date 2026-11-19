import { joinSheets, loadCustomer, type SqlDriver } from '@shopos/core'
import { NOTHING_DUE, loadBillsDue, type PrintResult } from './print'
import { billSheetHtml, printHtml } from './printHtml'

/** Where `printInvoices` has got to, for the screen that waits on it. */
export interface InvoicesProgress { done: number; total: number }

/**
 * Each ticked bill's own A4 invoice, the one the customer was given, in one
 * print window: a page or more per bill, oldest first. The window's own Save
 * as PDF makes a file of it. A reference only: nothing is saved to the books
 * and nothing gets a number.
 *
 * The pages are built one bill at a time so the screen can count them and a
 * Cancel is heard between bills; then the print window opens once on the lot.
 */
export async function printInvoices(
  db: SqlDriver,
  customerId: string,
  billIds: readonly string[],
  progress: (p: InvoicesProgress) => void,
  cancelled: () => boolean,
): Promise<PrintResult | { ok: false; stopped: true }> {
  const customer = await loadCustomer(db, customerId)
  if (!customer) return { ok: false, message: 'That customer could not be found.' }
  const due = await loadBillsDue(db, customerId, billIds)
  if (!due) return { ok: false, message: NOTHING_DUE }

  const sheets: string[] = []
  for (const [i, bill] of due.bills.entries()) {
    if (cancelled()) return { ok: false, stopped: true }
    progress({ done: i, total: due.bills.length })
    const sheet = await billSheetHtml(db, bill.billId)
    if (!sheet.ok) return { ok: false, message: `${bill.docNo}: ${sheet.message}` }
    sheets.push(sheet.html)
    // Lets the screen draw the count and a Cancel click land between bills.
    await new Promise((r) => setTimeout(r, 0))
  }
  if (cancelled()) return { ok: false, stopped: true }
  return printHtml(joinSheets(sheets, `${customer.name}, ${due.bills.length} invoices`))
}
