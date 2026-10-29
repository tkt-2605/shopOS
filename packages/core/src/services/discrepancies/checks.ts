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

/**
 * A bill cancelled on one counter and taken back on another.
 *
 * Each is a whole answer on its own: the cancel puts the goods back and the
 * money with them, and so does the return. Together the money went back
 * twice and the shelf shows the goods put back twice. `refundedTwice` counts
 * returns against what was sold and so never sees it -- one return is not more
 * than the line -- which is why it is its own check.
 */
export async function refundedAndCancelled(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; bill_no: string; customer_name: string | null; refunded: number; returns: string; last_at: string
  }>(
    `SELECT b.id, b.doc_no AS bill_no, b.customer_name, SUM(r.refund_total) AS refunded,
            GROUP_CONCAT(r.doc_no, ', ') AS returns, MAX(r.created_at) AS last_at
       FROM bills b
       JOIN sales_returns r ON r.bill_id = b.id AND r.docstatus = 1
      WHERE b.docstatus = 2
      GROUP BY b.id`)
  return rows.map((r) => ({
    key: `refunded_and_cancelled:${r.id}:${r.returns}`,
    kind: 'refunded_and_cancelled',
    area: 'money',
    at: r.last_at,
    amount: r.refunded as Money,
    title: `Bill ${r.bill_no} was cancelled and taken back as well`,
    detail: `Bill ${r.bill_no}${r.customer_name ? ` (${r.customer_name})` : ''} was cancelled, and `
      + `${rupees(r.refunded)} was also refunded against it on ${r.returns}.`,
    action: 'Two counters dealt with this bill while they could not reach each other. The money went back '
      + 'twice and the stock shows the goods put back twice: cancel the return that should not stand, and '
      + 'recover the money from the customer if you can.',
    refs: [r.bill_no, ...r.returns.split(', ')],
  }))
}

/**
 * A bill on account paid off by more than was put on account: the customer's
 * payment taken on two counters. Only one payment happened at the counter, so
 * one drawer will be short by the other.
 */
export async function paidTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; bill_no: string; customer_name: string | null; customer_id: string | null; owed: number; paid: number
    payments: string; last_at: string
  }>(
    `SELECT b.id, b.doc_no AS bill_no, b.customer_name, b.customer_id,
            (SELECT COALESCE(SUM(bp.amount), 0) FROM bill_payments bp
              WHERE bp.bill_id = b.id AND bp.method = 'credit') AS owed,
            SUM(a.amount) AS paid, GROUP_CONCAT(p.doc_no, ', ') AS payments, MAX(p.created_at) AS last_at
       FROM bills b
       JOIN payment_allocations a ON a.bill_id = b.id
       JOIN payment_entries p ON p.id = a.payment_id AND p.docstatus = 1
      WHERE b.docstatus = 1
      GROUP BY b.id
     HAVING COUNT(DISTINCT p.id) > 1 AND SUM(a.amount) > owed`)
  return rows.map((r) => ({
    key: `paid_twice:${r.id}:${r.paid}`,
    kind: 'paid_twice',
    area: 'money',
    at: r.last_at,
    amount: (r.paid - r.owed) as Money,
    title: `Bill ${r.bill_no} was paid off more than once`,
    detail: `Bill ${r.bill_no}${r.customer_name ? ` (${r.customer_name})` : ''} had ${rupees(r.owed)} on account; `
      + `${rupees(r.paid)} was recorded against it, on ${r.payments}.`,
    action: 'Two counters took this payment while they could not reach each other. Count the drawers: if '
      + 'only one payment was really made, open the account and press Cancel payment on the other.',
    refs: [r.bill_no, ...r.payments.split(', ')],
    customerId: r.customer_id,
  }))
}

/**
 * A customer's advance spent on more than it held: spent on two counters.
 *
 * Each counter set the same advance against a bill of its own, and both stand
 * (`UNION_LINES` in `sync/record.ts`), so the bills read as paid while the
 * customer's account shows what is really still owed. One of them is not paid.
 */
