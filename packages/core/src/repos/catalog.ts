import type { SqlDriver } from '../db/driver.js'
import type { Money } from '../money.js'
import { qty, type Qty } from '../quantity.js'

export interface ProductListItem {
  id: string
  code: string | null
  name: string
  brand: string | null
  barcode: string | null
  baseUnit: string
  baseRate: Money
  mrp: Money | null
  taxRateBp: number
  hsnCode: string | null
  isStockTracked: boolean
  qtyOnHand: Qty
  /** Margin too thin to carry a discount, or to pay loyalty points on. */
  discountBlocked: boolean
  loyaltyBlocked: boolean
}

export interface SearchOptions {
  term?: string
  limit?: number
  offset?: number
  includeInactive?: boolean
}

/**
 * An exact barcode match sorts first: the scanner is the primary input and the
 * cashier expects the scanned item, not an alphabetical near-miss.
 */
export async function searchProducts(db: SqlDriver, opts: SearchOptions = {}): Promise<ProductListItem[]> {
  const term = opts.term?.trim() ?? ''
  const like = `%${term}%`
  const limit = opts.limit ?? 50
  const activeClause = opts.includeInactive ? '' : 'AND p.is_active = 1'

  const rows = await db.query<ProductRow>(
    `SELECT p.id, p.code, p.name, p.brand, p.barcode, p.base_unit, p.base_rate, p.mrp,
            p.tax_rate_bp, p.hsn_code, p.is_stock_tracked,
            p.discount_blocked, p.loyalty_blocked,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
      WHERE p.deleted_at IS NULL ${activeClause}
        AND (? = '' OR p.barcode = ? OR p.name LIKE ? OR p.brand LIKE ? OR p.code LIKE ?)
      ORDER BY CASE WHEN p.barcode = ? THEN 0 ELSE 1 END, p.name
      LIMIT ? OFFSET ?`,
    [term, term, like, like, like, term, limit, opts.offset ?? 0],
  )

  return rows.map(toProduct)
}

/** Products by id, for rebuilding a held bill's cart from what was saved. */
export async function productsByIds(db: SqlDriver, ids: string[]): Promise<ProductListItem[]> {
  if (ids.length === 0) return []
  const holes = ids.map(() => '?').join(', ')

  const rows = await db.query<ProductRow>(
    `SELECT p.id, p.code, p.name, p.brand, p.barcode, p.base_unit, p.base_rate, p.mrp,
            p.tax_rate_bp, p.hsn_code, p.is_stock_tracked,
            p.discount_blocked, p.loyalty_blocked,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
      WHERE p.id IN (${holes}) AND p.deleted_at IS NULL`,
    ids,
  )
  return rows.map(toProduct)
}

export async function findByBarcode(db: SqlDriver, barcode: string): Promise<ProductListItem | null> {
  const row = await db.get<ProductRow>(
    `SELECT p.id, p.code, p.name, p.brand, p.barcode, p.base_unit, p.base_rate, p.mrp,
            p.tax_rate_bp, p.hsn_code, p.is_stock_tracked,
            p.discount_blocked, p.loyalty_blocked,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
      WHERE p.barcode = ? AND p.deleted_at IS NULL AND p.is_active = 1`,
    [barcode.trim()],
  )
  return row ? toProduct(row) : null
}

export interface SaleUnitOption {
  saleUnit: string
  baseUnits: Qty
  isDefault: boolean
}

export async function saleUnitsFor(db: SqlDriver, productId: string): Promise<SaleUnitOption[]> {
  const product = await db.get<{ base_unit: string }>(`SELECT base_unit FROM products WHERE id = ?`, [productId])
  if (!product) return []

  const rows = await db.query<{ sale_unit: string; base_units: number; is_default: number }>(
    `SELECT sale_unit, base_units, is_default FROM product_units WHERE product_id = ? ORDER BY base_units`,
    [productId],
  )

  const options: SaleUnitOption[] = [
    { saleUnit: product.base_unit, baseUnits: qty(10_000), isDefault: rows.every((r) => r.is_default === 0) },
    ...rows.map((r) => ({ saleUnit: r.sale_unit, baseUnits: qty(r.base_units), isDefault: r.is_default === 1 })),
  ]
  return options
}

export interface CustomerListItem {
  id: string
  /** The shop's own short reference, if it gives them one. */
  code: string | null
  name: string
  phone: string | null
  gstin: string | null
  outstanding: Money
  creditLimit: Money
  loyaltyPoints: number
}

export async function searchCustomers(db: SqlDriver, term = '', limit = 50): Promise<CustomerListItem[]> {
  const like = `%${term.trim()}%`
  const rows = await db.query<{
    id: string; code: string | null; name: string; phone: string | null; gstin: string | null
    credit_limit: number; outstanding: number; points: number
  }>(
    `SELECT c.id, c.code, c.name, c.phone, c.gstin, c.credit_limit,
            COALESCE((SELECT SUM(b.credit_total) FROM bills b WHERE b.customer_id = c.id AND b.docstatus = 1), 0)
          - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                        JOIN bills b2 ON b2.id = pa.bill_id
                       WHERE b2.customer_id = c.id), 0) AS outstanding,
            COALESCE((SELECT SUM(le.points - le.consumed) FROM loyalty_entries le
                       WHERE le.customer_id = c.id AND le.cancelled_at IS NULL
                         AND (le.expires_at IS NULL OR le.expires_at > ?)), 0) AS points
       FROM customers c
      WHERE c.deleted_at IS NULL AND c.is_active = 1
        AND (? = '' OR c.name LIKE ? OR c.phone LIKE ? OR c.code LIKE ?)
      ORDER BY c.name
      LIMIT ?`,
    [new Date().toISOString(), term.trim(), like, like, like, limit],
  )

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    gstin: r.gstin,
    outstanding: r.outstanding as Money,
    creditLimit: r.credit_limit as Money,
    loyaltyPoints: r.points,
  }))
}

