import type { SqlDriver, SqlValue } from '../db/driver.js'
import type { Money } from '../money.js'
import { QTY_SCALE, type Qty } from '../quantity.js'

/**
 * Every figure here is read from submitted documents (docstatus = 1) and nothing
 * else. Drafts are not sales and cancelled bills are not sales, so a report and
 * the bill list can never tell the shop two different stories.
 */

export interface DateRange {
  from: string
  to: string
  registerId?: string | null
}

function scope(range: DateRange): { clause: string; params: SqlValue[] } {
  return range.registerId
    ? { clause: `AND b.register_id = ?`, params: [range.from, range.to, range.registerId] }
    : { clause: ``, params: [range.from, range.to] }
}

export interface SalesSummary {
  bills: number
  gross: Money
  discount: Money
  taxable: Money
  tax: Money
  roundOff: Money
  total: Money
  returns: Money
  net: Money
  paid: Money
  credit: Money
  averageBill: Money
}

export async function salesSummary(db: SqlDriver, range: DateRange): Promise<SalesSummary> {
  const s = scope(range)

  const row = await db.get<{
    n: number; gross: number; discount: number; taxable: number
    tax: number; round_off: number; total: number; paid: number; credit: number
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(b.subtotal), 0)      AS gross,
            COALESCE(SUM(b.discount), 0)      AS discount,
            COALESCE(SUM(b.taxable_total), 0) AS taxable,
            COALESCE(SUM(b.tax_total), 0)     AS tax,
            COALESCE(SUM(b.round_off), 0)     AS round_off,
            COALESCE(SUM(b.grand_total), 0)   AS total,
            COALESCE(SUM(b.paid_total), 0)    AS paid,
            COALESCE(SUM(b.credit_total), 0)  AS credit
       FROM bills b
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  const ret = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(r.refund_total), 0) AS total
       FROM sales_returns r JOIN bills b ON b.id = r.bill_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  const bills = row?.n ?? 0
  const total = row?.total ?? 0
  const returns = ret?.total ?? 0

  return {
    bills,
    gross: (row?.gross ?? 0) as Money,
    discount: (row?.discount ?? 0) as Money,
    taxable: (row?.taxable ?? 0) as Money,
    tax: (row?.tax ?? 0) as Money,
    roundOff: (row?.round_off ?? 0) as Money,
    total: total as Money,
    returns: returns as Money,
    net: (total - returns) as Money,
    paid: (row?.paid ?? 0) as Money,
    credit: (row?.credit ?? 0) as Money,
    averageBill: (bills === 0 ? 0 : Math.round(total / bills)) as Money,
  }
}

export interface DayRow {
  date: string
  bills: number
  discount: Money
  tax: Money
  total: Money
  returns: Money
  net: Money
}

export async function salesByDay(db: SqlDriver, range: DateRange): Promise<DayRow[]> {
  const s = scope(range)

  const sales = await db.query<{ d: string; n: number; discount: number; tax: number; total: number }>(
    `SELECT b.posting_date AS d, COUNT(*) AS n,
            COALESCE(SUM(b.discount), 0) AS discount,
            COALESCE(SUM(b.tax_total), 0) AS tax,
            COALESCE(SUM(b.grand_total), 0) AS total
       FROM bills b
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY b.posting_date ORDER BY b.posting_date`,
    s.params,
  )

  const returns = await db.query<{ d: string; total: number }>(
    `SELECT r.posting_date AS d, COALESCE(SUM(r.refund_total), 0) AS total
       FROM sales_returns r JOIN bills b ON b.id = r.bill_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY r.posting_date`,
    s.params,
  )
  const refundByDay = new Map(returns.map((r) => [r.d, r.total]))

  return sales.map((r) => {
    const refund = refundByDay.get(r.d) ?? 0
    return {
      date: r.d,
      bills: r.n,
      discount: r.discount as Money,
      tax: r.tax as Money,
      total: r.total as Money,
      returns: refund as Money,
      net: (r.total - refund) as Money,
    }
  })
}

export interface ProductRow {
  productId: string
  name: string
  qty: Qty
  unit: string
  revenue: Money
  bills: number
}

