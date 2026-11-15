import {
  Money, Quantity, Tax, Batches, batchesOf, productsByIds,
  type EntryToEdit, type AmendEntryResult, type SaveDraftEntryResult, type ReceiveResult, type SqlDriver,
} from '@shopos/core'
import type { Line } from './cells'
import { refusalMessage } from './order'

/*
 * Stock In with an entry opened again: a draft to finish, or a posted entry to
 * correct (`stockEntryEdit.ts`). The entry's lines as this screen's lines, the
 * banner that says which of the two it is, and what to say when either is
 * refused.
 */

/** Which entry the form holds, when it holds one already saved. */
export interface Editing {
  id: string
  docNo: string
  /** 0: a draft, saved again in place. 1: posted, and saving corrects it. */
  docstatus: number
}

/** The entry's lines as the form shows them, as typed: a quantity going out without its minus. */
export async function linesFromEntry(
  db: SqlDriver, entry: EntryToEdit, batched: boolean,
): Promise<{ lines: Line[]; missing: number }> {
  const products = new Map((await productsByIds(db, [...new Set(entry.lines.map((l) => l.productId))])).map((p) => [p.id, p]))
  const lines: Line[] = []
  for (const [i, l] of entry.lines.entries()) {
    const product = products.get(l.productId)
    if (!product) continue
    const held = batched ? await batchesOf(db, product.id, { inStockOnly: true }) : []
    const qty = entry.entryType === 'adjustment' ? l.qty : Math.abs(l.qty)
    lines.push({
      key: `${product.id}-${i}-${Date.now()}`, product, held,
      qty: Quantity.formatQty(qty as Quantity.Qty),
      cost: l.unitCost > 0 ? Money.format(l.unitCost) : '', costSide: 'before', hint: null, costFilled: false,
      batchNo: l.batchNo ?? '', expiry: l.expiryDate ? Batches.formatExpiry(l.expiryDate) : '',
      mrp: l.mrp !== null ? Money.format(l.mrp) : product.mrp !== null ? Money.format(product.mrp) : '',
      sellAt: Money.format(l.saleRate ?? product.baseRate),
      gst: String(Tax.bpToPercent(l.taxRateBp)),
      cess: l.cessRateBp ? String(Tax.bpToPercent(l.cessRateBp)) : '',
    })
  }
  return { lines, missing: entry.lines.length - lines.length }
}

/** Says the form holds a saved entry, what saving it will do, and how to start a fresh one instead. */
export function EditingBanner({ editing, onStop }: { editing: Editing; onStop: () => void }) {
  return (
    <div className="card">
      <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ flex: 1, fontSize: 12.5 }}>
          {editing.docstatus === 0 ? (
            <><strong>Finishing a draft.</strong> Nothing in it has touched the stock yet. Save the draft again
              to keep it for later, or post it when the goods are in.</>
          ) : (
            <><strong>Correcting {editing.docNo}.</strong> Change what was wrong and save. {editing.docNo} is
              cancelled and the corrected entry posted under a new number, in one step: the stock and the
              supplier&rsquo;s account move by the difference only.</>
          )}
        </div>
        <button className="btn sm" onClick={onStop}>Start a new entry</button>
      </div>
    </div>
  )
}

type Refusal = Exclude<AmendEntryResult, { ok: true }> | Exclude<SaveDraftEntryResult, { ok: true }>

/** What Stock In says when a draft or a correction is refused. Nothing was changed by either. */
export function editRefusal(r: Refusal, lines: Line[]): string {
  switch (r.code) {
    case 'NOT_A_DRAFT': return 'This draft was posted or removed on another counter since it was opened. Nothing was saved.'
    case 'NOT_POSTED': case 'UNKNOWN_ENTRY':
      return 'This entry was cancelled or changed on another counter since it was opened. Nothing was changed.'
    case 'FROM_AN_ORDER': return 'This delivery was received against a purchase order. Correct it from the order instead.'
    case 'FROM_A_COUNT': return 'This adjustment was posted by a stock count, and the count answers for it. Nothing was changed.'
    case 'WOULD_GO_NEGATIVE': {
      const name = lines.find((l) => l.product.id === r.productId)?.product.name ?? 'An item'
      return `${name}: some of these goods have been sold already, so the correction cannot take that many off. `
        + 'Nothing was changed. Fix the rate or the bill details, or count the shelf if the quantity really was wrong.'
    }
    default: return refusalMessage(r as Exclude<ReceiveResult, { ok: true }>)
  }
}
