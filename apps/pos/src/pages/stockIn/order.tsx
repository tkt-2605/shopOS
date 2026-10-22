import {
  Money, Quantity, Tax, Batches, batchesOf, costHint, loadDocument, productsByIds, receivedCost, periodClosedMessage,
  type ProductListItem, type ReceiveResult, type ReceivedLine, type SqlDriver,
} from '@shopos/core'
import { belowCostMessage } from '../../ui/belowCost'
import { ownPrice, type Line } from './cells'

/*
 * Stock In receiving a purchase order: the order's lines as this screen's
 * lines, those lines back as the delivery `receivePurchaseOrder` takes, and
 * what to say when either side refuses.
 */

/** A line for an item, filled in as Stock In always fills one. */
export async function blankLine(db: SqlDriver, product: ProductListItem, batched: boolean): Promise<Line> {
  const [held, hint] = await Promise.all([
    batched ? batchesOf(db, product.id, { inStockOnly: true }) : Promise.resolve([]),
    // The last price paid, or the item's cost price: typed in for the person, who can change it.
    costHint(db, product.id),
  ])
  return {
    key: `${product.id}-${Date.now()}-${Math.random()}`, product, qty: '1', held,
    cost: hint ? Money.format(hint.unitCost) : '', costSide: 'before', hint, costFilled: hint !== null,
    batchNo: '', expiry: '',
    mrp: product.mrp !== null ? Money.format(product.mrp) : '',
    sellAt: Money.format(product.baseRate),
    gst: String(Tax.bpToPercent(product.taxRateBp)),
    cess: product.cessRateBp ? String(Tax.bpToPercent(product.cessRateBp)) : '',
  }
}

export interface OrderToReceive {
  id: string
  docNo: string
  supplierId: string | null
  lines: Line[]
}

/**
 * The order's open lines, as lines of this entry: what is left on each, at the
 * cost and GST the order was raised at, ready for the batch, the prices and
 * whatever the supplier actually sent.
 */
export async function orderLines(
  db: SqlDriver, id: string, batched: boolean,
): Promise<{ ok: true; order: OrderToReceive } | { ok: false; message: string }> {
  const doc = await loadDocument(db, id)
  if (!doc || doc.kind !== 'purchase_order' || doc.docstatus !== 1) {
    return { ok: false, message: 'That purchase order cannot be received.' }
  }
  const open = doc.items.filter((i) => i.remainingQty > 0)
  if (open.length === 0) return { ok: false, message: `Everything on ${doc.docNo} has already been received.` }

  const products = new Map((await productsByIds(db, open.map((i) => i.productId))).map((p) => [p.id, p]))
  const lines: Line[] = []
  for (const i of open) {
    const product = products.get(i.productId)
    if (!product) continue
    lines.push({
      ...(await blankLine(db, product, batched)),
      qty: Quantity.formatQty(i.remainingQty),
      cost: Money.format(receivedCost(i)), costSide: 'before', costFilled: false,
      gst: String(Tax.bpToPercent(i.taxRateBp)),
      cess: i.cessRateBp ? String(Tax.bpToPercent(i.cessRateBp)) : '',
      orderLine: { id: i.id, left: i.remainingQty },
    })
  }
  return { ok: true, order: { id: doc.id, docNo: doc.docNo, supplierId: doc.supplierId, lines } }
}

/**
 * The entry's lines as the delivery. A blank cost on an order line comes in at
 * the order's cost; on any other it is zero, as Stock In has always posted it.
 */
export function receivedLines(
  lines: Line[], costText: (l: Line) => string, expiries: (string | null)[], batched: boolean,
): ReceivedLine[] {
  const pct = (typed: string) => Math.round((Number(typed) || 0) * 100)
  return lines.map((l, i) => {
    const cost = Money.parseMoney(costText(l))
    return {
      ...(l.orderLine ? { itemId: l.orderLine.id } : { productId: l.product.id }),
      qty: Quantity.fromUnits(Number(l.qty) || 0),
      ...(cost !== null ? { unitCost: cost } : l.orderLine ? {} : { unitCost: 0 as Money.Money }),
      ...(batched && l.batchNo.trim() !== '' ? { batchNo: l.batchNo, expiryDate: expiries[i] ?? null } : {}),
      ...ownPrice(l),
      taxRateBp: pct(l.gst), cessRateBp: pct(l.cess),
    }
  })
}

