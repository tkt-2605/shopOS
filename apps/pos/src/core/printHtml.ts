import {
  buildInvoiceHtml, formatFor, loadBillDetail, loadDocument, loadReturnDetail, loadShopProfile,
  loadTaxScheme, billWording, schemeStatement, rateSummaryOf, stateName, batchTextFor,
  type SqlDriver, type ReceiptDoc, type ReceiptItem, type BillDetailItem,
  type DocWording, type DocumentKind, type PlaceOfSupply, type ReturnDetailItem,
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
  const sheet = await billSheetHtml(db, billId)
  if (!sheet.ok) return sheet
  return printHtml(sheet.html)
}

export type SheetHtml =
  | { ok: true; html: string; docNo: string }
  | { ok: false; message: string }

/**
 * The A4 page for a bill, as the string the printer is handed.
 *
 * Split out because the preview and the print must be the same document and not
 * merely the same design. A preview built from the same data through a second
 * renderer is a second implementation of the layout, and the two drift — which
 * is exactly the shape of the bug that put the shop's own state on every
 * invoice as the place of supply while every test of the renderer passed,
 * because each test built its document by hand.
 *
 * There is now no difference at all between the two callers' documents. The
 * page used to carry a script that printed itself when it was destined for the
 * printer, which — on top of the frame that was already printing it — is why a
 * bill opened two print dialogs. Printing is the job of whoever is showing the
 * page, and the page cannot tell which of them it is in.
 */
export async function billSheetHtml(db: SqlDriver, billId: string): Promise<SheetHtml> {
  const doc = await sheetDocFor(db, billId)
  if (!doc) return { ok: false, message: 'That bill could not be found.' }

  // The sheet the shop chose, which carries its own paper size with it.
  const format = await formatFor(db, { kind: 'bill', channel: 'sheet' })
  return { ok: true, docNo: doc.docNo, html: buildInvoiceHtml(doc, format) }
}

export type PreviewResult =
  | { ok: true; html: string; docNo: string }
  | { ok: false; message: string }

/**
 * The sheet, to look at rather than to print.
 *
 * Hands back the page for a screen to show. It deliberately opens nothing
 * itself: a preview that reached for a window of its own is what closed the
 * application.
 *
 * `window.open('', '_blank')` inside a Tauri WebView2 does not give a second
 * window — it gives back **the window already there**, so writing the invoice
 * into it replaced the running app, and the Close button on the result shut the
 * app down. A cashier halfway through a bill would have lost the cart to a
 * preview. `ui/SheetPreview.tsx` carries what a real second window would take.
 */
export async function previewBillSheet(db: SqlDriver, billId: string): Promise<PreviewResult> {
  return billSheetHtml(db, billId)
}

/**
 * The credit note for a return.
 *
 * A return has been a movement in the database and a line in a list, and the
 * customer has walked out with the money and no paper. Under GST the credit
 * note *is* the document — Section 34 and Rule 53 — and it is what the
 * customer's own accounts need to reverse the purchase at their end. A
 * registered buyer cannot do anything with a refund they have no note for.
 *
 * The same A4 renderer as the invoice, deliberately. The two documents carry
 * the same fields and differ in what they say about themselves, and a second
 * renderer would be a second place for the place of supply to go wrong.
 */
export async function printCreditNoteSheet(db: SqlDriver, returnId: string): Promise<PrintResult> {
  const doc = await creditNoteDocFor(db, returnId)
  if (!doc) return { ok: false, message: 'That return could not be found.' }

  /* No shipped format declares `credit_note`, so this falls through to the
     standard sheet — which is the right answer and leaves the door open for a
     shop that wants its own. */
  const format = await formatFor(db, { kind: 'credit_note', channel: 'sheet' })
  return printHtml(buildInvoiceHtml(doc, format))
}

const CREDIT_NOTE_WORDING: DocWording = {
  title: 'Credit Note', docNo: 'Credit note no.', party: 'Credited to', by: 'Raised by',
}

