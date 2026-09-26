import { eq, and, desc, asc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { type Money, ZERO } from '../../money.js'
import type { Qty } from '../../quantity.js'
import { type DateRange, money, returnedIn, soldIn } from './scope.js'

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

  /* A day with a return and no sale is still a day in the table. Built from the
     sales alone, a Sunday refund vanished, and the rows stopped adding up to
     the summary's net above them. */
  const soldOn = new Set(sales.map((r) => r.date))
  const refundOnly = returns
    .filter((r) => !soldOn.has(r.date))
    .map((r) => ({ date: r.date, bills: 0, discount: ZERO, tax: ZERO, total: ZERO }))

  return [...sales, ...refundOnly]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
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

/**
 * One business day's takings: what its submitted bills came to, and how many
 * there were.
 *
 * The home screen's headline. Counted exactly as `salesSummary` counts a range
 * -- submitted bills, by the day they were posted -- so the figure on the first
 * screen and the one on the report for the same day cannot disagree.
 */
export async function daySales(db: SqlDriver, date: string): Promise<{ total: Money; bills: number }> {
  const [row] = await q(db)
    .select({ total: money(schema.bills.grandTotal), n: sql<number>`COUNT(*)` })
    .from(schema.bills)
    .where(and(...soldIn({ from: date, to: date })))
  return { total: row?.total ?? ZERO, bills: row?.n ?? 0 }
}
