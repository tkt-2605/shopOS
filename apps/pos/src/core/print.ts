import { invoke } from '@tauri-apps/api/core'
import {
  Receipt, getSetting, loadBillDetail,
  type SqlDriver, type ReceiptDoc, type ReceiptItem,
} from '@shopos/core'

export async function listPrinters(): Promise<string[]> {
  try {
    return await invoke<string[]>('list_printers')
  } catch {
    return []
  }
}

export async function defaultPrinter(): Promise<string | null> {
  try {
    return await invoke<string | null>('default_printer')
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

  const doc: ReceiptDoc = {
    shop: {
      name: (await getSetting(db, 'shop_name')) ?? 'ShopOS',
      address: await getSetting(db, 'shop_address'),
      phone: await getSetting(db, 'shop_phone'),
      gstin: await getSetting(db, 'shop_gstin'),
    },
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
    })),
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxableTotal: bill.taxableTotal,
    cgst: bill.items.reduce((s, i) => s + i.cgst, 0) as never,
    sgst: bill.items.reduce((s, i) => s + i.sgst, 0) as never,
    igst: bill.items.reduce((s, i) => s + i.igst, 0) as never,
    grandTotal: bill.grandTotal,
    payments: bill.payments.map((p) => ({ method: p.method, amount: p.amount })),
    footer: await getSetting(db, 'receipt_footer'),
  }

  const text = Receipt.buildReceipt(doc)
  const printer = (await getSetting(db, 'thermal_printer')) ?? null

  try {
    await invoke('print_receipt', {
      printer,
      bytes: Array.from(new TextEncoder().encode(text)),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : 'The printer did not respond.' }
  }
}
