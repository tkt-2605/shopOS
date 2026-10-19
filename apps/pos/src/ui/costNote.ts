import { Money, type CostHint } from '@shopos/core'

/*
 * The one sentence three screens say about a cost they have filled in: the
 * item form, Stock In and a purchase order. Written once so the three cannot
 * come to disagree about where a figure came from.
 */

/** `15 Oct 2026`, as the bills print a date. */
function day(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** "last paid ₹61.00 on 15 Oct 2026 · Paper Mills", or "your cost price ₹62.00". */
export function costNote(hint: CostHint): string {
  const amount = `₹${Money.format(hint.unitCost)}`
  if (hint.source === 'item') return `your cost price ${amount}`
  const when = hint.postedOn ? ` on ${day(hint.postedOn)}` : ''
  const who = hint.supplierName ? ` · ${hint.supplierName}` : ''
  return `${hint.source === 'opening' ? 'opening stock at' : 'last paid'} ${amount}${when}${who}`
}