export async function topProducts(db: SqlDriver, range: DateRange, limit = 20): Promise<ProductRow[]> {
  const s = scope(range)

  // base_qty, not qty — otherwise 2 boxes and 24 pieces of the same pen rank as
  // if the box were a single unit.
  const rows = await db.query<{
    product_id: string; name: string; base_qty: number; unit: string; revenue: number; bills: number
  }>(
    `SELECT bi.product_id,
            MAX(bi.product_name) AS name,
            SUM(bi.base_qty) AS base_qty,
            COALESCE(MAX(p.base_unit), '') AS unit,
            SUM(bi.line_total) AS revenue,
            COUNT(DISTINCT bi.bill_id) AS bills
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       LEFT JOIN products p ON p.id = bi.product_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY bi.product_id
      ORDER BY revenue DESC
      LIMIT ?`,
    [...s.params, limit],
  )

  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    qty: r.base_qty as Qty,
    unit: r.unit,
    revenue: r.revenue as Money,
    bills: r.bills,
  }))
}

export interface TenderRow {
  method: string
  amount: Money
  count: number
}

export async function paymentMix(db: SqlDriver, range: DateRange): Promise<TenderRow[]> {
  const s = scope(range)
  const rows = await db.query<{ method: string; amount: number; n: number }>(
    `SELECT bp.method, SUM(bp.amount) AS amount, COUNT(*) AS n
       FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY bp.method ORDER BY amount DESC`,
    s.params,
  )
  return rows.map((r) => ({ method: r.method, amount: r.amount as Money, count: r.n }))
}

export interface TaxRateRow {
  rateBp: number
  taxable: Money
  cgst: Money
  sgst: Money
  igst: Money
}

/**
 * GSTR-1 is built rate by rate, so the summary is grouped the same way.
 *
 * Returns are in it, negative, at the rate they were charged at.
 *
 * They were not, and the shop would have over-declared its output tax by every
 * rupee it refunded: a ₹1,000 sale and a ₹1,000 return netted to nothing in the
 * sales summary, which reads `sales_returns`, and to a full ₹1,000 of taxable
 * value here, which did not. The two screens disagreed, one of them was filed,
 * and the tax it declared had been given back to the customer.
 *
 * A credit note belongs in the period it was raised in, not the period of the
 * invoice it reverses, so the date filter is the return's own `posting_date` —
 * the same rule `salesSummary` and `salesByDay` already use. The register scope
 * follows the original bill, because that is the till the sale was rung up on.
 */
export async function taxByRate(db: SqlDriver, range: DateRange): Promise<TaxRateRow[]> {
  const s = scope(range)
  const rows = await db.query<{
    rate: number; taxable: number; cgst: number; sgst: number; igst: number
  }>(
    `SELECT rate,
            SUM(taxable) AS taxable,
            SUM(cgst) AS cgst,
            SUM(sgst) AS sgst,
            SUM(igst) AS igst
       FROM (
         SELECT bi.tax_rate_bp AS rate,
                bi.taxable_value AS taxable,
                bi.cgst_amount AS cgst,
                bi.sgst_amount AS sgst,
                bi.igst_amount AS igst
           FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
          WHERE b.docstatus = 1 AND b.kind = 'sale'
            AND b.posting_date BETWEEN ? AND ? ${s.clause}
         UNION ALL
         SELECT ri.tax_rate_bp,
                -ri.taxable_value,
                -ri.cgst_amount,
                -ri.sgst_amount,
                -ri.igst_amount
           FROM sales_return_items ri
           JOIN sales_returns r ON r.id = ri.return_id
           JOIN bills b ON b.id = r.bill_id
          WHERE r.docstatus = 1
            AND r.posting_date BETWEEN ? AND ? ${s.clause}
       )
      GROUP BY rate ORDER BY rate`,
    [...s.params, ...s.params],
  )
  return rows.map((r) => ({
    rateBp: r.rate,
    taxable: r.taxable as Money,
    cgst: r.cgst as Money,
    sgst: r.sgst as Money,
    igst: r.igst as Money,
  }))
}

export interface StaffRow {
  userId: string
  username: string
  bills: number
  total: Money
}

