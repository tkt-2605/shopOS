import { eq, and, asc, sql } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { type DateRange, money, negated, scope, returnedIn, soldIn } from './scope.js'

export interface TaxRateRow {
  rateBp: number
  taxable: Money
  cgst: Money
  sgst: Money
  igst: Money
  /** GST compensation cess, which GSTR-1 files in its own column (063). */
  cess: Money
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
      cess: schema.billItems.cessAmount,
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
      cess: negated(schema.salesReturnItems.cessAmount),
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
      cess: money(lines.cess),
    })
    .from(lines)
    .groupBy(lines.rate)
    .orderBy(asc(lines.rate))
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
  cess: Money
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
 * they were never filed, and there is nothing to reverse. That holds because
 * a bill cannot be cancelled once the books are closed through its date
 * (`services/books.ts`); before that lock existed, it held only by luck.
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
    taxable: number; cgst: number; sgst: number; igst: number; cess: number
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
            SUM(bi.igst_amount) AS igst,
            SUM(bi.cess_amount) AS cess
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
            -SUM(ri.igst_amount),
            -SUM(ri.cess_amount)
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
    cess: r.cess as Money,
    total: (r.taxable + r.cgst + r.sgst + r.igst + r.cess) as Money,
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
