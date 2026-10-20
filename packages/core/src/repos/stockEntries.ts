import type { SqlDriver, SqlValue } from '../db/driver.js'
import type { Money } from '../money.js'
import type { Qty } from '../quantity.js'
import type { StockEntryType } from '../services/stockEntry.js'

/**
 * Every stock entry the shop has made -- deliveries, opening stock,
 * adjustments, wastage -- in one list that can be narrowed: by dates, by kind,
 * by supplier, by state, and by a word that may be the entry's number, the
 * supplier's invoice number, the reference or any item on it.
 *
 * What an entry was worth is what the stock ledger says it moved, not the costs
 * typed: goods going out at no typed cost left at the shelf's, and that is the
 * figure the books carry. A cancelled entry shows what it moved before it was
 * cancelled, so the list says what was undone.
 */

export type StockEntryState = 'submitted' | 'cancelled' | 'draft' | 'all'

export interface StockEntryFilter {
  from: string
  to: string
  entryType?: StockEntryType | 'all'
  supplierId?: string | null
  state?: StockEntryState
  search?: string
  limit?: number
}

export interface StockEntryRow {
  id: string
  docNo: string
  postingDate: string
  entryType: StockEntryType
  docstatus: number
  supplierName: string | null
  supplierInvoiceNo: string | null
  reference: string | null
  lineCount: number
  /** The first few items, for the list; `lineCount` says how many there are. */
  items: string
  /** Base units in, less base units out. */
  netQty: Qty
  /** What the entry moved the stock's value by, signed: out is below zero. */
  value: Money
  /** The supplier's bill, with its GST, for a purchase. Zero for the rest. */
  invoiceTotal: Money
}

const STATE: Record<StockEntryState, string> = {
  submitted: 'e.docstatus = 1',
  cancelled: 'e.docstatus = 2',
  draft: 'e.docstatus = 0',
  all: '1 = 1',
}

