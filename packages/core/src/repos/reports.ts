import { eq, and, desc, asc, between, isNotNull, sql, type SQL } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'
import type { SqlDriver, SqlValue } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { type Money, ZERO } from '../money.js'
import { QTY_SCALE, type Qty } from '../quantity.js'
import { SUBMITTED } from '../integrity/docstatus.js'

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

/**
 * The register filter as a fragment of SQL, for the one query still written by
 * hand. Everything else on this page uses `onRegister` below.
 */
function scope(range: DateRange): { clause: string; params: SqlValue[] } {
  return range.registerId
    ? { clause: `AND b.register_id = ?`, params: [range.from, range.to, range.registerId] }
    : { clause: ``, params: [range.from, range.to] }
}

/**
 * The register filter, as a condition rather than a fragment of a string.
 *
 * Every report is scoped to one till or to all of them, and the answer is
 * always a condition on `bills` -- including for returns and for stock
 * movements, which reach it through a join. A report scoped to the wrong till
 * is not an error; it is a smaller number that looks like a quiet week.
 */
function onRegister(range: DateRange): SQL[] {
  return range.registerId ? [eq(schema.bills.registerId, range.registerId)] : []
}

/** Submitted sales only: a draft is not a sale and a cancelled bill is not one. */
function soldIn(range: DateRange): SQL[] {
  return [
    eq(schema.bills.docstatus, SUBMITTED),
    eq(schema.bills.kind, 'sale'),
    between(schema.bills.postingDate, range.from, range.to),
    ...onRegister(range),
  ]
}

/** The same window, dated by the return rather than by the bill it reverses. */
function returnedIn(range: DateRange): SQL[] {
  return [
    eq(schema.salesReturns.docstatus, SUBMITTED),
    between(schema.salesReturns.postingDate, range.from, range.to),
    ...onRegister(range),
  ]
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

  const [row] = await q(db)
    .select({
      n: sql<number>`COUNT(*)`,
      gross: money(schema.bills.subtotal),
      discount: money(schema.bills.discount),
      taxable: money(schema.bills.taxableTotal),
      tax: money(schema.bills.taxTotal),
      roundOff: money(schema.bills.roundOff),
      total: money(schema.bills.grandTotal),
      paid: money(schema.bills.paidTotal),
      credit: money(schema.bills.creditTotal),
    })
    .from(schema.bills)
    .where(and(...soldIn(range)))

  const [ret] = await q(db)
    .select({ total: money(schema.salesReturns.refundTotal) })
    .from(schema.salesReturns)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(...returnedIn(range)))

  const bills = row?.n ?? 0
  const total = row?.total ?? ZERO
  const returns = ret?.total ?? ZERO

  return {
    bills,
    gross: row?.gross ?? ZERO,
    discount: row?.discount ?? ZERO,
    taxable: row?.taxable ?? ZERO,
    tax: row?.tax ?? ZERO,
    roundOff: row?.roundOff ?? ZERO,
    total,
    returns,
    net: (total - returns) as Money,
    paid: row?.paid ?? ZERO,
    credit: row?.credit ?? ZERO,
    averageBill: (bills === 0 ? 0 : Math.round(total / bills)) as Money,
  }
}

