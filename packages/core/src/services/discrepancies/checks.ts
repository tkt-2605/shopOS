import type { SqlDriver } from '../../db/driver.js'
import { formatWithSymbol, type Money } from '../../money.js'
import { formatQty, type Qty } from '../../quantity.js'
import { customerOutstanding } from '../payments/outstanding.js'
import { reconcileReturnedQty } from '../returns/reconcile.js'
import { reconcileFulfilledQty } from '../documents/reconcile.js'
import { reconcileLoyalty } from '../loyaltyLedger.js'
import { ledgerChecks } from '../../repos/ledger.js'
import { documentsWithoutEntries } from '../ledger.js'
import { unreadConflictCount, unreadQuarantineCount } from '../sync/review.js'
import type { Discrepancy } from './types.js'

/*
 * Each check reads the shop as it stands and says what does not add up, in a
 * shopkeeper's words. None of them writes anything.
 *
 * raw: grouped sums across a document and its returns or fulfilments, which
 * read more plainly as the SQL than as the builder spelling them out.
 */

const qty = (q: number) => formatQty(q as Qty)
const rupees = (m: number) => formatWithSymbol(m as Money)

/** One item, given back for more than it was sold for: two counters took the same return while apart. */
export async function refundedTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; product_name: string; sale_unit: string; qty: number; line_total: number
    bill_no: string; customer_name: string | null; returned: number; refunded: number
    notes: string; last_at: string
  }>(
    `SELECT bi.id, bi.product_name, bi.sale_unit, bi.qty, bi.line_total, b.doc_no AS bill_no, b.customer_name,
            SUM(ri.qty) AS returned, SUM(ri.refund_amount) AS refunded, MAX(r.created_at) AS last_at,
            GROUP_CONCAT(r.doc_no || ' by ' || COALESCE(u.full_name, u.username, 'someone'), ', ') AS notes
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.return_id AND r.docstatus = 1
       JOIN bill_items bi ON bi.id = ri.bill_item_id
       JOIN bills b ON b.id = bi.bill_id
       LEFT JOIN users u ON u.id = r.created_by
      GROUP BY bi.id
     HAVING SUM(ri.qty) > bi.qty`)
  return rows.map((r) => {
    const over = Math.max(0, r.refunded - r.line_total)
    return {
      key: `refunded_twice:${r.id}:${r.returned}`,
      kind: 'refunded_twice',
      area: 'money',
      at: r.last_at,
      amount: over as Money,
      title: `${r.product_name} was taken back more times than it was sold`,
      detail: `Bill ${r.bill_no}${r.customer_name ? ` (${r.customer_name})` : ''} sold ${qty(r.qty)} ${r.sale_unit}; `
        + `${qty(r.returned)} came back, on ${r.notes}. ${rupees(r.refunded)} was refunded against a line of `
        + `${rupees(r.line_total)}${over > 0 ? `, ${rupees(over)} more than it was sold for` : ''}.`,
      action: 'Two counters took this return while they could not reach each other. Recover the money from '
        + 'the customer if you can, and count the item: the stock shows it put back each time.',
      refs: [r.bill_no, ...r.notes.split(', ').map((n) => n.split(' by ')[0]!)],
    }
  })
}

/** An order or quotation billed for more than it asked for: billed on two counters. */
export async function orderBilledTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; product_name: string; sale_unit: string; qty: number; doc_no: string; billed: number
  }>(
    `SELECT di.id, di.product_name, di.sale_unit, di.qty, d.doc_no, x.billed FROM (
       SELECT di.id,
              COALESCE((SELECT SUM(bf.qty) FROM bill_fulfilments bf
                          JOIN bills b ON b.id = bf.bill_id AND b.docstatus = 1
                         WHERE bf.document_item_id = di.id), 0)
            + COALESCE((SELECT SUM(df.qty) FROM document_fulfilments df WHERE df.document_item_id = di.id), 0) AS billed
         FROM document_items di) x
       JOIN document_items di ON di.id = x.id
       JOIN documents d ON d.id = di.document_id
      WHERE x.billed > di.qty`)
  return rows.map((r) => ({
    key: `order_billed_twice:${r.id}:${r.billed}`,
    kind: 'order_billed_twice',
    area: 'stock',
    at: null,
    amount: null,
    title: `${r.doc_no} was billed for more than was ordered`,
    detail: `${r.product_name}: ordered ${qty(r.qty)} ${r.sale_unit}, billed ${qty(r.billed)}.`,
    action: 'The order was billed on two counters. Check whether the goods went out twice; if they did not, '
      + 'cancel the bill that should not stand.',
    refs: [r.doc_no],
  }))
}