/** The return as the sheet renderer wants it. Exported for the same reason as `sheetDocFor`. */
export async function creditNoteDocFor(db: SqlDriver, returnId: string): Promise<ReceiptDoc | null> {
  const ret = await loadReturnDetail(db, returnId)
  if (!ret) return null

  const shop = await loadShopProfile(db)
  const items = ret.items.map((i): ReceiptItem => ({
    name: i.productName,
    qty: i.qty,
    saleUnit: i.saleUnit,
    rate: i.rate,
    lineTotal: i.refund,
    hsnCode: i.hsnCode,
    taxableValue: i.taxableValue,
    taxRateBp: i.taxRateBp,
    cgst: i.cgst,
    sgst: i.sgst,
    igst: i.igst,
    cess: i.cess,
  }))

  const sum = (pick: (i: ReturnDetailItem) => number) =>
    ret.items.reduce((total, i) => total + pick(i), 0) as never

  /* Positive figures under a heading that says what they are, which is how a
     credit note is written: the document's own title carries the direction, and
     a sheet of negative numbers is read as a mistake. The GST export is where
     the sign belongs, and it has one. */
  return {
    shop: {
      name: shop.name, address: shop.address, phone: shop.phone,
      email: shop.email, gstin: shop.gstin, logo: shop.logo,
    },
    docNo: ret.docNo,
    postingDate: ret.postingDate,
    cashier: ret.createdBy,

    // Rule 53(1)(e). Without these two it is a piece of paper saying money was
    // returned, attached to nothing.
    againstDocNo: ret.againstDocNo,
    againstDate: ret.againstDate,

    customerName: ret.customerName,
    customerAddress: ret.customerAddress,
    customerGstin: ret.customerGstin,
    customerState: placeOf(ret.customerStateCode),
    placeOfSupply: placeOf(ret.placeOfSupply),
    ...(ret.supplyType ? { supplyType: ret.supplyType } : {}),
    reverseCharge: false,

    items,
    rateSummary: rateSummaryOf(items),
    subtotal: ret.refundTotal,
    discount: 0 as never,
    taxableTotal: sum((i) => i.taxableValue),
    cgst: sum((i) => i.cgst),
    sgst: sum((i) => i.sgst),
    igst: sum((i) => i.igst),
    cess: sum((i) => i.cess),
    grandTotal: ret.refundTotal,

    /* Nothing was taken here; money went the other way. The block renders as
       nothing rather than as "Cash 340.00", which on a credit note reads as a
       payment received. How the refund was made is said in words below. */
    payments: [],
    terms: [
      ret.reason ? `Reason: ${ret.reason}` : null,
      `Refunded by ${ret.refundMethod}`,
    ].filter((line) => line !== null).join(' · '),

    wording: CREDIT_NOTE_WORDING,
  }
}

/**
 * What each kind of document calls itself on paper.
 *
 * A purchase order is the one that reads oddly until it is written down: the
 * party named on it is the supplier, and the shop is the one who will be
 * billed, so "Billed to" would name the wrong side of the deal.
 */
const WORDING: Record<DocumentKind, DocWording> = {
  quotation: {
    title: 'Quotation', docNo: 'Quotation no.', party: 'Quoted to', by: 'Raised by',
  },
  sales_order: {
    title: 'Sales Order', docNo: 'Order no.', party: 'Ordered by', by: 'Raised by',
  },
  purchase_order: {
    title: 'Purchase Order', docNo: 'Order no.', party: 'Ordered from', by: 'Raised by',
  },
}

/**
 * A quotation, a sales order or a purchase order, on a sheet.
 *
 * Always a sheet and never the roll: these are handed to a customer or emailed
 * to a supplier, and a 42-column slip of thermal paper that fades in a year is
 * not what either expects. There is no thermal equivalent and there is
 * deliberately no button offering one.
 */
export async function printDocumentSheet(db: SqlDriver, documentId: string): Promise<PrintResult> {
  const doc = await loadDocument(db, documentId)
  if (!doc) return { ok: false, message: 'That document could not be found.' }

  const shop = await loadShopProfile(db)
  const format = await formatFor(db, { kind: doc.kind, channel: 'sheet' })

  const items = doc.items.map((i): ReceiptItem => ({
    name: i.productName,
    qty: i.qty,
    saleUnit: i.saleUnit,
    rate: i.rate,
    lineTotal: i.lineTotal,
    hsnCode: i.hsnCode,
    taxableValue: i.taxableValue,
    taxRateBp: i.taxRateBp,
    cgst: i.cgst,
    sgst: i.sgst,
    igst: i.igst,
    cess: i.cess,
    rateIncludesTax: i.rateIncludesTax,
  }))

  const sheet: ReceiptDoc = {
    shop: {
      name: shop.name, address: shop.address, phone: shop.phone,
      email: shop.email, gstin: shop.gstin, logo: shop.logo,
    },
    docNo: doc.docNo,
    postingDate: doc.postingDate,
    cashier: doc.createdBy,
    customerName: doc.partyName,
    items,
    subtotal: doc.subtotal,
    discount: doc.discount,
    taxableTotal: doc.taxableTotal,
    cgst: doc.items.reduce((t, i) => t + i.cgst, 0) as never,
    sgst: doc.items.reduce((t, i) => t + i.sgst, 0) as never,
    igst: doc.items.reduce((t, i) => t + i.igst, 0) as never,
    cess: doc.items.reduce((t, i) => t + i.cess, 0) as never,
    // Printed on its own line when it is not zero, so the lines and the total
    // add up on the sheet a customer is holding.
    roundOff: doc.roundOff,
    grandTotal: doc.grandTotal,
    /* Nothing has been paid. The block is left in the format and renders as
       nothing, rather than the format needing a separate copy without it. */
    payments: [],
    validUntil: doc.validUntil,
    notes: doc.notes,
    terms: doc.terms ?? shop.terms,
    /* `documents.place_of_supply` holds the supply *type* and not a state — a
       different column from the one on `bills` wearing the same name. It is
       enough to pick the tax columns, which is what it is used for here.
       No place-of-supply row: a quotation is not a tax invoice, it has no state
       stored, and the shop's own state was what used to be printed there — on
       every document, including one quoted to another state. */
    ...(doc.supplyType ? { supplyType: doc.supplyType } : {}),
    rateSummary: rateSummaryOf(items),
    wording: WORDING[doc.kind],
  }

  return printHtml(buildInvoiceHtml(sheet, format))
}

