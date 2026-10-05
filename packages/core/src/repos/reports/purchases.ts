import type { SqlDriver } from '../../db/driver.js'
import type { Money } from '../../money.js'

/*
 * The purchase register: every supplier's bill in a period, with its tax.
 *
 * The other half of a GST return. GSTR-1 is what the shop billed; what it may
 * claim back is the tax on what it was billed, and GSTR-3B asks for it in total
 * (Table 4A(5), "all other ITC"). A CA checks the claim against GSTR-2B, which
 * is the suppliers' side, bill by bill -- which is why this is a list of bills
 * and not only a total.
 *
 * raw: one grouped select over a purchase and its lines.
 */

export interface PurchaseRegisterRow {
  entryNo: string
  postingDate: string
  supplierName: string
  supplierGstin: string
  invoiceNo: string
  invoiceDate: string
  taxable: Money
  cgst: Money
  sgst: Money
  igst: Money
  cess: Money
  roundOff: Money
  total: Money
  /** Whether the tax went to the shop's input credit, or into the cost of the goods. */
  claimed: boolean
}

export interface PurchaseRegister {
  rows: PurchaseRegisterRow[]
  /**
   * The input tax a return can claim for the period: claimed bills from
   * suppliers with a GSTIN. A bill from an unregistered supplier carries no
   * tax to claim, and one the shop could not claim is in its stock instead.
   */
  claimable: { igst: Money; cgst: Money; sgst: Money; cess: Money }
}

export async function purchaseRegister(db: SqlDriver, range: { from: string; to: string }): Promise<PurchaseRegister> {
  const raw = await db.query<{
    entry_no: string; posting_date: string; supplier_name: string | null; gstin: string | null
    invoice_no: string | null; invoice_date: string | null; round_off: number; total: number; claimed: number
    taxable: number; cgst: number; sgst: number; igst: number; cess: number
  }>(
    `SELECT e.doc_no AS entry_no, e.posting_date, COALESCE(s.name, e.supplier_name) AS supplier_name,
            s.gstin, e.supplier_invoice_no AS invoice_no, e.supplier_invoice_date AS invoice_date,
            e.round_off, e.invoice_total AS total, e.input_tax_claimed AS claimed,
            COALESCE(SUM(CAST(ROUND(i.qty * i.unit_cost / 10000.0) AS INTEGER)), 0) AS taxable,
            COALESCE(SUM(i.cgst_amount), 0) AS cgst, COALESCE(SUM(i.sgst_amount), 0) AS sgst,
            COALESCE(SUM(i.igst_amount), 0) AS igst, COALESCE(SUM(i.cess_amount), 0) AS cess
       FROM stock_entries e
       LEFT JOIN suppliers s ON s.id = e.supplier_id
       JOIN stock_entry_items i ON i.entry_id = e.id
      WHERE e.entry_type = 'purchase' AND e.docstatus = 1 AND e.posting_date BETWEEN ? AND ?
      GROUP BY e.id
      ORDER BY e.posting_date, e.doc_no`,
    [range.from, range.to],
  )

  const rows = raw.map((r): PurchaseRegisterRow => ({
    entryNo: r.entry_no, postingDate: r.posting_date, supplierName: r.supplier_name ?? '',
    supplierGstin: r.gstin ?? '', invoiceNo: r.invoice_no ?? '', invoiceDate: r.invoice_date ?? '',
    taxable: r.taxable as Money, cgst: r.cgst as Money, sgst: r.sgst as Money, igst: r.igst as Money,
    cess: r.cess as Money, roundOff: r.round_off as Money, total: r.total as Money, claimed: r.claimed === 1,
  }))

  const claimable = rows.filter((r) => r.claimed && r.supplierGstin.trim() !== '')
  const sum = (pick: (r: PurchaseRegisterRow) => number) => claimable.reduce((s, r) => s + pick(r), 0) as Money
  return {
    rows,
    claimable: { igst: sum((r) => r.igst), cgst: sum((r) => r.cgst), sgst: sum((r) => r.sgst), cess: sum((r) => r.cess) },
  }
}
