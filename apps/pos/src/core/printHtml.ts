import {
  buildInvoiceHtml, formatFor, loadBillDetail, loadShopProfile, stateName,
  type SqlDriver, type ReceiptDoc, type ReceiptItem, type BillDetailItem,
} from '@shopos/core'
import type { PrintResult } from './print'

/**
 * Printing a sheet, as opposed to a roll.
 *
 * A roll goes out as ESC/POS bytes straight to a named printer, silently. A
 * sheet goes through the operating system's print dialog, because that is where
 * a person chooses the tray, the printer, or Save as PDF — and an A4 invoice is
 * something someone has decided to produce, not something that falls out of the
 * till on every sale.
 *
 * Done with a hidden frame rather than a second window: a Tauri webview can
 * refuse `window.open`, and a frame carries no window chrome to dismiss. The
 * document is handed over whole through `srcdoc`, so it is its own document and
 * none of the app's own styling leaks into it.
 */

/** Long enough for the frame to lay the page out before the dialog opens. */
const LAYOUT_MS = 120

export async function printBillSheet(db: SqlDriver, billId: string): Promise<PrintResult> {
  const doc = await sheetDocFor(db, billId)
  if (!doc) return { ok: false, message: 'That bill could not be found.' }

  // The sheet the shop chose, which carries its own paper size with it.
  const format = await formatFor(db, { kind: 'bill', channel: 'sheet' })
  return printHtml(buildInvoiceHtml(doc, format, { autoPrint: true }))
}

/**
 * The bill as a sheet renderer wants it.
 *
 * Richer than the thermal path builds: HSN, the tax split per line and the
 * place of supply all have a column on a sheet and nowhere to go on 42 columns.
 * Shared with the Formats preview so the designer shows real proportions.
 */
export async function sheetDocFor(db: SqlDriver, billId: string): Promise<ReceiptDoc | null> {
  const bill = await loadBillDetail(db, billId)
  if (!bill) return null

  const shop = await loadShopProfile(db)
  const sum = (pick: (i: BillDetailItem) => number) =>
    bill.items.reduce((total, i) => total + pick(i), 0) as never

  return {
    shop: { name: shop.name, address: shop.address, phone: shop.phone, gstin: shop.gstin },
    docNo: bill.docNo,
    postingDate: bill.postingDate,
    cashier: bill.createdBy,
    customerName: bill.customerName,
    items: bill.items.map((i): ReceiptItem => ({
      name: i.productName,
      qty: i.qty,
      saleUnit: i.saleUnit,
      rate: i.rate,
      lineTotal: i.lineTotal,
      hsnCode: i.hsnCode,
      taxableValue: i.taxableValue,
      cgst: i.cgst,
      sgst: i.sgst,
      igst: i.igst,
    })),
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxableTotal: bill.taxableTotal,
    cgst: sum((i) => i.cgst),
    sgst: sum((i) => i.sgst),
    igst: sum((i) => i.igst),
    grandTotal: bill.grandTotal,
    payments: bill.payments.map((p) => ({ method: p.method, amount: p.amount })),
    placeOfSupply: shop.stateCode ? stateName(shop.stateCode) : null,
    terms: shop.terms,
    footer: shop.receiptFooter,
  }
}

/** Lays the page out in a hidden frame and opens the print dialog on it. */
export function printHtml(html: string): Promise<PrintResult> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    frame.srcdoc = html

    /* Removed on a timer rather than on afterprint: the dialog is modal to the
       operating system and some webviews never fire afterprint when it is
       cancelled, which would leave a frame behind on every cancelled print. */
    const done = (result: PrintResult) => {
      window.setTimeout(() => frame.remove(), 1000)
      resolve(result)
    }

    frame.onload = () => {
      window.setTimeout(() => {
        try {
          const view = frame.contentWindow
          if (!view) {
            done({ ok: false, message: 'The page could not be prepared for printing.' })
            return
          }
          view.focus()
          view.print()
          done({ ok: true })
        } catch {
          done({ ok: false, message: 'This machine would not open the print dialog.' })
        }
      }, LAYOUT_MS)
    }

    document.body.appendChild(frame)
  })
}
