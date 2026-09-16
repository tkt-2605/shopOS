import { eq, gt, and, or, like, inArray, isNull, isNotNull, desc, count, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { ZERO, type Money } from '../money.js'
import { qty, QTY_SCALE, type Qty } from '../quantity.js'
import { SUBMITTED, CANCELLED } from '../integrity/docstatus.js'

/**
 * The parent a variant hangs off, and the item's own barcodes.
 *
 * Both are the products table and the barcodes table joined to themselves or to
 * products a second time, so they need names of their own -- without them the
 * join condition would compare a column to itself.
 */
const parent = alias(schema.products, 'parent')
const scanned = alias(schema.productBarcodes, 'pb')

/* raw: whether goods came back against the bill of the row being looked at --
   an EXISTS correlated to the outer query, which a builder has no words for.
   `bills.id` is written out rather than interpolated because inside the
   subquery a bare `id` would bind to `sales_returns` and quietly answer about
   the wrong table. Shared by the filter and the column so the list cannot say
   one thing in its rows and another in what it filtered to. */
const anyReturnAgainstTheBill = sql`EXISTS (
  SELECT 1 FROM sales_returns r WHERE r.bill_id = bills.id AND r.docstatus = 1)`

/**
 * The columns every product list returns.
 *
 * Three queries used to carry the same twenty-three lines of SELECT written out
 * three times, which is three places for a column to go missing from one. The
 * joins still have to be repeated -- they differ -- but what comes back does not.
 */
const productShape = {
  id: schema.products.id,
  code: schema.products.code,
  name: schema.products.name,
  brand: schema.products.brand,
  barcode: schema.products.barcode,
  baseUnit: schema.products.baseUnit,
  baseRate: schema.products.baseRate,
  mrp: schema.products.mrp,
  taxRateBp: schema.products.taxRateBp,
  hsnCode: schema.products.hsnCode,
  isStockTracked: schema.products.isStockTracked,
  isActive: schema.products.isActive,
  discountBlocked: schema.products.discountBlocked,
  loyaltyBlocked: schema.products.loyaltyBlocked,
  returnBlocked: schema.products.returnBlocked,
  reorderLevel: schema.products.reorderLevel,
  reorderQty: schema.products.reorderQty,
  categoryId: schema.products.categoryId,
  categoryName: schema.categories.name,
  parentProductId: schema.products.parentProductId,
  parentName: parent.name,
  variantLabel: schema.products.variantLabel,
  qtyOnHand: sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
}

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
  /**
   * Still sold here. False means retired: hidden from the counter's search and
   * the reorder list, still on every report and every old bill.
   *
   * Returned because the one screen that shows retired products has to be able
   * to say which they are. Everywhere else filters them out in SQL and never
   * sees a false.
   */
  isActive: boolean
  qtyOnHand: Qty
  /** Margin too thin to carry a discount, or to pay loyalty points on. */
  discountBlocked: boolean
  loyaltyBlocked: boolean
  /** A recharge, a cut length, anything perishable. The return screen refuses it. */
  returnBlocked: boolean
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
  const anywhere = `%${term}%`

  /* An empty term used to be handled by `(? = '' OR …)` -- the term bound a
     second time so SQLite could decide the rest of the condition did not
     apply. Here the condition is simply not in the list. */
  const matching = term === '' ? [] : [or(
    isNotNull(scanned.id),
    like(schema.products.name, anywhere),
    like(schema.products.brand, anywhere),
    like(schema.products.code, anywhere),
    like(parent.name, anywhere),
  )!]

  const rows = await q(db)
    .select(productShape)
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    /* The scanned barcode belongs in the join and not in the WHERE: as a left
       join it decides the sort order below without removing the items that
       were found by name. */
    .leftJoin(scanned, and(
      eq(scanned.productId, schema.products.id),
      eq(scanned.barcode, term),
    ))
    .where(and(
      isNull(schema.products.deletedAt),
      ...(opts.includeInactive ? [] : [eq(schema.products.isActive, 1)]),
      ...(opts.categoryId ? [eq(schema.products.categoryId, opts.categoryId)] : []),
      ...matching,
    ))
    .orderBy(
      sql`CASE WHEN ${scanned.id} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`COALESCE(${parent.name}, ${schema.products.name})`,
      schema.products.variantLabel,
      schema.products.name,
    )
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)

  return rows.map(toProduct)
}

/** Products by id, for rebuilding a held bill's cart from what was saved. */
export async function productsByIds(db: SqlDriver, ids: string[]): Promise<ProductListItem[]> {
  if (ids.length === 0) return []

  const rows = await q(db)
    .select(productShape)
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    .where(and(inArray(schema.products.id, ids), isNull(schema.products.deletedAt)))

  return rows.map(toProduct)
}

export async function findByBarcode(db: SqlDriver, barcode: string): Promise<ProductListItem | null> {
  const [row] = await q(db)
    .select(productShape)
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .leftJoin(parent, eq(parent.id, schema.products.parentProductId))
    // An inner join here, unlike the search: no barcode, no answer.
    .innerJoin(scanned, and(
      eq(scanned.productId, schema.products.id),
      eq(scanned.barcode, barcode.trim()),
    ))
    .where(and(isNull(schema.products.deletedAt), eq(schema.products.isActive, 1)))

  return row ? toProduct(row) : null
}

export interface SaleUnitOption {
  saleUnit: string
  baseUnits: Qty
  isDefault: boolean
}

export async function saleUnitsFor(db: SqlDriver, productId: string): Promise<SaleUnitOption[]> {
  const [product] = await q(db)
    .select({ baseUnit: schema.products.baseUnit })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
  if (!product) return []

  const rows = await q(db)
    .select({
      saleUnit: schema.productUnits.saleUnit,
      baseUnits: schema.productUnits.baseUnits,
      isDefault: schema.productUnits.isDefault,
    })
    .from(schema.productUnits)
    .where(eq(schema.productUnits.productId, productId))
    .orderBy(schema.productUnits.baseUnits)

  return [
    { saleUnit: product.baseUnit, baseUnits: qty(QTY_SCALE), isDefault: rows.every((r) => r.isDefault === 0) },
    ...rows.map((r) => ({ saleUnit: r.saleUnit, baseUnits: r.baseUnits, isDefault: r.isDefault === 1 })),
  ]
}

export interface CustomerListItem {
  id: string
  /** The shop's own short reference, if it gives them one. */
  code: string | null
  name: string
  phone: string | null
  gstin: string | null
  outstanding: Money
  /**
   * What the shop is holding for them, over and above any bill.
   *
   * Zero for almost everybody. A customer can have both: an advance on
   * their receipts and something owing on a bill raised since, and
   * netting the two into one signed number would lose which is which.
   */
  advance: Money
  creditLimit: Money
  loyaltyPoints: number
  /** Out of every search but this one. See `archiveCustomer`. */
  archived: boolean
}

/**
 * One customer, whole, for a form that is about to save them back.
 *
 * `CustomerListItem` is shaped for the list and carries neither the address,
 * the state nor the credit enforcement. The Customers screen was filling a form
 * from it anyway and defaulting the three it could not see -- address to empty,
 * enforcement to `hard` -- and then writing all of them back. So editing a
 * customer's phone number silently erased their address and moved a customer
 * who had been set to `none` onto hard credit enforcement, which stops them
 * buying at the counter.
 *
 * Nothing said so. It is the same failure as everything else in this phase: a
 * screen that looks like it edited one field and quietly wrote several.
 */
export interface CustomerDetail extends CustomerListItem {
  address: string | null
  stateCode: string | null
  creditEnforcement: 'none' | 'soft' | 'hard'
  isActive: boolean
}

export async function loadCustomer(db: SqlDriver, id: string): Promise<CustomerDetail | null> {
  /* Archived customers are loadable, deliberately: the screen that can bring
     one back has to be able to open them first, and an old bill's customer has
     to stay readable. The searches are where they disappear. */
  const [row] = await q(db)
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      name: schema.customers.name,
      phone: schema.customers.phone,
      gstin: schema.customers.gstin,
      address: schema.customers.address,
      stateCode: schema.customers.stateCode,
      creditLimit: schema.customers.creditLimit,
      creditEnforcement: schema.customers.creditEnforcement,
      isActive: schema.customers.isActive,
      deletedAt: schema.customers.deletedAt,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, id))
  if (!row) return null

  // The three figures the list computes are not what a form needs, and fetching
  // them here would make an edit wait on a join over every bill they ever had.
  return {
    ...row,
    creditEnforcement: row.creditEnforcement as 'none' | 'soft' | 'hard',
    archived: row.deletedAt !== null,
    isActive: row.isActive === 1,
    outstanding: 0 as Money,
    advance: 0 as Money,
    loyaltyPoints: 0,
  }
}

/**
 * The customers a screen should offer.
 *
 * `includeArchived` is for the one screen that can bring them back. Everywhere
 * else -- the counter's picker above all -- an archived customer is gone, which
 * is what archiving them was for.
 */
export async function searchCustomers(
  db: SqlDriver,
  term = '',
  limit = 50,
  opts: { includeArchived?: boolean } = {},
): Promise<CustomerListItem[]> {
  const now = new Date().toISOString()

  const rows = await q(db)
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      name: schema.customers.name,
      phone: schema.customers.phone,
      gstin: schema.customers.gstin,
      creditLimit: schema.customers.creditLimit,
      outstanding: sql<Money>`
        COALESCE((SELECT SUM(b.credit_total) FROM bills b
                   WHERE b.customer_id = customers.id AND b.docstatus = 1), 0)
      - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                    JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1
                    JOIN bills b2 ON b2.id = pa.bill_id
                   WHERE b2.customer_id = customers.id), 0)`,
      advance: sql<Money>`
        MAX(0,
          COALESCE((SELECT SUM(pe.amount) FROM payment_entries pe
                     WHERE pe.customer_id = customers.id AND pe.party_type = 'customer'
                       AND pe.docstatus = 1 AND pe.direction = 'in'), 0)
        - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                      JOIN payment_entries pe2 ON pe2.id = pa.payment_id
                     WHERE pe2.customer_id = customers.id AND pe2.docstatus = 1
                       AND pe2.direction = 'in'), 0)
        - COALESCE((SELECT SUM(pe3.amount) FROM payment_entries pe3
                     WHERE pe3.customer_id = customers.id AND pe3.party_type = 'customer'
                       AND pe3.docstatus = 1 AND pe3.direction = 'out'), 0)
        )`,
      loyaltyPoints: sql<number>`
        COALESCE((SELECT SUM(le.points - le.consumed) FROM loyalty_entries le
                   WHERE le.customer_id = customers.id AND le.cancelled_at IS NULL
                     AND (le.expires_at IS NULL OR le.expires_at > ${now})), 0)`,
      deletedAt: schema.customers.deletedAt,
    })
    .from(schema.customers)
    .where(and(
      eq(schema.customers.isActive, 1),
      ...(opts.includeArchived ? [] : [isNull(schema.customers.deletedAt)]),
      ...matchingCustomer(term),
    ))
    .orderBy(schema.customers.name)
    .limit(limit)

  return rows.map((r) => ({ ...r, archived: r.deletedAt !== null }))
}

/**
 * How many customers a search would find, ignoring the limit.
 *
 * `searchCustomers` stops at its limit and says nothing about having stopped,
 * so a screen showing five hundred of six hundred looks exactly like a screen
 * showing all six hundred. This is what lets it say which of the two it is.
 *
 * The filter is `searchCustomers`' filter, written out again rather than shared,
 * which is a risk worth naming: if one grows a condition the other must too.
 * The alternative was a `countOnly` flag threaded through a function whose
 * whole job is to return rows, and a boolean that changes what a function
 * returns is the worse trade.
 */
export async function countCustomers(
  db: SqlDriver,
  term = '',
  opts: { includeArchived?: boolean } = {},
): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.customers)
    .where(and(
      eq(schema.customers.isActive, 1),
      ...(opts.includeArchived ? [] : [isNull(schema.customers.deletedAt)]),
      ...matchingCustomer(term),
    ))
  return row?.n ?? 0
}

/** The name, phone and code test both of the two share. An empty term matches all. */
function matchingCustomer(term: string): SQL[] {
  const trimmed = term.trim()
  if (trimmed === '') return []
  const anywhere = `%${trimmed}%`
  return [or(
    like(schema.customers.name, anywhere),
    like(schema.customers.phone, anywhere),
    like(schema.customers.code, anywhere),
  )!]
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
function billWhere(filter: BillFilter): SQL[] {
  const parts: SQL[] = [eq(schema.bills.kind, 'sale')]


  switch (filter.status ?? 'all') {
    case 'live':
      parts.push(eq(schema.bills.docstatus, SUBMITTED))
      break
    case 'cancelled':
      parts.push(eq(schema.bills.docstatus, CANCELLED))
      break
    case 'returned':
      parts.push(gt(schema.bills.docstatus, 0), anyReturnAgainstTheBill)
      break
    case 'credit':
      // What is still on the khata, not what was ever put there: a bill since
      // paid off has credit_total unchanged, and listing it under "on credit"
      // would send a shopkeeper to ask for money already handed over.
      parts.push(
        eq(schema.bills.docstatus, SUBMITTED),
        gt(schema.bills.creditTotal, ZERO),
        /* raw: a scalar subquery compared against a column of the outer row.
           `bills.id` is written out rather than interpolated because inside
           the subquery a bare `id` would bind to `payment_allocations`. */
        sql`${schema.bills.creditTotal} > COALESCE((
          SELECT SUM(a.amount) FROM payment_allocations a
            JOIN payment_entries p ON p.id = a.payment_id
           WHERE a.bill_id = bills.id AND p.docstatus = 1
        ), 0)`,
      )
      break
    case 'all':
      // Drafts are a cart someone has parked, not a document. They belong to
      // the counter that is holding them.
      parts.push(gt(schema.bills.docstatus, 0))
      break
  }

  if (filter.from) parts.push(sql`${schema.bills.postingDate} >= ${filter.from}`)
  if (filter.to) parts.push(sql`${schema.bills.postingDate} <= ${filter.to}`)

  const search = filter.search?.trim()
  if (search) {
    parts.push(or(
      like(schema.bills.docNo, `%${search}%`),
      like(schema.bills.customerName, `%${search}%`),
    )!)
  }

  return parts
}

export async function listBills(db: SqlDriver, filter: BillFilter = {}): Promise<BillListItem[]> {
  const rows = await q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      docstatus: schema.bills.docstatus,
      postingDate: schema.bills.postingDate,
      customerName: schema.bills.customerName,
      grandTotal: schema.bills.grandTotal,
      creditTotal: schema.bills.creditTotal,
      createdBy: schema.users.username,
      returned: sql<number>`${anyReturnAgainstTheBill}`,
    })
    .from(schema.bills)
    .leftJoin(schema.users, eq(schema.users.id, schema.bills.createdBy))
    .where(and(...billWhere(filter)))
    .orderBy(desc(schema.bills.postingDate), desc(schema.bills.createdAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0)

  return rows.map((r) => ({ ...r, returned: r.returned === 1 }))
}

/**
 * How many there are in total, which the page needs because a limit without a
 * count is a page that quietly says "this is all of them" when it is not.
 */
export async function countBills(db: SqlDriver, filter: BillFilter = {}): Promise<number> {
  const [row] = await q(db)
    .select({ n: count() })
    .from(schema.bills)
    .where(and(...billWhere(filter)))
  return row?.n ?? 0
}

export interface BillDetail extends BillListItem {
  /** Who it was billed to, for selling the same list to them again. */
  customerId: string | null
  subtotal: Money
  discount: Money
  taxableTotal: Money
  taxTotal: Money
  /** The paise added or dropped to reach a round figure. Signed; usually zero. */
  roundOff: Money
  cancelReason: string | null
  items: BillDetailItem[]
  payments: { method: string; amount: Money; reference: string | null }[]

  /**
   * What the paper said, as the bill recorded it at submit — migration 028.
   *
   * Every one of these used to be read off a live join to `customers`, or
   * invented by the renderer: `printHtml.ts` printed the *shop's* own state as
   * the place of supply on every invoice it produced, including the ones billed
   * to another state. A reprint has to match the copy in the customer's hand,
   * and the only way it can is for the bill to hold its own answer.
   *
   * Null on a draft, which has not said anything to anybody yet, and on bills
   * raised before 028 for the one column the migration would have had to
   * fabricate to fill.
   */
  supplyType: 'intra_state' | 'inter_state' | null
  customerGstin: string | null
  customerAddress: string | null
  customerStateCode: string | null
  /** Where the supply was made, which is not always where the customer is. */
  placeOfSupply: string | null
  reverseCharge: boolean
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
  /** Rule 46(k): the rate, per line, not only the amount it came to. */
  taxRateBp: number
  priceSource: string
  returnedQty: Qty
}

export async function loadBillDetail(db: SqlDriver, billId: string): Promise<BillDetail | null> {
  const [head] = await q(db)
    .select({
      id: schema.bills.id,
      docNo: schema.bills.docNo,
      docstatus: schema.bills.docstatus,
      postingDate: schema.bills.postingDate,
      customerId: schema.bills.customerId,
      customerName: schema.bills.customerName,
      subtotal: schema.bills.subtotal,
      discount: schema.bills.discount,
      taxableTotal: schema.bills.taxableTotal,
      taxTotal: schema.bills.taxTotal,
      roundOff: schema.bills.roundOff,
      grandTotal: schema.bills.grandTotal,
      creditTotal: schema.bills.creditTotal,
      cancelReason: schema.bills.cancelReason,
      createdBy: schema.users.username,
      supplyType: schema.bills.supplyType,
      customerGstin: schema.bills.customerGstin,
      customerAddress: schema.bills.customerAddress,
      customerStateCode: schema.bills.customerStateCode,
      placeOfSupply: schema.bills.placeOfSupply,
      reverseCharge: schema.bills.reverseCharge,
    })
    .from(schema.bills)
    .leftJoin(schema.users, eq(schema.users.id, schema.bills.createdBy))
    .where(eq(schema.bills.id, billId))
  if (!head) return null

  const items = await q(db)
    .select({
      id: schema.billItems.id,
      productId: schema.billItems.productId,
      productName: schema.billItems.productName,
      saleUnit: schema.billItems.saleUnit,
      qty: schema.billItems.qty,
      rate: schema.billItems.rate,
      lineTotal: schema.billItems.lineTotal,
      taxableValue: schema.billItems.taxableValue,
      cgst: schema.billItems.cgstAmount,
      sgst: schema.billItems.sgstAmount,
      igst: schema.billItems.igstAmount,
      hsnCode: schema.billItems.hsnCode,
      taxRateBp: schema.billItems.taxRateBp,
      priceSource: schema.billItems.priceSource,
      returnedQty: schema.billItems.returnedQty,
    })
    .from(schema.billItems)
    .where(eq(schema.billItems.billId, billId))
    .orderBy(schema.billItems.idx)

  const payments = await q(db)
    .select({
      method: schema.billPayments.method,
      amount: schema.billPayments.amount,
      reference: schema.billPayments.reference,
    })
    .from(schema.billPayments)
    .where(eq(schema.billPayments.billId, billId))

  return {
    ...head,
    // From the lines rather than a second query: they are already loaded, and
    // `returned_qty` is the same fact the EXISTS on the list answers.
    returned: items.some((i) => i.returnedQty > 0),
    items,
    payments,
    /* The column is text and a database written by an older build can hold
       something else in it, so the two the type names are checked for rather
       than cast to. */
    supplyType: head.supplyType === 'inter_state' || head.supplyType === 'intra_state'
      ? head.supplyType
      : null,
    reverseCharge: head.reverseCharge === 1,
  }
}

/**
 * A row exactly as the three product queries return it.
 *
 * Derived from what a screen is given rather than written out a second time:
 * the columns are the same, and the five SQLite keeps as 0 and 1 because it has
 * no boolean are the only ones that differ.
 */
type Ticked = 'isStockTracked' | 'isActive' | 'discountBlocked' | 'loyaltyBlocked' | 'returnBlocked'
type ProductRow = Omit<ProductListItem, Ticked> & Record<Ticked, number>

/**
 * The five columns SQLite keeps as 0 and 1 because it has no boolean.
 *
 * Everything else arrives in the shape the screen wants, brands included, so
 * this is all that is left of what used to be a twenty-three line hand
 * translation from snake_case rows.
 */
function toProduct(r: ProductRow): ProductListItem {
  return {
    ...r,
    isStockTracked: r.isStockTracked === 1,
    isActive: r.isActive === 1,
    discountBlocked: r.discountBlocked === 1,
    loyaltyBlocked: r.loyaltyBlocked === 1,
    returnBlocked: r.returnBlocked === 1,
  }
}
