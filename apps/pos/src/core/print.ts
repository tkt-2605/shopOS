import { invoke } from '@tauri-apps/api/core'
import { deviceSetting } from './device'
import { logoRaster, logoBlockOf } from './logoRaster'
import {
  Receipt, loadShopProfile, loadBillDetail, loadCustomer, customerAccount, businessDate, formatFor,
  loadTaxScheme, billWording, schemeStatement, rateSummaryOf, batchTextFor,
  type SqlDriver, type ReceiptDoc, type ReceiptItem,
} from '@shopos/core'

type StatementDoc = Parameters<typeof Receipt.buildStatement>[0]

/**
 * Where a roll's bytes go, and what printers this machine has.
 *
 * The till's is three Tauri commands, and Windows answers them. A test hands
 * in its own and reads back what would have been printed, which is the only
 * way to check a receipt end to end on a machine with no printer: the bytes a
 * shop's printer is sent are exactly the bytes `print` receives.
 *
 * Each call may throw; the functions below turn that into the answer a screen
 * can show, so a printer that is not there fails the same way whichever one is
 * plugged in.
 */
export interface ReceiptPrinter {
  list(): Promise<string[]>
  defaultName(): Promise<string | null>
  /** `printer` null means whatever Windows calls the default. */
  print(printer: string | null, bytes: number[]): Promise<void>
}

/** The printers Windows knows, through the Rust side. */
export const tauriPrinter: ReceiptPrinter = {
  list: () => invoke<string[]>('list_printers'),
  defaultName: () => invoke<string | null>('default_printer'),
  print: async (printer, bytes) => { await invoke('print_receipt', { printer, bytes }) },
}

let printer: ReceiptPrinter = tauriPrinter

/** Swaps the printer, and hands back a function that puts the last one back. */
export function setReceiptPrinter(next: ReceiptPrinter): () => void {
  const before = printer
  printer = next
  return () => { printer = before }
}

export async function listPrinters(): Promise<string[]> {
  try {
    return await printer.list()
  } catch {
    return []
  }
}

export async function defaultPrinter(): Promise<string | null> {
  try {
    return await printer.defaultName()
  } catch {
    return null
  }
}

export type PrintResult = { ok: true } | { ok: false; message: string }

/**
 * Builds the receipt from what was actually saved, not from the cart in memory —
 * so the paper matches the record even if the two ever disagree.
 */
export async function printBill(db: SqlDriver, billId: string): Promise<PrintResult> {
  const bill = await loadBillDetail(db, billId)
  if (!bill) return { ok: false, message: 'That bill could not be found.' }

  /* One read of the shop's own details rather than four, and from the service
     that owns those keys — so a field added there reaches the paper without
     this file having to be told about it. */
  const shop = await loadShopProfile(db)

  /* What this shop is allowed to call the paper it hands over. A composition
     dealer's document is a Bill of Supply and has to carry the Rule 49
     sentence; an unregistered shop's is an Invoice. The roll is the document
     for a counter sale -- there is no sheet behind it -- so it is the roll that
     has to be right about this. */
  const scheme = await loadTaxScheme(db)

  const batches = await batchTextFor(db, billId)
  const items = bill.items.map((i): ReceiptItem => ({
    name: i.productName,
    qty: i.qty,
    saleUnit: i.saleUnit,
    rate: i.rate,
    mrp: i.mrp,
    lineTotal: i.lineTotal,
    batch: batches.get(i.id) ?? null,
    // Not printed per line on 42 columns; they are what the rate summary is
    // built from.
    taxableValue: i.taxableValue,
    taxRateBp: i.taxRateBp,
    cgst: i.cgst,
    sgst: i.sgst,
    igst: i.igst,
    cess: i.cess,
    rateIncludesTax: i.rateIncludesTax,
  }))

  const doc: ReceiptDoc = {
    shop: { name: shop.name, address: shop.address, phone: shop.phone, gstin: shop.gstin },
    docNo: bill.docNo,
    postingDate: bill.postingDate,
    cashier: bill.createdBy,
    customerName: bill.customerName,
    items,
    wording: billWording(scheme),
    ...(schemeStatement(scheme) ? { schemeStatement: schemeStatement(scheme) } : {}),
    rateSummary: rateSummaryOf(items),
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxableTotal: bill.taxableTotal,
    cgst: bill.items.reduce((s, i) => s + i.cgst, 0) as never,
    sgst: bill.items.reduce((s, i) => s + i.sgst, 0) as never,
    igst: bill.items.reduce((s, i) => s + i.igst, 0) as never,
    cess: bill.items.reduce((s, i) => s + i.cess, 0) as never,
    roundOff: bill.roundOff,
    grandTotal: bill.grandTotal,
    payments: bill.payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered })),
    footer: shop.receiptFooter,
  }

  /* Which layout, rather than the one layout. A shop that has designed its own
     receipt gets it here; one that never opened the designer gets the format the
     product has always printed, which is what `formatFor` falls back to. */
  const format = await formatFor(db, { kind: 'bill', channel: 'roll' })

  // Reduced to dots only when the format prints it: most bills never pay for the decode.
  const logo = logoBlockOf(format)
  if (logo && shop.logo) doc.logoRaster = await logoRaster(shop.logo, format.paper, logo.opts?.height)

  return send(Receipt.buildReceipt(doc, format), printerName())
}

/**
 * The page a customer takes away.
 *
 * Built from the ledger rather than from the open bills, because a balance
 * someone is disputing is settled by showing them the payments as well as the
 * charges. Same 42 columns as a receipt, so it comes out of the printer that is
 * already on the counter.
 */
export async function printStatement(
  db: SqlDriver,
  customerId: string,
  range: { from?: string; to?: string } = {},
): Promise<PrintResult> {
  const customer = await loadCustomer(db, customerId)
  if (!customer) return { ok: false, message: 'That customer could not be found.' }

  const account = await customerAccount(db, customerId, range)
  if (account.entries.length === 0) {
    return { ok: false, message: 'There is nothing on this account for that period.' }
  }

  const shop = await loadShopProfile(db)

  const doc: StatementDoc = {
    shop: { name: shop.name, address: shop.address, phone: shop.phone, gstin: shop.gstin },
    customerName: customer.name,
    customerCode: customer.code,
    customerPhone: customer.phone,
    from: range.from ?? null,
    to: range.to ?? businessDate(),
    openingBalance: account.openingBalance,
    lines: account.entries.map((e) => ({
      docNo: e.docNo,
      postingDate: e.postingDate,
      description: e.description,
      debit: e.debit,
      credit: e.credit,
      balance: e.balance,
    })),
    closingBalance: account.closingBalance,
    totals: account.totals,
    footer: shop.receiptFooter,
  }

  return send(Receipt.buildStatement(doc), printerName())
}

/**
 * Blank means "whatever Windows calls the default", which is what `send` expects.
 *
 * Takes no driver and is not async: the printer stopped being a row in the
 * shop's `settings` table when device-local settings landed, because the
 * printer is plugged into this machine and the second till's is not. The
 * parameter outlived the query it was for.
 */
function printerName(): string | null {
  return deviceSetting('thermal_printer')
}

/** The one place bytes go to a printer, so both documents fail the same way. */
async function send(text: string, name: string | null): Promise<PrintResult> {
  try {
    // Byte for character: the logo is raw bytes, and the text is ASCII already. See `toBytes`.
    await printer.print(name, Receipt.toBytes(text))
    return { ok: true }
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : 'The printer did not respond.' }
  }
}