export async function salesByStaff(db: SqlDriver, range: DateRange): Promise<StaffRow[]> {
  const s = scope(range)
  const rows = await db.query<{ id: string; username: string; n: number; total: number }>(
    `SELECT u.id, u.username, COUNT(*) AS n, COALESCE(SUM(b.grand_total), 0) AS total
       FROM bills b JOIN users u ON u.id = b.created_by
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY u.id ORDER BY total DESC`,
    s.params,
  )
  return rows.map((r) => ({ userId: r.id, username: r.username, bills: r.n, total: r.total as Money }))
}

export interface GstLine {
  /** An invoice or the credit note that reverses part of one. */
  kind: 'invoice' | 'credit_note'
  docNo: string
  /** The invoice a credit note is raised against — Rule 53(1)(e). Null on an invoice. */
  againstDocNo: string | null
  postingDate: string
  customerName: string
  gstin: string
  placeOfSupply: string
  rateBp: number
  taxable: Money
  cgst: Money
  sgst: Money
  igst: Money
  total: Money
}

/**
 * One row per document per tax rate — the shape a CA's GSTR-1 working needs.
 *
 * Three things this now does that it did not:
 *
 * **Credit notes are in it.** A return raised in the period appears as its own
 * row, negative, carrying the invoice number it reverses. GSTR-1 has a table
 * for exactly this (9B) and it cannot be filled from an export that pretends
 * returns do not happen. Cancelled bills stay excluded rather than negated —
 * they were never filed, and there is nothing to reverse.
 *
 * **The recipient comes off the bill, not off `customers`.** The GSTIN printed
 * on the invoice the customer holds is the one in `bills.customer_gstin`,
 * written at submit by migration 028's snapshot. Reading it through a live join
 * meant a customer who corrected their GSTIN changed every return already filed.
 *
 * **`round_off` is on the last rate row of each bill**, so the rate rows of a
 * bill sum to its `grand_total` exactly. It has to land somewhere: a CA adding
 * up the export against the invoices would otherwise be out by up to 49 paise a
 * bill, with nothing to point at. A credit note is not rounded, so it takes
 * nothing.
 */
export async function gstLines(db: SqlDriver, range: DateRange): Promise<GstLine[]> {
  const s = scope(range)
  const rows = await db.query<{
    kind: string; doc_no: string; against_doc_no: string | null; posting_date: string
    customer_name: string | null; gstin: string | null; place_of_supply: string | null
    doc_id: string; round_off: number; rate: number
    taxable: number; cgst: number; sgst: number; igst: number
  }>(
    `SELECT 'invoice' AS kind, b.doc_no AS doc_no, NULL AS against_doc_no,
            b.posting_date AS posting_date,
            COALESCE(b.customer_name, 'Walk-in') AS customer_name,
            b.customer_gstin AS gstin, b.place_of_supply AS place_of_supply,
            b.id AS doc_id, b.round_off AS round_off,
            bi.tax_rate_bp AS rate,
            SUM(bi.taxable_value) AS taxable,
            SUM(bi.cgst_amount) AS cgst,
            SUM(bi.sgst_amount) AS sgst,
            SUM(bi.igst_amount) AS igst
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY b.id, bi.tax_rate_bp
      UNION ALL
     SELECT 'credit_note', r.doc_no, b.doc_no,
            r.posting_date,
            COALESCE(b.customer_name, 'Walk-in'),
            b.customer_gstin, b.place_of_supply,
            r.id, 0,
            ri.tax_rate_bp,
            -SUM(ri.taxable_value),
            -SUM(ri.cgst_amount),
            -SUM(ri.sgst_amount),
            -SUM(ri.igst_amount)
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.return_id
       JOIN bills b ON b.id = r.bill_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ? ${s.clause}
      GROUP BY r.id, ri.tax_rate_bp
      ORDER BY posting_date, doc_no, rate`,
    [...s.params, ...s.params],
  )

  const lines = rows.map((r) => ({
    kind: r.kind === 'credit_note' ? ('credit_note' as const) : ('invoice' as const),
    docNo: r.doc_no,
    againstDocNo: r.against_doc_no,
    postingDate: r.posting_date,
    customerName: r.customer_name ?? 'Walk-in',
    gstin: r.gstin ?? '',
    placeOfSupply: r.place_of_supply ?? '',
    rateBp: r.rate,
    taxable: r.taxable as Money,
    cgst: r.cgst as Money,
    sgst: r.sgst as Money,
    igst: r.igst as Money,
    total: (r.taxable + r.cgst + r.sgst + r.igst) as Money,
  }))

  // The rows of one document are next to each other, so its last rate row is the
  // one the next row leaves behind. Rounding goes there and nowhere else: split
  // across the rate rows it would change a rate's taxable value, which is the
  // one number in this export that must not be adjusted.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const isLastOfDoc = i === rows.length - 1 || rows[i + 1]!.doc_id !== row.doc_id
    if (isLastOfDoc && row.round_off !== 0) {
      lines[i]!.total = (lines[i]!.total + row.round_off) as Money
    }
  }

  return lines
}