/** What is left on the order once a delivery is in, said beside the posted note. */
export async function leftOnOrder(db: SqlDriver, id: string, docNo: string): Promise<string> {
  const open = (await loadDocument(db, id))?.items.filter((i) => i.remainingQty > 0).length ?? 0
  return open === 0
    ? `${docNo} is fully received.`
    : `${docNo} still has ${open} line${open === 1 ? '' : 's'} open. If the rest is not coming, close it short from the order.`
}

/** What Stock In says when a delivery against an order is refused. */
export function receiveRefusal(r: Exclude<ReceiveResult, { ok: true }>, docNo: string, lines: Line[]): string {
  const named = 'itemId' in r ? lines.find((l) => l.orderLine?.id === r.itemId)?.product.name ?? 'A line' : 'A line'
  switch (r.code) {
    case 'OVER_RECEIVED':
      return `${named} has only ${Quantity.formatQty(r.remaining)} left on ${docNo}, across all its batches. `
        + 'Anything more is not on the order: post it as a separate entry.'
    case 'NOTHING_ENTERED': return `Nothing on ${docNo} has a quantity. Enter what came.`
    case 'NOTHING_LEFT': return `Everything on ${docNo} has already been received.`
    case 'INVALID_QTY': return `${named} has a quantity below zero.`
    case 'INVALID_COST': return 'A cost cannot be below zero.'
    case 'UNKNOWN_LINE': case 'NOT_FOUND': case 'CANCELLED': case 'NOT_SUBMITTED': case 'WRONG_KIND':
      return `${docNo} has changed since it was opened. Open it again from Purchase orders.`
    default: return refusalMessage(r)
  }
}

/** What Stock In says when an entry, or the delivery behind an order, is refused. */
export function refusalMessage(r: Exclude<ReceiveResult, { ok: true }>): string {
  switch (r.code) {
    case 'BELOW_COST': return belowCostMessage(r)
    case 'NO_LINES': return 'Add at least one item.'
    case 'ZERO_QTY': return 'Every line needs a quantity that is not zero.'
    case 'INFLOW_NEEDS_POSITIVE_QTY': return 'A purchase or opening entry cannot be negative. Use Adjustment instead.'
    case 'BAD_BATCH_NO': return 'A batch number is too long. Forty letters and digits at most.'
    case 'BAD_EXPIRY': return 'One of the expiry dates is not a date.'
    case 'EXPIRY_MISMATCH':
      return `Batch ${r.batchNo} is already recorded as expiring ${Batches.formatExpiry(r.recorded)}. `
        + 'A batch has one expiry — check the pack and the delivery note.'
    case 'UNKNOWN_BATCH': return `There is no batch ${r.batchNo} of that item in stock.`
    case 'UNKNOWN_PRODUCT': return 'One of the items no longer exists.'
    case 'BATCH_WOULD_GO_NEGATIVE':
      return `Batch ${r.batchNo} holds only ${Quantity.formatQty(r.available)}. Check the quantities.`
    case 'PERIOD_CLOSED': return periodClosedMessage(r.closedThrough)
    case 'WOULD_GO_NEGATIVE': return 'That would take stock below zero. Check the quantities.'
    default: return 'That entry could not be posted.'
  }
}

/** Says the entry is an order's delivery, and how to make it an ordinary one instead. */
export function ReceivingBanner({ docNo, onStop }: { docNo: string; onStop: () => void }) {
  return (
    <div className="card">
      <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ flex: 1, fontSize: 12.5 }}>
          <strong>Receiving {docNo}.</strong> Each line starts at what is still open on the order.
          Change a quantity to what came, or 0 for nothing; add the same item again for a second batch.
          An item the order did not ask for comes in on the same bill. What does not come stays open on the order.
        </div>
        <button className="btn sm" onClick={onStop}>Not against the order</button>
      </div>
    </div>
  )
}