export async function listStockEntries(db: SqlDriver, filter: StockEntryFilter): Promise<StockEntryRow[]> {
  const where = ['e.posting_date >= ?', 'e.posting_date <= ?', STATE[filter.state ?? 'submitted']]
  const params: SqlValue[] = [filter.from, filter.to]
  if (filter.entryType && filter.entryType !== 'all') { where.push('e.entry_type = ?'); params.push(filter.entryType) }
  if (filter.supplierId) { where.push('e.supplier_id = ?'); params.push(filter.supplierId) }
  const term = filter.search?.trim().toLowerCase() ?? ''
  if (term !== '') {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(LOWER(e.doc_no) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(e.supplier_invoice_no, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(e.reference, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(s.name, e.supplier_name, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM stock_entry_items i JOIN products p ON p.id = i.product_id
                  WHERE i.entry_id = e.id AND LOWER(p.name) LIKE ? ESCAPE '\\'))`)
    params.push(like, like, like, like, like)
  }
  params.push(filter.limit ?? 500)

  /* raw: correlated subqueries per entry -- its lines, the first few names,
     and what the stock ledger moved for it -- which the builder cannot say. */
  const rows = await db.query<{
    id: string; doc_no: string; posting_date: string; entry_type: StockEntryType; docstatus: number
    supplier_name: string | null; supplier_invoice_no: string | null; reference: string | null
    line_count: number; items: string | null; net_qty: number; value: number; invoice_total: number
  }>(
    `SELECT e.id, e.doc_no, e.posting_date, e.entry_type, e.docstatus, COALESCE(s.name, e.supplier_name) AS supplier_name,
            e.supplier_invoice_no, e.reference, e.invoice_total,
            (SELECT COUNT(*) FROM stock_entry_items i WHERE i.entry_id = e.id) AS line_count,
            (SELECT GROUP_CONCAT(name, ', ') FROM (
               SELECT p.name FROM stock_entry_items i JOIN products p ON p.id = i.product_id
                WHERE i.entry_id = e.id ORDER BY i.rowid LIMIT 3)) AS items,
            (SELECT COALESCE(SUM(i.qty), 0) FROM stock_entry_items i WHERE i.entry_id = e.id) AS net_qty,
            (SELECT COALESCE(SUM(l.value_change), 0) FROM stock_ledger l
              WHERE l.voucher_type = 'stock_entry' AND l.voucher_id = e.id) AS value
       FROM stock_entries e LEFT JOIN suppliers s ON s.id = e.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.posting_date DESC, e.created_at DESC
      LIMIT ?`,
    params,
  )
  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    postingDate: r.posting_date,
    entryType: r.entry_type,
    docstatus: r.docstatus,
    supplierName: r.supplier_name,
    supplierInvoiceNo: r.supplier_invoice_no,
    reference: r.reference,
    lineCount: r.line_count,
    items: r.items ?? '',
    netQty: r.net_qty as Qty,
    value: r.value as Money,
    invoiceTotal: r.invoice_total as Money,
  }))
}

export interface StockEntryLine {
  productId: string
  productName: string
  baseUnit: string
  /** Signed: goods going out are below zero. */
  qty: Qty
  /** The cost typed, per base unit before GST. Zero where none was. */
  unitCost: Money
  taxRateBp: number
  /** The GST and cess on the line, for a purchase. */
  tax: Money
  /** What the stock ledger moved for this item on this entry. */
  value: Money
}

export interface StockEntryView extends StockEntryRow {
  supplierInvoiceDate: string | null
  notes: string | null
  roundOff: Money
  createdBy: string | null
  lines: StockEntryLine[]
}

/** One entry with its lines, for the list's detail. Null for an id the shop does not have. */
export async function loadStockEntry(db: SqlDriver, id: string): Promise<StockEntryView | null> {
  const head = await db.get<{
    id: string; doc_no: string; posting_date: string; entry_type: StockEntryType; docstatus: number
    supplier_name: string | null; supplier_invoice_no: string | null; supplier_invoice_date: string | null
    reference: string | null; notes: string | null; invoice_total: number; round_off: number; created_by: string | null
  }>(
    `SELECT e.id, e.doc_no, e.posting_date, e.entry_type, e.docstatus, COALESCE(s.name, e.supplier_name) AS supplier_name, e.supplier_invoice_no,
            e.supplier_invoice_date, e.reference, e.notes, e.invoice_total, e.round_off,
            (SELECT COALESCE(u.full_name, u.username) FROM users u WHERE u.id = e.created_by) AS created_by
       FROM stock_entries e LEFT JOIN suppliers s ON s.id = e.supplier_id WHERE e.id = ?`, [id])
  if (!head) return null

  /* raw: what the stock ledger moved for each item, per entry -- a grouped
     correlated subquery. Several lines of one item share its movements. */
  const lines = await db.query<{
    product_id: string; name: string; base_unit: string; qty: number; unit_cost: number; tax_rate_bp: number
    tax: number; value: number | null
  }>(
    `SELECT i.product_id, p.name, p.base_unit, i.qty, i.unit_cost, i.tax_rate_bp,
            i.cgst_amount + i.sgst_amount + i.igst_amount + i.cess_amount AS tax,
            (SELECT SUM(l.value_change) FROM stock_ledger l
              WHERE l.voucher_type = 'stock_entry' AND l.voucher_id = i.entry_id AND l.product_id = i.product_id) AS value
       FROM stock_entry_items i JOIN products p ON p.id = i.product_id
      WHERE i.entry_id = ? ORDER BY i.rowid`, [id])
  const once = new Set<string>()
  const view: StockEntryLine[] = lines.map((l) => {
    // An item on two lines has one set of movements: its value goes on the first.
    const first = !once.has(l.product_id)
    once.add(l.product_id)
    return {
      productId: l.product_id, productName: l.name, baseUnit: l.base_unit, qty: l.qty as Qty,
      unitCost: l.unit_cost as Money, taxRateBp: l.tax_rate_bp, tax: l.tax as Money,
      value: (first ? l.value ?? 0 : 0) as Money,
    }
  })

  return {
    id: head.id,
    docNo: head.doc_no,
    postingDate: head.posting_date,
    entryType: head.entry_type,
    docstatus: head.docstatus,
    supplierName: head.supplier_name,
    supplierInvoiceNo: head.supplier_invoice_no,
    supplierInvoiceDate: head.supplier_invoice_date,
    reference: head.reference,
    notes: head.notes,
    lineCount: view.length,
    items: view.slice(0, 3).map((l) => l.productName).join(', '),
    netQty: view.reduce((s, l) => s + l.qty, 0) as Qty,
    value: view.reduce((s, l) => s + l.value, 0) as Money,
    invoiceTotal: head.invoice_total as Money,
    roundOff: head.round_off as Money,
    createdBy: head.created_by,
    lines: view,
  }
}