export interface GstException {
  docNo: string
  postingDate: string
  customerName: string
  gstin: string
  productName: string
  taxable: Money
  /** What is wrong with the line, in the words the sheet should use. */
  problem: string
}

/**
 * The lines a CA will come back about.
 *
 * A B2B line with no HSN code is the one that matters: the buyer is registered,
 * the line goes into their input credit, and GSTR-1 wants the code. It is not
 * worth refusing a sale over — a cashier cannot look up a chapter heading with
 * a customer at the counter — so it is caught here instead, at the one moment
 * somebody is actually sitting down with the figures.
 *
 * Deliberately a list of documents rather than a count. "14 lines are missing
 * HSN" is a number nobody can act on; the invoice number and the item name are
 * what sends somebody to the right row of the product list.
 *
 * B2B only. A walk-in's line without an HSN is untidy and harms nobody, and a
 * sheet that listed every one of those would bury the fourteen that matter.
 */
export async function gstExceptions(db: SqlDriver, range: DateRange): Promise<GstException[]> {
  const s = scope(range)
  const rows = await db.query<{
    doc_no: string; posting_date: string; customer_name: string | null
    gstin: string; product_name: string; taxable: number
  }>(
    `SELECT b.doc_no, b.posting_date,
            COALESCE(b.customer_name, 'Walk-in') AS customer_name,
            b.customer_gstin AS gstin,
            bi.product_name, bi.taxable_value AS taxable
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
      WHERE b.docstatus = 1 AND b.kind = 'sale'
        AND b.customer_gstin IS NOT NULL AND b.customer_gstin <> ''
        AND (bi.hsn_code IS NULL OR TRIM(bi.hsn_code) = '')
        AND b.posting_date BETWEEN ? AND ? ${s.clause}
      ORDER BY b.posting_date, b.doc_no`,
    s.params,
  )

  return rows.map((r) => ({
    docNo: r.doc_no,
    postingDate: r.posting_date,
    customerName: r.customer_name ?? 'Walk-in',
    gstin: r.gstin,
    productName: r.product_name,
    taxable: r.taxable as Money,
    problem: 'No HSN code on a line billed to a registered buyer',
  }))
}

/** RFC 4180: a field containing a comma, quote or newline is quoted, quotes doubled. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n') + '\r\n'
}

/**
 * Gross margin.
 *
 * Revenue is the taxable value, never the grand total: GST is collected for the
 * government, not earned, and cost is recorded exclusive of it. Comparing the two
 * on the same basis is the whole point.
 *
 * Cost comes off the stock ledger, where every issue was stamped with what the
 * goods were worth as they left, so nothing here re-derives history.
 */
export interface Margin {
  revenue: Money
  cost: Money
  margin: Money
  /** Basis points of revenue, so 2350 reads as 23.5%. */
  marginBp: number
  /** Lines whose cost was never recorded — margin understates the cost by this much. */
  uncostedLines: number
}

const COST = `CAST(ROUND(-sl.qty_change * sl.unit_cost / ${QTY_SCALE}.0) AS INTEGER)`