/** Stock the shop says it has less than none of: sold on two counters, or a delivery not entered. */
export async function soldBelowZero(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{ id: string; name: string; base_unit: string; qty_on_hand: number }>(
    `SELECT p.id, p.name, p.base_unit, s.qty_on_hand FROM product_stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.qty_on_hand < 0 AND p.is_stock_tracked = 1 AND p.deleted_at IS NULL
      ORDER BY p.name`)
  return rows.map((r) => ({
    key: `sold_below_zero:${r.id}`,
    kind: 'sold_below_zero',
    area: 'stock',
    at: null,
    amount: null,
    title: `${r.name} is below zero`,
    detail: `The shop's stock of ${r.name} is ${qty(r.qty_on_hand)} ${r.base_unit}: more was sold than was ever on the shelf.`,
    action: 'Often two counters sold the last ones while apart, or goods came in that were never entered. '
      + 'Count it, and enter the delivery if one is missing.',
    refs: [],
  }))
}

/** A customer owing more than their limit: credit given on two counters at once. */
export async function overCreditLimit(db: SqlDriver): Promise<Discrepancy[]> {
  const limited = await db.query<{ id: string; name: string; credit_limit: number }>(
    `SELECT id, name, credit_limit FROM customers WHERE credit_limit > 0 AND deleted_at IS NULL ORDER BY name`)
  const found: Discrepancy[] = []
  for (const c of limited) {
    const owed = await customerOutstanding(db, c.id)
    if (owed <= c.credit_limit) continue
    found.push({
      key: `over_credit_limit:${c.id}`,
      kind: 'over_credit_limit',
      area: 'money',
      at: null,
      amount: (owed - c.credit_limit) as Money,
      title: `${c.name} owes more than their credit limit`,
      detail: `${c.name} owes ${rupees(owed)} against a limit of ${rupees(c.credit_limit)}.`,
      action: 'Each counter checks the limit against what it knows, so two counters apart can each give '
        + 'credit up to it. Take a payment before giving more.',
      refs: [],
    })
  }
  return found
}