export async function advanceSpentTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; doc_no: string; customer_name: string | null; customer_id: string | null; amount: number; spent: number
    bills: string; last_at: string
  }>(
    `SELECT p.id, p.doc_no, c.name AS customer_name, p.customer_id, p.amount, SUM(a.amount) AS spent,
            GROUP_CONCAT(b.doc_no, ', ') AS bills, MAX(p.updated_at) AS last_at
       FROM payment_entries p
       JOIN payment_allocations a ON a.payment_id = p.id
       JOIN bills b ON b.id = a.bill_id
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.docstatus = 1 AND p.party_type = 'customer' AND p.direction = 'in'
      GROUP BY p.id
     HAVING SUM(a.amount) > p.amount`)
  return rows.map((r) => ({
    key: `advance_spent_twice:${r.id}:${r.spent}`,
    kind: 'advance_spent_twice',
    area: 'money',
    at: r.last_at,
    amount: (r.spent - r.amount) as Money,
    title: `${r.customer_name ?? 'A customer'}'s payment ${r.doc_no} was spent on more than it was worth`,
    detail: `${r.doc_no} was ${rupees(r.amount)}; ${rupees(r.spent)} of bills were paid from it: ${r.bills}.`,
    action: 'Two counters used this advance while they could not reach each other. '
      + `${rupees(r.spent - r.amount)} of those bills is still owed: collect it, or put it on the customer's account.`,
    refs: [r.doc_no, ...r.bills.split(', ')],
    customerId: r.customer_id,
  }))
}

/**
 * Loyalty points spent on more than one counter: the same points redeemed
 * against two bills while the counters could not reach each other. Each
 * redemption is a line of its own bill, so both stand, and the customer had
 * the discount twice for points they had once.
 */
export async function pointsSpentTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    id: string; customer_name: string | null; points: number; spent: number; bills: string; last_at: string
  }>(
    `SELECT e.id, c.name AS customer_name, e.points, SUM(r.points) AS spent,
            GROUP_CONCAT(b.doc_no, ', ') AS bills, MAX(r.created_at) AS last_at
       FROM loyalty_entries e
       JOIN loyalty_redemptions r ON r.loyalty_entry_id = e.id AND r.reversed_at IS NULL
       JOIN bills b ON b.id = r.bill_id AND b.docstatus = 1
       LEFT JOIN customers c ON c.id = e.customer_id
      GROUP BY e.id
     HAVING SUM(r.points) > e.points`)
  return rows.map((r) => ({
    key: `points_spent_twice:${r.id}:${r.spent}`,
    kind: 'points_spent_twice',
    area: 'money',
    at: r.last_at,
    amount: null,
    title: `${r.customer_name ?? 'A customer'} spent the same loyalty points twice`,
    detail: `${r.spent} points were redeemed against ${r.bills}, from ${r.points} the customer had.`,
    action: 'Two counters took these points while they could not reach each other, so the discount was given '
      + 'twice. Take it into account next time the customer redeems, or recover it if you can.',
    refs: r.bills.split(', '),
  }))
}

/**
 * One cancelled bill corrected on two counters: two new bills standing for one
 * sale, the goods out twice and the customer charged twice.
 */
export async function correctedTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{ id: string; doc_no: string; customer_name: string | null; bills: string; last_at: string }>(
    `SELECT o.id, o.doc_no, o.customer_name, GROUP_CONCAT(b.doc_no, ', ') AS bills, MAX(b.created_at) AS last_at
       FROM bills o
       JOIN bills b ON b.amended_from = o.id AND b.docstatus = 1
      GROUP BY o.id
     HAVING COUNT(*) > 1`)
  return rows.map((r) => ({
    key: `corrected_twice:${r.id}:${r.bills}`,
    kind: 'corrected_twice',
    area: 'money',
    at: r.last_at,
    amount: null,
    title: `Bill ${r.doc_no} was corrected twice`,
    detail: `${r.bills} were both raised to replace ${r.doc_no}${r.customer_name ? ` (${r.customer_name})` : ''}.`,
    action: 'Two counters corrected this bill while they could not reach each other, so the goods went out and '
      + 'the customer was charged twice. Cancel the corrected bill that should not stand.',
    refs: [r.doc_no, ...r.bills.split(', ')],
  }))
}

/**
 * One shelf counted on two tills that could not see each other.
 *
 * A count is a statement of what is on the shelf, but it is posted as the
 * difference from what that till expected. Two tills that both found two
 * missing each took two off, and the stock now shows four gone where two were.
 * A later count that expected exactly what an earlier one expected -- when the
 * earlier one had found a difference -- never saw that difference posted: a
 * count taken after it would have expected what it found.
 */
