import type { SqlDriver } from '../../db/driver.js'
import type { Money } from '../../money.js'
import { getSetting } from '../../services/settings.js'
import {
  buildGstr1, type Gstr1, type HsnMovement, type InvoiceRate, type NoteRate, type NumberedDoc,
} from '../../domain/gstr1.js'

/**
 * A period's documents, read for GSTR-1 and handed to `buildGstr1`.
 *
 * The whole shop, never one counter: a return is filed per GSTIN, and a
 * GSTR-1 of one till's bills is a return that under-declares. Every query here
 * is written out by hand (raw: grouped selects over two tables, with the
 * supply type falling back to the place of supply for bills from before 028),
 * and each reads only what was written when the document was submitted.
 */
export async function gstr1(db: SqlDriver, range: { from: string; to: string }): Promise<Gstr1> {
  const shopState = await getSetting(db, 'shop_state_code')
  const period = [range.from, range.to]

  const invoices = await db.query<{
    doc_no: string; posting_date: string; grand_total: number; customer_name: string | null
    customer_gstin: string | null; place_of_supply: string | null; supply_type: string | null
    rate: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number
  }>(
    `SELECT b.doc_no, b.posting_date, b.grand_total, b.customer_name, b.customer_gstin,
            b.place_of_supply, b.supply_type, bi.tax_rate_bp AS rate,
            SUM(bi.taxable_value) AS taxable, SUM(bi.igst_amount) AS igst,
            SUM(bi.cgst_amount) AS cgst, SUM(bi.sgst_amount) AS sgst, SUM(bi.cess_amount) AS cess
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ?
      GROUP BY b.id, bi.tax_rate_bp
      ORDER BY b.posting_date, b.doc_no, rate`,
    period,
  )

  const notes = await db.query<{
    note_id: string; doc_no: string; posting_date: string; invoice_no: string; invoice_date: string
    invoice_value: number; customer_name: string | null; customer_gstin: string | null
    place_of_supply: string | null; supply_type: string | null
    rate: number; refund: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number
  }>(
    `SELECT r.id AS note_id, r.doc_no, r.posting_date,
            b.doc_no AS invoice_no, b.posting_date AS invoice_date, b.grand_total AS invoice_value,
            b.customer_name, b.customer_gstin, b.place_of_supply, b.supply_type,
            ri.tax_rate_bp AS rate, SUM(ri.refund_amount) AS refund,
            SUM(ri.taxable_value) AS taxable, SUM(ri.igst_amount) AS igst,
            SUM(ri.cgst_amount) AS cgst, SUM(ri.sgst_amount) AS sgst, SUM(ri.cess_amount) AS cess
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.return_id
       JOIN bills b ON b.id = r.bill_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ?
      GROUP BY r.id, ri.tax_rate_bp
      ORDER BY r.posting_date, r.doc_no, rate`,
    period,
  )
  const noteValue = new Map<string, number>()
  for (const n of notes) noteValue.set(n.note_id, (noteValue.get(n.note_id) ?? 0) + n.refund)

  /* Table 12 is net of returns, so the goods that came back are read the same
     way, dated by the return, and counted against what went out. */
  const hsn = await db.query<{
    hsn: string; description: string; unit: string; rate: number; registered: number
    qty: number; value: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number
  }>(
    `SELECT COALESCE(TRIM(bi.hsn_code), '') AS hsn, MIN(bi.product_name) AS description,
            p.base_unit AS unit, bi.tax_rate_bp AS rate,
            (COALESCE(TRIM(b.customer_gstin), '') <> '') AS registered,
            SUM(bi.base_qty) AS qty, SUM(bi.line_total) AS value, SUM(bi.taxable_value) AS taxable,
            SUM(bi.igst_amount) AS igst, SUM(bi.cgst_amount) AS cgst,
            SUM(bi.sgst_amount) AS sgst, SUM(bi.cess_amount) AS cess
       FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       JOIN products p ON p.id = bi.product_id
      WHERE b.docstatus = 1 AND b.kind = 'sale' AND b.posting_date BETWEEN ? AND ?
      GROUP BY hsn, p.base_unit, bi.tax_rate_bp, registered
      UNION ALL
     SELECT COALESCE(TRIM(ri.hsn_code), ''), MIN(p.name), p.base_unit, ri.tax_rate_bp,
            (COALESCE(TRIM(b.customer_gstin), '') <> ''),
            -SUM(ri.base_qty), -SUM(ri.refund_amount), -SUM(ri.taxable_value),
            -SUM(ri.igst_amount), -SUM(ri.cgst_amount), -SUM(ri.sgst_amount), -SUM(ri.cess_amount)
       FROM sales_return_items ri
       JOIN sales_returns r ON r.id = ri.return_id
       JOIN bills b ON b.id = r.bill_id
       JOIN products p ON p.id = ri.product_id
      WHERE r.docstatus = 1 AND r.posting_date BETWEEN ? AND ?
      GROUP BY COALESCE(TRIM(ri.hsn_code), ''), p.base_unit, ri.tax_rate_bp, (COALESCE(TRIM(b.customer_gstin), '') <> '')`,
    [...period, ...period],
  )

  /* Every number issued in the period, cancelled ones too -- Table 13 asks how
     many were cancelled. A draft has no number of its own, and an opening
     balance numbers in its own `OB` series and is not an invoice. */
  const numbered = await db.query<{ nature: string; doc_no: string; docstatus: number }>(
    `SELECT 'invoice' AS nature, doc_no, docstatus FROM bills
      WHERE kind = 'sale' AND docstatus IN (1, 2) AND doc_no NOT LIKE 'DRAFT-%'
        AND posting_date BETWEEN ? AND ?
     UNION ALL
     SELECT 'credit_note', doc_no, docstatus FROM sales_returns
      WHERE docstatus IN (1, 2) AND posting_date BETWEEN ? AND ?`,
    [...period, ...period],
  )

  const supply = (s: string | null) => (s === 'inter_state' || s === 'intra_state' ? s : null)

  return buildGstr1({
    shopState,
    invoices: invoices.map((r): InvoiceRate => ({
      invoiceNo: r.doc_no, invoiceDate: r.posting_date, invoiceValue: r.grand_total as Money,
      customerName: r.customer_name, gstin: r.customer_gstin, placeOfSupply: r.place_of_supply,
      supplyType: supply(r.supply_type), rateBp: r.rate,
      taxable: r.taxable as Money, igst: r.igst as Money, cgst: r.cgst as Money, sgst: r.sgst as Money, cess: r.cess as Money,
    })),
    notes: notes.map((n): NoteRate => ({
      noteNo: n.doc_no, noteDate: n.posting_date, noteValue: (noteValue.get(n.note_id) ?? 0) as Money,
      invoiceNo: n.invoice_no, invoiceDate: n.invoice_date, invoiceValue: n.invoice_value as Money,
      customerName: n.customer_name, gstin: n.customer_gstin, placeOfSupply: n.place_of_supply,
      supplyType: supply(n.supply_type), rateBp: n.rate,
      taxable: n.taxable as Money, igst: n.igst as Money, cgst: n.cgst as Money, sgst: n.sgst as Money, cess: n.cess as Money,
    })),
    hsn: hsn.map((h): HsnMovement => ({
      hsn: h.hsn, description: h.description, unit: h.unit, rateBp: h.rate, registered: h.registered === 1,
      qty: h.qty, value: h.value as Money, taxable: h.taxable as Money,
      igst: h.igst as Money, cgst: h.cgst as Money, sgst: h.sgst as Money, cess: h.cess as Money,
    })),
    numbered: numbered.map((d): NumberedDoc => ({
      nature: d.nature === 'credit_note' ? 'credit_note' : 'invoice', docNo: d.doc_no, cancelled: d.docstatus === 2,
    })),
  })
}
