import { format as fmtMoney } from '../money.js'
import type { ReceiptDoc } from './receipt/doc.js'

/**
 * The small wordings every printed document shares -- the roll, the A4 sheet
 * and a shop's own HTML template -- written once.
 *
 * They had been written out in each renderer, identically, and a date that
 * prints "13 Sept 2026" on the sheet and "13-Sep-2026" on the roll is how two
 * copies of one bill stop looking like the same bill.
 */

/** `2026-09-13` or an ISO instant, as a shopkeeper reads a date: `13 Sept 2026`. */
export function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** "02:35 pm", in the till's own clock, or '' when there is no usable time. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso || iso.length <= 10) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

/** The date, and the time after it when the document knows one. */
export function formatDateTime(date: string, at?: string | null): string {
  const time = formatTime(at)
  return time ? `${formatDate(date)} ${time}` : formatDate(date)
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Escaped at the one place a value becomes markup.
 *
 * The values are the shop's own, but a product called "Salt & Pepper 500g" or
 * a customer called "Smith <Retail>" would break the page, and a template is
 * exactly where a shop puts a value somewhere nobody anticipated.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The flat record a `text` block's {{tokens}} are looked up in, on paper or on
 * screen. Typed as the plain record `docFormat`'s `Facts` is, rather than
 * importing it: `docFormat` reaches this module through `htmlTemplate`, and
 * the import would close a loop the architecture test refuses.
 */
export function factsFor(doc: ReceiptDoc): Record<string, string> {
  return {
    'shop.name': doc.shop.name,
    'shop.address': doc.shop.address ?? '',
    'shop.phone': doc.shop.phone ?? '',
    'shop.gstin': doc.shop.gstin ?? '',
    'doc.no': doc.docNo,
    'doc.date': formatDate(doc.postingDate),
    'customer.name': doc.customerName ?? '',
    total: fmtMoney(doc.grandTotal),
  }
}