export async function grossMargin(db: SqlDriver, range: DateRange): Promise<Margin> {
  const s = scope(range)

  const sold = await db.get<{ revenue: number; uncosted: number }>(
    `SELECT COALESCE(SUM(bi.taxable_value), 0) AS revenue,
            COALESCE(SUM(CASE WHEN NOT EXISTS (
              SELECT 1 FROM stock_ledger sl
               WHERE sl.voucher_type = 'bill' AND sl.voucher_id = b.id
                 AND sl.product_id = bi.product_id AND sl.unit_cost IS NOT NULL
            ) THEN 1 ELSE 0 END), 0) AS uncosted
       FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  const soldCost = await db.get<{ cost: number }>(
    `SELECT COALESCE(SUM(${COST}), 0) AS cost
       FROM stock_ledger sl JOIN bills b ON b.id = sl.voucher_id
      WHERE sl.voucher_type = 'bill' AND sl.unit_cost IS NOT NULL
        AND b.docstatus = 1 AND b.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  const returned = await db.get<{ revenue: number }>(
    `SELECT COALESCE(SUM(ri.taxable_value), 0) AS revenue
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.return_id
       JOIN bills b ON b.id = r.bill_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  const returnedCost = await db.get<{ cost: number }>(
    `SELECT COALESCE(SUM(${COST}), 0) AS cost
       FROM stock_ledger sl
       JOIN sales_returns r ON r.id = sl.voucher_id
       JOIN bills b ON b.id = r.bill_id
      WHERE sl.voucher_type = 'sales_return' AND sl.unit_cost IS NOT NULL
        AND r.docstatus = 1 AND r.posting_date BETWEEN ? AND ? ${s.clause}`,
    s.params,
  )

  // A return's movement is positive, so its COST comes out negative — which is
  // exactly right: goods coming back reduce the cost of what was sold.
  const revenue = (sold?.revenue ?? 0) - (returned?.revenue ?? 0)
  const cost = (soldCost?.cost ?? 0) + (returnedCost?.cost ?? 0)

  return {
    revenue: revenue as Money,
    cost: cost as Money,
    margin: (revenue - cost) as Money,
    marginBp: revenue === 0 ? 0 : Math.round(((revenue - cost) / revenue) * 10_000),
    uncostedLines: sold?.uncosted ?? 0,
  }
}

export interface ProductMargin {
  productId: string
  name: string
  qty: Qty
  unit: string
  revenue: Money
  cost: Money
  margin: Money
  marginBp: number
}

export async function marginByProduct(db: SqlDriver, range: DateRange, limit = 25): Promise<ProductMargin[]> {
  const s = scope(range)

  const rows = await db.query<{
    product_id: string; name: string; base_qty: number; unit: string; revenue: number; cost: number
  }>(
    `WITH sold AS (
       SELECT bi.product_id,
              MAX(bi.product_name) AS name,
              SUM(bi.base_qty) AS base_qty,
              SUM(bi.taxable_value) AS revenue
         FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
        WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ? ${s.clause}
        GROUP BY bi.product_id
     ), cost AS (
       SELECT sl.product_id, SUM(${COST}) AS cost
         FROM stock_ledger sl JOIN bills b ON b.id = sl.voucher_id
        WHERE sl.voucher_type = 'bill' AND sl.unit_cost IS NOT NULL
          AND b.docstatus = 1 AND b.posting_date BETWEEN ? AND ? ${s.clause}
        GROUP BY sl.product_id
     )
     SELECT sold.product_id, sold.name, sold.base_qty,
            COALESCE(p.base_unit, '') AS unit,
            sold.revenue,
            COALESCE(cost.cost, 0) AS cost
       FROM sold
       LEFT JOIN cost ON cost.product_id = sold.product_id
       LEFT JOIN products p ON p.id = sold.product_id
      ORDER BY (sold.revenue - COALESCE(cost.cost, 0)) DESC
      LIMIT ?`,
    [...s.params, ...s.params, limit],
  )

  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    qty: r.base_qty as Qty,
    unit: r.unit,
    revenue: r.revenue as Money,
    cost: r.cost as Money,
    margin: (r.revenue - r.cost) as Money,
    marginBp: r.revenue === 0 ? 0 : Math.round(((r.revenue - r.cost) / r.revenue) * 10_000),
  }))
}