export interface BillListItem {
  id: string
  docNo: string
  docstatus: number
  postingDate: string
  customerName: string | null
  grandTotal: Money
  creditTotal: Money
  createdBy: string | null
}

export async function listBills(
  db: SqlDriver,
  opts: { limit?: number; offset?: number; from?: string; to?: string } = {},
): Promise<BillListItem[]> {
  const rows = await db.query<{
    id: string; doc_no: string; docstatus: number; posting_date: string
    customer_name: string | null; grand_total: number; credit_total: number; username: string | null
  }>(
    `SELECT b.id, b.doc_no, b.docstatus, b.posting_date, b.customer_name,
            b.grand_total, b.credit_total, u.username
       FROM bills b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.docstatus > 0
        AND (? IS NULL OR b.posting_date >= ?)
        AND (? IS NULL OR b.posting_date <= ?)
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?`,
    [opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null, opts.limit ?? 50, opts.offset ?? 0],
  )

  return rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    docstatus: r.docstatus,
    postingDate: r.posting_date,
    customerName: r.customer_name,
    grandTotal: r.grand_total as Money,
    creditTotal: r.credit_total as Money,
    createdBy: r.username,
  }))
}

export interface BillDetail extends BillListItem {
  subtotal: Money
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  cancelReason: string | null
  items: BillDetailItem[]
  payments: { method: string; amount: Money; reference: string | null }[]
}

export interface BillDetailItem {
  id: string
  productName: string
  saleUnit: string
  qty: Qty
  rate: Money
  lineTotal: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  hsnCode: string | null
  priceSource: string
  returnedQty: Qty
}

export async function loadBillDetail(db: SqlDriver, billId: string): Promise<BillDetail | null> {
  const head = await db.get<{
    id: string; doc_no: string; docstatus: number; posting_date: string; customer_name: string | null
    subtotal: number; discount: number; taxable_total: number; tax_total: number
    grand_total: number; credit_total: number; cancel_reason: string | null; username: string | null
  }>(
    `SELECT b.id, b.doc_no, b.docstatus, b.posting_date, b.customer_name, b.subtotal, b.discount,
            b.taxable_total, b.tax_total, b.grand_total, b.credit_total, b.cancel_reason, u.username
       FROM bills b LEFT JOIN users u ON u.id = b.created_by
      WHERE b.id = ?`,
    [billId],
  )
  if (!head) return null

  const items = await db.query<{
    id: string; product_name: string; sale_unit: string; qty: number; rate: number; line_total: number
    taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number
    hsn_code: string | null; price_source: string; returned_qty: number
  }>(
    `SELECT id, product_name, sale_unit, qty, rate, line_total, taxable_value,
            cgst_amount, sgst_amount, igst_amount, hsn_code, price_source, returned_qty
       FROM bill_items WHERE bill_id = ? ORDER BY idx`,
    [billId],
  )

  const payments = await db.query<{ method: string; amount: number; reference: string | null }>(
    `SELECT method, amount, reference FROM bill_payments WHERE bill_id = ?`,
    [billId],
  )

  return {
    id: head.id,
    docNo: head.doc_no,
    docstatus: head.docstatus,
    postingDate: head.posting_date,
    customerName: head.customer_name,
    subtotal: head.subtotal as Money,
    discount: head.discount as Money,
    taxableTotal: head.taxable_total as Money,
    taxTotal: head.tax_total as Money,
    grandTotal: head.grand_total as Money,
    creditTotal: head.credit_total as Money,
    cancelReason: head.cancel_reason,
    createdBy: head.username,
    items: items.map((i) => ({
      id: i.id,
      productName: i.product_name,
      saleUnit: i.sale_unit,
      qty: qty(i.qty),
      rate: i.rate as Money,
      lineTotal: i.line_total as Money,
      taxableValue: i.taxable_value as Money,
      cgst: i.cgst_amount as Money,
      sgst: i.sgst_amount as Money,
      igst: i.igst_amount as Money,
      hsnCode: i.hsn_code,
      priceSource: i.price_source,
      returnedQty: qty(i.returned_qty),
    })),
    payments: payments.map((p) => ({ method: p.method, amount: p.amount as Money, reference: p.reference })),
  }
}

interface ProductRow {
  id: string
  code: string | null
  name: string
  brand: string | null
  barcode: string | null
  base_unit: string
  base_rate: number
  mrp: number | null
  tax_rate_bp: number
  hsn_code: string | null
  is_stock_tracked: number
  qty_on_hand: number
  discount_blocked: number
  loyalty_blocked: number
}

function toProduct(r: ProductRow): ProductListItem {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    brand: r.brand,
    barcode: r.barcode,
    baseUnit: r.base_unit,
    baseRate: r.base_rate as Money,
    mrp: (r.mrp ?? null) as Money | null,
    taxRateBp: r.tax_rate_bp,
    hsnCode: r.hsn_code,
    isStockTracked: r.is_stock_tracked === 1,
    qtyOnHand: qty(r.qty_on_hand),
    discountBlocked: r.discount_blocked === 1,
    loyaltyBlocked: r.loyalty_blocked === 1,
  }
}
