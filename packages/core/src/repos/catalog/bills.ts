import { eq, gt, and, or, like, desc, count, sql, type SQL } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { ZERO, type Money } from '../../money.js'
import type { Qty } from '../../quantity.js'
import { SUBMITTED, CANCELLED } from '../../integrity/docstatus.js'

/* raw: whether goods came back against the bill of the row being looked at --
   an EXISTS correlated to the outer query, which a builder has no words for.
   `bills.id` is written out rather than interpolated because inside the
   subquery a bare `id` would bind to `sales_returns` and quietly answer about
   the wrong table. Shared by the filter and the column so the list cannot say
   one thing in its rows and another in what it filtered to. */
const anyReturnAgainstTheBill = sql`EXISTS (
  SELECT 1 FROM sales_returns r WHERE r.bill_id = bills.id AND r.docstatus = 1)`

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
