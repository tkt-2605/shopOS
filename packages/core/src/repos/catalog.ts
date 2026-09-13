import type { SqlDriver, SqlValue } from '../db/driver.js'
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
  /** Null means the owner has not set one, which is not the same as zero. */
  reorderLevel: Qty | null
  reorderQty: Qty | null
  categoryId: string | null
  categoryName: string | null
  /** Set when this item is a version of another — the blue one of the pen. */
  parentProductId: string | null
  parentName: string | null
  variantLabel: string | null
}

export interface SearchOptions {
  term?: string
  limit?: number
  offset?: number
  includeInactive?: boolean
  /** Browse one group rather than search: what a touch screen and an app need. */
  categoryId?: string
}

/**
 * An exact barcode match sorts first: the scanner is the primary input and the
 * cashier expects the scanned item, not an alphabetical near-miss.
 *
 * "Exact" means any of the item's barcodes, not just the printed one — the
 * manufacturer's EAN and the shop's own label are the same product.
 *
 * A search also matches an item's parent, so typing the pen's name offers all
 * six colours rather than only the ones whose own name repeats it, and versions
 * of the same thing sort together rather than scattering through the alphabet.
 */
export async function searchProducts(db: SqlDriver, opts: SearchOptions = {}): Promise<ProductListItem[]> {
  const term = opts.term?.trim() ?? ''
  const like = `%${term}%`
  const limit = opts.limit ?? 50
  const activeClause = opts.includeInactive ? '' : 'AND p.is_active = 1'
  const categoryClause = opts.categoryId ? 'AND p.category_id = ?' : ''

  const rows = await db.query<ProductRow>(
    `SELECT p.id, p.code, p.name, p.brand, p.barcode, p.base_unit, p.base_rate, p.mrp,
            p.tax_rate_bp, p.hsn_code, p.is_stock_tracked,
            p.discount_blocked, p.loyalty_blocked, p.reorder_level, p.reorder_qty,
            p.category_id, cat.name AS category_name,
            p.parent_product_id, parent.name AS parent_name, p.variant_label,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
       LEFT JOIN categories cat ON cat.id = p.category_id
       LEFT JOIN products parent ON parent.id = p.parent_product_id
       LEFT JOIN product_barcodes pb ON pb.product_id = p.id AND pb.barcode = ?
      WHERE p.deleted_at IS NULL ${activeClause} ${categoryClause}
        AND (? = '' OR pb.id IS NOT NULL OR p.name LIKE ? OR p.brand LIKE ? OR p.code LIKE ?
             OR parent.name LIKE ?)
      ORDER BY CASE WHEN pb.id IS NOT NULL THEN 0 ELSE 1 END,
               COALESCE(parent.name, p.name), p.variant_label, p.name
      LIMIT ? OFFSET ?`,
    [term, ...(opts.categoryId ? [opts.categoryId] : []), term, like, like, like, like,
     limit, opts.offset ?? 0],
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
            p.discount_blocked, p.loyalty_blocked, p.reorder_level, p.reorder_qty,
            p.category_id, cat.name AS category_name,
            p.parent_product_id, parent.name AS parent_name, p.variant_label,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
       LEFT JOIN categories cat ON cat.id = p.category_id
       LEFT JOIN products parent ON parent.id = p.parent_product_id
      WHERE p.id IN (${holes}) AND p.deleted_at IS NULL`,
    ids,
  )
  return rows.map(toProduct)
}

export async function findByBarcode(db: SqlDriver, barcode: string): Promise<ProductListItem | null> {
  const row = await db.get<ProductRow>(
    `SELECT p.id, p.code, p.name, p.brand, p.barcode, p.base_unit, p.base_rate, p.mrp,
            p.tax_rate_bp, p.hsn_code, p.is_stock_tracked,
            p.discount_blocked, p.loyalty_blocked, p.reorder_level, p.reorder_qty,
            p.category_id, cat.name AS category_name,
            p.parent_product_id, parent.name AS parent_name, p.variant_label,
            COALESCE(ps.qty_on_hand, 0) AS qty_on_hand
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id
       LEFT JOIN categories cat ON cat.id = p.category_id
       LEFT JOIN products parent ON parent.id = p.parent_product_id
       JOIN product_barcodes pb ON pb.product_id = p.id AND pb.barcode = ?
      WHERE p.deleted_at IS NULL AND p.is_active = 1`,
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
  /** Whether any goods have come back against it. */
  returned: boolean
}

/**
 * Which bills a screen is asking for.
 *
 * "Status" is not a column, and pretending it were would mean inventing one.
 * A bill is cancelled or it is not (`docstatus`); it has goods back against it
 * or it does not (`sales_returns`); it was partly put on the khata or it was
 * not (`credit_total`). Those are three different facts, and a shop looking for
 * "the cancelled ones" and a shop looking for "the ones still owed" are asking
 * two different questions, so the filter names them rather than merging them
 * into a single invented state field.
 */
export type BillStatusFilter = 'all' | 'live' | 'cancelled' | 'returned' | 'credit'

export interface BillFilter {
  from?: string
  to?: string
  status?: BillStatusFilter
  /** Matches the document number or the customer's name. */
  search?: string
  limit?: number
  offset?: number
}

/**
 * The WHERE shared by the list and the count, so the two cannot disagree about
 * what they are counting.
 *
 * `kind = 'sale'` is on every branch and is not optional. An opening balance is
 * a bill only because a payment has to allocate against something (migration
 * 013); it is not something the shop sold, and it must never appear on a screen
 * that says "Bills" whatever filter is chosen.
 */
function billWhere(filter: BillFilter): { clause: string; params: SqlValue[] } {
  const parts: string[] = [`b.kind = 'sale'`]
  const params: SqlValue[] = []

  switch (filter.status ?? 'all') {
    case 'live':
      parts.push(`b.docstatus = 1`)
      break
    case 'cancelled':
      parts.push(`b.docstatus = 2`)
      break
    case 'returned':
      parts.push(`b.docstatus > 0`)
      parts.push(`EXISTS (SELECT 1 FROM sales_returns r WHERE r.bill_id = b.id AND r.docstatus = 1)`)
      break
    case 'credit':
      // What is still on the khata, not what was ever put there: a bill since
      // paid off has credit_total unchanged, and listing it under "on credit"
      // would send a shopkeeper to ask for money already handed over.
      parts.push(`b.docstatus = 1`)
      parts.push(`b.credit_total > 0`)
      parts.push(`b.credit_total > COALESCE((
        SELECT SUM(a.amount) FROM payment_allocations a
          JOIN payment_entries p ON p.id = a.payment_id
         WHERE a.bill_id = b.id AND p.docstatus = 1
      ), 0)`)
      break
    case 'all':
      // Drafts are a cart someone has parked, not a document. They belong to
      // the counter that is holding them.
      parts.push(`b.docstatus > 0`)
      break
  }

  if (filter.from) { parts.push(`b.posting_date >= ?`); params.push(filter.from) }
  if (filter.to) { parts.push(`b.posting_date <= ?`); params.push(filter.to) }

  const search = filter.search?.trim()
  if (search) {
    parts.push(`(b.doc_no LIKE ? OR b.customer_name LIKE ?)`)
    params.push(`%${search}%`, `%${search}%`)
  }

  return { clause: parts.join(' AND '), params }
}

export async function listBills(db: SqlDriver, filter: BillFilter = {}): Promise<BillListItem[]> {
  const { clause, params } = billWhere(filter)

  const rows = await db.query<{
    id: string; doc_no: string; docstatus: number; posting_date: string
    customer_name: string | null; grand_total: number; credit_total: number; username: string | null
    returned: number
  }>(
    `SELECT b.id, b.doc_no, b.docstatus, b.posting_date, b.customer_name,
            b.grand_total, b.credit_total, u.username,
            EXISTS (SELECT 1 FROM sales_returns r WHERE r.bill_id = b.id AND r.docstatus = 1) AS returned
       FROM bills b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE ${clause}
      ORDER BY b.posting_date DESC, b.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
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
    returned: r.returned === 1,
  }))
}