/** `COALESCE(SUM(col), 0)`, which is what every figure on this page is. */
function money(column: SQL | Parameters<typeof sql.raw>[0] | object): SQL<Money> {
  return sql<Money>`COALESCE(SUM(${column}), 0)`
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

  const sales = await q(db)
    .select({
      date: schema.bills.postingDate,
      bills: sql<number>`COUNT(*)`,
      discount: money(schema.bills.discount),
      tax: money(schema.bills.taxTotal),
      total: money(schema.bills.grandTotal),
    })
    .from(schema.bills)
    .where(and(...soldIn(range)))
    .groupBy(schema.bills.postingDate)
    .orderBy(asc(schema.bills.postingDate))

  const returns = await q(db)
    .select({
      date: schema.salesReturns.postingDate,
      total: money(schema.salesReturns.refundTotal),
    })
    .from(schema.salesReturns)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(...returnedIn(range)))
    .groupBy(schema.salesReturns.postingDate)

  /* Joined here rather than in SQL: a day with returns and no sales is not a
     row on this report, and a full outer join to get that would be answering a
     different question. */
  const refundByDay = new Map(returns.map((r) => [r.date, r.total]))

  return sales.map((r) => {
    const refund = refundByDay.get(r.date) ?? ZERO
    return { ...r, returns: refund, net: (r.total - refund) as Money }
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

  // base_qty, not qty — otherwise 2 boxes and 24 pieces of the same pen rank as
  // if the box were a single unit.
  const revenue = money(schema.billItems.lineTotal)

  return q(db)
    .select({
      productId: schema.billItems.productId,
      /* `MAX` of a name that is the same on every row of the group: the column
         is not in the GROUP BY and SQLite would otherwise pick one arbitrarily,
         which is a different answer on a different day. */
      name: sql<string>`MAX(${schema.billItems.productName})`,
      qty: sql<Qty>`COALESCE(SUM(${schema.billItems.baseQty}), 0)`,
      unit: sql<string>`COALESCE(MAX(${schema.products.baseUnit}), '')`,
      revenue,
      bills: sql<number>`COUNT(DISTINCT ${schema.billItems.billId})`,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    /* Left, so a product deleted since it was sold keeps its sales on the
       report. Its unit comes back empty rather than the row disappearing. */
    .leftJoin(schema.products, eq(schema.products.id, schema.billItems.productId))
    .where(and(...soldIn(range)))
    .groupBy(schema.billItems.productId)
    .orderBy(desc(revenue))
    .limit(limit)
}

export interface TenderRow {
  method: string
  amount: Money
  count: number
}

export async function paymentMix(db: SqlDriver, range: DateRange): Promise<TenderRow[]> {
  const amount = money(schema.billPayments.amount)

  return q(db)
    .select({ method: schema.billPayments.method, amount, count: sql<number>`COUNT(*)` })
    .from(schema.billPayments)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billPayments.billId))
    .where(and(...soldIn(range)))
    .groupBy(schema.billPayments.method)
    .orderBy(desc(amount))
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
  /* Sales and credit notes as one set of rows, the returns negated, then
     grouped. Two queries added up in TypeScript would be the same arithmetic
     and a worse shape: a rate that appears only in the returns has to produce a
     row here, and merging two lists by key in the caller is how a rate goes
     missing from a return. */
  const sold = q(db)
    .select({
      rate: schema.billItems.taxRateBp,
      taxable: schema.billItems.taxableValue,
      cgst: schema.billItems.cgstAmount,
      sgst: schema.billItems.sgstAmount,
      igst: schema.billItems.igstAmount,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(...soldIn(range)))

  const credited = q(db)
    .select({
      rate: schema.salesReturnItems.taxRateBp,
      taxable: negated(schema.salesReturnItems.taxableValue),
      cgst: negated(schema.salesReturnItems.cgstAmount),
      sgst: negated(schema.salesReturnItems.sgstAmount),
      igst: negated(schema.salesReturnItems.igstAmount),
    })
    .from(schema.salesReturnItems)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.salesReturnItems.returnId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(...returnedIn(range)))

  const lines = unionAll(sold, credited).as('lines')

  return q(db)
    .select({
      rateBp: lines.rate,
      taxable: money(lines.taxable),
      cgst: money(lines.cgst),
      sgst: money(lines.sgst),
      igst: money(lines.igst),
    })
    .from(lines)
    .groupBy(lines.rate)
    .orderBy(asc(lines.rate))
}

/** A credited line, which is the same figure pointing the other way. */
function negated(column: object): SQL<Money> {
  return sql<Money>`-${column}`
}

export interface StaffRow {
  userId: string
  username: string
  bills: number
  total: Money
}

export async function salesByStaff(db: SqlDriver, range: DateRange): Promise<StaffRow[]> {
  const total = money(schema.bills.grandTotal)

  return q(db)
    .select({
      userId: schema.users.id,
      username: schema.users.username,
      bills: sql<number>`COUNT(*)`,
      total,
    })
    .from(schema.bills)
    .innerJoin(schema.users, eq(schema.users.id, schema.bills.createdBy))
    .where(and(...soldIn(range)))
    .groupBy(schema.users.id)
    .orderBy(desc(total))
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
  /* raw: the one query on this page still written out, and deliberately.
     It is two grouped selects unioned, ordered across the union, and then read
     in order by the loop below -- which finds the last rate row of each
     document by looking at whether the next row is a different document. That
     adjacency is a property of this statement's own ORDER BY, so the statement
     and the loop are one piece of logic, and splitting the half that a builder
     can express away from the half it cannot would put the two out of sight of
     each other. The rounding this decides lands on exactly one row per bill,
     and a CA adding the export up against the invoices notices if it does not.

     `taxByRate` above is the same union through the builder, so the shape is
     not beyond it; here the SQL is the clearer statement of what must be true. */
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
  const rows = await q(db)
    .select({
      docNo: schema.bills.docNo,
      postingDate: schema.bills.postingDate,
      customerName: sql<string>`COALESCE(${schema.bills.customerName}, 'Walk-in')`,
      gstin: schema.bills.customerGstin,
      productName: schema.billItems.productName,
      taxable: schema.billItems.taxableValue,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(
      ...soldIn(range),
      /* B2B only. A walk-in's line without an HSN is untidy and harms nobody,
         and a sheet listing every one of those would bury the ones that
         matter. */
      sql`${schema.bills.customerGstin} IS NOT NULL AND ${schema.bills.customerGstin} <> ''`,
      sql`(${schema.billItems.hsnCode} IS NULL OR TRIM(${schema.billItems.hsnCode}) = '')`,
    ))
    .orderBy(asc(schema.bills.postingDate), asc(schema.bills.docNo))

  return rows.map((r) => ({
    ...r,
    gstin: r.gstin ?? '',
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

/* The divisor written into the statement rather than bound to it. An
   interpolated value becomes a `?`, and `? .0` is a syntax error -- which is
   the good outcome, because the alternative was integer division quietly
   halving nothing and reporting a margin that is wrong by a rounding. */
const SCALE_AS_REAL = sql.raw(`${QTY_SCALE}.0`)

/**
 * What the goods on a ledger row were worth as they left.
 *
 * `qty_change` is negative for an issue, so the sign flips back here. Rounded
 * to whole paise at the row, not at the total: money is integer paise and a sum
 * of fractions is not.
 */
const COST = sql<Money>`CAST(ROUND(
  -${schema.stockLedger.qtyChange} * ${schema.stockLedger.unitCost} / ${SCALE_AS_REAL}
) AS INTEGER)`

export async function grossMargin(db: SqlDriver, range: DateRange): Promise<Margin> {

  const [sold] = await q(db)
    .select({
      revenue: money(schema.billItems.taxableValue),
      /* A line whose issue was never stamped with a cost. Counted rather than
         guessed at: the margin understates the cost by however many of these
         there are, and a figure that quietly excludes them is worse than one
         that says how much of itself is missing. */
      uncosted: sql<number>`COALESCE(SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM stock_ledger sl
         WHERE sl.voucher_type = 'bill' AND sl.voucher_id = ${schema.bills.id}
           AND sl.product_id = ${schema.billItems.productId} AND sl.unit_cost IS NOT NULL
      ) THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(...soldIn(range)))

  const [soldCost] = await q(db)
    .select({ cost: money(COST) })
    .from(schema.stockLedger)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.stockLedger.voucherId))
    .where(and(
      eq(schema.stockLedger.voucherType, 'bill'),
      isNotNull(schema.stockLedger.unitCost),
      eq(schema.bills.docstatus, SUBMITTED),
      between(schema.bills.postingDate, range.from, range.to),
      ...onRegister(range),
    ))

  const [returned] = await q(db)
    .select({ revenue: money(schema.salesReturnItems.taxableValue) })
    .from(schema.salesReturnItems)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.salesReturnItems.returnId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(...returnedIn(range)))

  const [returnedCost] = await q(db)
    .select({ cost: money(COST) })
    .from(schema.stockLedger)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.stockLedger.voucherId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(
      eq(schema.stockLedger.voucherType, 'sales_return'),
      isNotNull(schema.stockLedger.unitCost),
      ...returnedIn(range),
    ))

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

  /* What was sold and what it cost are grouped separately and joined once,
     rather than joined and then grouped: the ledger has a row per issue and the
     bill has a row per line, so joining first multiplies one by the other and
     every figure comes out too large by the number of rows on the other side. */
  const sold = q(db).$with('sold').as(
    q(db)
      .select({
        productId: schema.billItems.productId,
        /* Aliased `product_name` and not `name`: the final select also joins
           `products`, which has a `name` of its own, and a bare `name` in the
           select list is ambiguous. SQLite refuses rather than picking one,
           which is the good outcome of the two available. */
        name: sql<string>`MAX(${schema.billItems.productName})`.as('product_name'),
        baseQty: sql<Qty>`SUM(${schema.billItems.baseQty})`.as('base_qty'),
        revenue: sql<Money>`SUM(${schema.billItems.taxableValue})`.as('revenue'),
      })
      .from(schema.billItems)
      .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
      .where(and(...soldIn(range)))
      .groupBy(schema.billItems.productId),
  )

  const cost = q(db).$with('cost').as(
    q(db)
      .select({
        productId: schema.stockLedger.productId,
        cost: sql<Money>`SUM(${COST})`.as('cost'),
      })
      .from(schema.stockLedger)
      .innerJoin(schema.bills, eq(schema.bills.id, schema.stockLedger.voucherId))
      .where(and(
        eq(schema.stockLedger.voucherType, 'bill'),
        isNotNull(schema.stockLedger.unitCost),
        eq(schema.bills.docstatus, SUBMITTED),
        between(schema.bills.postingDate, range.from, range.to),
        ...onRegister(range),
      ))
      .groupBy(schema.stockLedger.productId),
  )

  const margin = sql<Money>`${sold.revenue} - COALESCE(${cost.cost}, 0)`

  const rows = await q(db)
    .with(sold, cost)
    .select({
      productId: sold.productId,
      name: sold.name,
      qty: sold.baseQty,
      unit: sql<string>`COALESCE(${schema.products.baseUnit}, '')`,
      revenue: sold.revenue,
      cost: sql<Money>`COALESCE(${cost.cost}, 0)`,
    })
    .from(sold)
    .leftJoin(cost, eq(cost.productId, sold.productId))
    // Left, so a product deleted since it was sold keeps its margin on the report.
    .leftJoin(schema.products, eq(schema.products.id, sold.productId))
    .orderBy(desc(margin))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    margin: (r.revenue - r.cost) as Money,
    marginBp: r.revenue === 0 ? 0 : Math.round(((r.revenue - r.cost) / r.revenue) * 10_000),
  }))
}