/** A short, stable name for a set of ids, so a key changes when the set does. */
function fingerprint(ids: readonly string[]): string {
  let h = 0x811c9dc5
  for (const ch of [...ids].sort().join('|')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/**
 * Figures the merge found out of line with their records and left as they
 * are, because correcting them the other way could hand out a refund or points
 * the shop did not give. Usually a record still on its way.
 */
export async function figuresLeft(db: SqlDriver): Promise<Discrepancy[]> {
  const returned = (await reconcileReturnedQty(db)).filter((d) => !d.repairable).map((d) => d.billItemId)
  const fulfilled = (await reconcileFulfilledQty(db)).filter((d) => !d.repairable).map((d) => d.documentItemId)
  const points = (await reconcileLoyalty(db)).filter((d) => !d.repairable).map((d) => d.id)
  const all = [...returned, ...fulfilled, ...points]
  if (all.length === 0) return []
  const what = [
    returned.length > 0 ? `${returned.length} returned quantit${returned.length === 1 ? 'y' : 'ies'}` : null,
    fulfilled.length > 0 ? `${fulfilled.length} order line${fulfilled.length === 1 ? '' : 's'}` : null,
    points.length > 0 ? `${points.length} loyalty figure${points.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ')
  return [{
    key: `figures_left:${fingerprint(all)}`,
    kind: 'figures_left',
    area: 'records',
    at: null,
    amount: null,
    title: 'Some figures differ from the records behind them',
    detail: `${what} do not match the documents they are worked out from, and were left as they are.`,
    action: 'Usually a document still on its way from another till: sync with every counter. If this is '
      + 'still here once they all agree, a record was lost and needs a person.',
    refs: [],
  }]
}

/** The books, held to themselves and to the stock ledger. */
export async function theBooks(db: SqlDriver): Promise<Discrepancy[]> {
  const found: Discrepancy[] = []
  const checks = await ledgerChecks(db)
  if (checks.unbalanced.length > 0) {
    found.push({
      key: `books_unbalanced:${fingerprint(checks.unbalanced.map((u) => `${u.voucherType}:${u.voucherId}`))}`,
      kind: 'books_unbalanced',
      area: 'books',
      at: null,
      amount: null,
      title: 'The books have entries that do not balance',
      detail: `${checks.unbalanced.length} document(s) posted debits and credits that differ.`,
      action: 'Tell whoever supports your ShopOS: this should not be possible, and the figures on the '
        + 'profit and loss and balance sheet are not to be relied on until it is fixed.',
      refs: checks.unbalanced.slice(0, 10).map((u) => `${u.voucherType} ${u.voucherId}`),
    })
  }
  if (checks.stockDrift !== 0) {
    found.push({
      key: `books_stock:${checks.stockDrift}`,
      kind: 'books_stock',
      area: 'books',
      at: null,
      amount: Math.abs(checks.stockDrift) as Money,
      title: 'The books and the stock ledger disagree about what the stock is worth',
      detail: `The stock account in the books differs from the stock ledger by ${rupees(Math.abs(checks.stockDrift))}.`,
      action: 'Sync with every counter first; a document part-way across can cause this. If it stays, '
        + 'tell whoever supports your ShopOS.',
      refs: [],
    })
  }
  const missing = await documentsWithoutEntries(db)
  if (missing.length > 0) {
    found.push({
      key: `books_missing:${fingerprint(missing)}`,
      kind: 'books_missing',
      area: 'books',
      at: null,
      amount: null,
      title: 'Some documents are not in the books',
      detail: `${missing.length} submitted document(s) have no entries in the books.`,
      action: 'If the tills are still catching up with each other, this clears itself once they have. If it '
        + 'stays, the document’s own figures do not add up: open it and check its totals, because the books '
        + 'leave it out rather than guess at it.',
      refs: missing.slice(0, 10),
    })
  }
  return found
}

/** What the last syncs could not settle by themselves. */
export async function syncLeftovers(db: SqlDriver): Promise<Discrepancy[]> {
  const found: Discrepancy[] = []
  const dropped = await unreadConflictCount(db)
  if (dropped > 0) {
    const newest = await db.get<{ id: string }>(
      `SELECT id FROM sync_conflicts WHERE acknowledged = 0 ORDER BY at DESC LIMIT 1`)
    found.push({
      key: `sync_dropped:${newest?.id ?? ''}`,
      kind: 'sync_dropped',
      area: 'sync',
      at: null,
      amount: null,
      title: `${dropped} change(s) made on two counters at once, and one of each was kept`,
      detail: 'The same thing was changed on two tills before they synced, and the later change won.',
      action: 'Look at the list under Settings, Other tills, and redo any change that should have stood.',
      refs: [],
    })
  }
  const setAside = await unreadQuarantineCount(db)
  if (setAside > 0) {
    const newest = await db.get<{ id: string }>(
      `SELECT id FROM sync_quarantine WHERE acknowledged = 0 ORDER BY at DESC LIMIT 1`)
    found.push({
      key: `sync_set_aside:${newest?.id ?? ''}`,
      kind: 'sync_set_aside',
      area: 'sync',
      at: null,
      amount: null,
      title: `${setAside} record(s) from another till could not be taken in`,
      detail: 'This till holds something the other till does not, or the other way round, until these are dealt with.',
      action: 'Look at the list under Settings, Other tills; most say what to change.',
      refs: [],
    })
  }
  return found
}