/**
 * How many there are in total, which the page needs because a limit without a
 * count is a page that quietly says "this is all of them" when it is not.
 */
export async function countBills(db: SqlDriver, filter: BillFilter = {}): Promise<number> {
  const { clause, params } = billWhere(filter)
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bills b WHERE ${clause}`, params)
  return row?.n ?? 0
}

export interface BillDetail extends BillListItem {
  /** Who it was billed to, for selling the same list to them again. */
  customerId: string | null
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
  /** The item itself, not only the name it was sold under. */
  productId: string
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
    id: string; doc_no: string; docstatus: number; posting_date: string
    customer_id: string | null; customer_name: string | null
    subtotal: number; discount: number; taxable_total: number; tax_total: number
    grand_total: number; credit_total: number; cancel_reason: string | null; username: string | null
  }>(
    `SELECT b.id, b.doc_no, b.docstatus, b.posting_date, b.customer_id, b.customer_name,
            b.subtotal, b.discount,
            b.taxable_total, b.tax_total, b.grand_total, b.credit_total, b.cancel_reason, u.username
       FROM bills b LEFT JOIN users u ON u.id = b.created_by
      WHERE b.id = ?`,
    [billId],
  )
  if (!head) return null

  const items = await db.query<{
    id: string; product_id: string; product_name: string; sale_unit: string
    qty: number; rate: number; line_total: number
    taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number
    hsn_code: string | null; price_source: string; returned_qty: number
  }>(
    `SELECT id, product_id, product_name, sale_unit, qty, rate, line_total, taxable_value,
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
    customerId: head.customer_id,
    customerName: head.customer_name,
    // From the lines rather than a second query: they are already loaded, and
    // `returned_qty` is the same fact the EXISTS on the list answers.
    returned: items.some((i) => i.returned_qty > 0),
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
      productId: i.product_id,
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
  reorder_level: number | null
  reorder_qty: number | null
  category_id: string | null
  category_name: string | null
  parent_product_id: string | null
  parent_name: string | null
  variant_label: string | null
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
    reorderLevel: r.reorder_level === null ? null : qty(r.reorder_level),
    reorderQty: r.reorder_qty === null ? null : qty(r.reorder_qty),
    categoryId: r.category_id,
    categoryName: r.category_name,
    parentProductId: r.parent_product_id,
    parentName: r.parent_name,
    variantLabel: r.variant_label,
  }
}