export async function countedTwice(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{
    product_id: string; product_name: string; first: string; second: string
    expected: number; found_first: number; found_second: number; at: string
  }>(
    `SELECT a.product_id, p.name AS product_name, ca.doc_no AS first, cb.doc_no AS second,
            a.expected_qty AS expected, a.counted_qty AS found_first, b.counted_qty AS found_second,
            cb.opened_at AS at
       FROM stock_count_items a
       JOIN stock_counts ca ON ca.id = a.count_id AND ca.docstatus = 1
       JOIN stock_count_items b ON b.product_id = a.product_id AND b.count_id <> a.count_id
       JOIN stock_counts cb ON cb.id = b.count_id AND cb.docstatus = 1
        AND (cb.opened_at > ca.opened_at OR (cb.opened_at = ca.opened_at AND cb.id > ca.id))
       JOIN products p ON p.id = a.product_id
      WHERE a.counted_qty IS NOT NULL AND b.counted_qty IS NOT NULL
        AND a.counted_qty <> a.expected_qty
        AND b.expected_qty = a.expected_qty
        -- A count taken after both is the shelf counted once more: settled.
        AND NOT EXISTS (
          SELECT 1 FROM stock_count_items l
            JOIN stock_counts cl ON cl.id = l.count_id AND cl.docstatus = 1
           WHERE l.product_id = a.product_id AND l.counted_qty IS NOT NULL
             AND (cl.opened_at > cb.opened_at OR (cl.opened_at = cb.opened_at AND cl.id > cb.id)))`)
  return rows.map((r) => ({
    key: `counted_twice:${r.product_id}:${r.first}:${r.second}`,
    kind: 'counted_twice',
    area: 'stock',
    at: r.at,
    amount: null,
    title: `${r.product_name} was counted on two tills that could not see each other`,
    detail: `${r.first} and ${r.second} both expected ${qty(r.expected as Qty)} and found `
      + `${qty(r.found_first as Qty)} and ${qty(r.found_second as Qty)}; each took its own difference off, so the `
      + 'stock now shows the shortfall twice.',
    action: 'Count this item once more and submit that count: it sets the stock to what is on the shelf.',
    refs: [r.first, r.second],
  }))
}

/**
 * A supplier paid more than they are owed. It can be on purpose -- an advance
 * -- and then it is marked seen; more often it is one bill paid on two counters.
 */
export async function supplierOverpaid(db: SqlDriver): Promise<Discrepancy[]> {
  const rows = await db.query<{ id: string; name: string; owed: number; payments: string; last_at: string | null }>(
    `SELECT s.id, s.name, x.owed,
            (SELECT GROUP_CONCAT(p.doc_no, ', ') FROM payment_entries p
              WHERE p.supplier_id = s.id AND p.party_type = 'supplier' AND p.docstatus = 1) AS payments,
            (SELECT MAX(p.created_at) FROM payment_entries p
              WHERE p.supplier_id = s.id AND p.party_type = 'supplier' AND p.docstatus = 1) AS last_at
       FROM suppliers s
       JOIN (SELECT suppliers.id,
              (CASE WHEN suppliers.opening_as_of IS NULL THEN 0 ELSE suppliers.opening_balance END)
              + COALESCE((SELECT SUM(e.invoice_total) FROM stock_entries e
                           WHERE e.supplier_id = suppliers.id AND e.docstatus = 1 AND e.entry_type = 'purchase'), 0)
              - COALESCE((SELECT SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE -p.amount END)
                            FROM payment_entries p
                           WHERE p.supplier_id = suppliers.id AND p.party_type = 'supplier' AND p.docstatus = 1), 0)
              AS owed
             FROM suppliers) x ON x.id = s.id
      WHERE x.owed < 0`)
  return rows.map((r) => ({
    key: `supplier_overpaid:${r.id}:${r.owed}`,
    kind: 'supplier_overpaid',
    area: 'money',
    at: r.last_at,
    amount: (-r.owed) as Money,
    title: `${r.name} has been paid ${rupees(-r.owed)} more than they are owed`,
    detail: `Payments to ${r.name}: ${r.payments ?? 'none'}.`,
    action: 'If this was an advance, mark it seen. If one bill was paid on two counters, cancel the payment '
      + 'that should not stand, or ask the supplier to set it against the next bill.',
    refs: (r.payments ?? '').split(', ').filter(Boolean),
  }))
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
    `SELECT id, name, credit_limit FROM customers WHERE credit_enforcement <> 'none' AND deleted_at IS NULL ORDER BY name`)
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