/**
 * The bill as a sheet renderer wants it.
 *
 * Richer than the thermal path builds: HSN, the tax split per line and the
 * place of supply all have a column on a sheet and nowhere to go on 42 columns.
 *
 * Exported, though only `printBillSheet` calls it. The Formats preview builds
 * its own sample instead, deliberately: a shop opening the designer on its
 * first day has no bill to render, and a preview that is blank until someone
 * sells something is a preview nobody can design against.
 */
export async function sheetDocFor(db: SqlDriver, billId: string): Promise<ReceiptDoc | null> {
  const bill = await loadBillDetail(db, billId)
  if (!bill) return null

  const shop = await loadShopProfile(db)
  // Tax Invoice, Bill of Supply or Invoice, and the Rule 49 sentence with it.
  const scheme = await loadTaxScheme(db)
  const sum = (pick: (i: BillDetailItem) => number) =>
    bill.items.reduce((total, i) => total + pick(i), 0) as never

  const batches = await batchTextFor(db, billId)
  const items = bill.items.map((i): ReceiptItem => ({
    name: i.productName,
    qty: i.qty,
    saleUnit: i.saleUnit,
    rate: i.rate,
    mrp: i.mrp,
    lineTotal: i.lineTotal,
    batch: batches.get(i.id) ?? null,
    hsnCode: i.hsnCode,
    taxableValue: i.taxableValue,
    taxRateBp: i.taxRateBp,
    cgst: i.cgst,
    sgst: i.sgst,
    igst: i.igst,
    cess: i.cess,
    rateIncludesTax: i.rateIncludesTax,
  }))

  return {
    shop: {
      name: shop.name, address: shop.address, phone: shop.phone,
      email: shop.email, gstin: shop.gstin, logo: shop.logo,
    },
    docNo: bill.docNo,
    postingDate: bill.postingDate,
    cashier: bill.createdBy,
    customerName: bill.customerName,
    items,
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxableTotal: bill.taxableTotal,
    cgst: sum((i) => i.cgst),
    sgst: sum((i) => i.sgst),
    igst: sum((i) => i.igst),
    cess: sum((i) => i.cess),
    roundOff: bill.roundOff,
    grandTotal: bill.grandTotal,
    payments: bill.payments.map((p) => ({ method: p.method, amount: p.amount })),

    /* Rule 46(e), (f), (m) and (p), every one of them off the bill's own
       snapshot — migration 028 — and none of them off a live join or a guess.
       This line used to read `stateName(shop.stateCode)`: the *shop's* state,
       printed as the place of supply on every invoice it produced, including
       the ones billed to a customer in another state and charged IGST. It was
       a constant wearing the name of a fact.

       A walk-in leaves it null, and the row does not print. The place of supply
       for an unidentified counter sale is the shop's own state, but saying so
       on the paper would be the software asserting something nobody recorded --
       and it is the same reasoning that left the column unbackfilled. */
    placeOfSupply: placeOf(bill.placeOfSupply),
    customerState: placeOf(bill.customerStateCode),
    customerAddress: bill.customerAddress,
    customerGstin: bill.customerGstin,
    ...(bill.supplyType ? { supplyType: bill.supplyType } : {}),
    reverseCharge: bill.reverseCharge,
    rateSummary: rateSummaryOf(items),

    wording: billWording(scheme),
    ...(schemeStatement(scheme) ? { schemeStatement: schemeStatement(scheme) } : {}),

    terms: shop.terms,
    footer: shop.receiptFooter,
  }
}

/** A state code as both halves of "27 — Maharashtra", or nothing at all. */
function placeOf(code: string | null): PlaceOfSupply | null {
  const name = code ? stateName(code) : null
  return code && name ? { code, name } : null
}

/** Lays the page out in a hidden frame and opens the print dialog on it. */
export function printHtml(html: string): Promise<PrintResult> {
  return new Promise((resolve) => {
    /* One dialog per press, however many times the frame says it has loaded.

       A frame given `srcdoc` can fire `load` more than once in a webview —
       once for the blank document it starts on and again for the real one —
       and every one of those used to open a print dialog. Two dialogs from one
       press is not a cosmetic fault: the second appears after the shopkeeper
       has dealt with the first, so it reads as the machine asking to print the
       bill a second time, and the safe-looking answer to that is Cancel. */
    let asked = false

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
      if (asked) return
      asked = true
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
