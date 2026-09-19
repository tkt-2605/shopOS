import { eq, and, desc, sql, between } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { type Qty, QTY_SCALE } from '../quantity.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import type { DateRange } from './reports.js'

/**
 * What one customer is worth, rather than only what they owe.
 *
 * The Credit screen has always answered the second question — `customerAccount`
 * gives a running balance and what they have bought, paid and returned. The
 * first question had no answer anywhere, and it is the one that decides whether
 * a discount is worth giving: a customer who buys ₹50,000 of goods the shop
 * makes 4% on is a different customer from one who buys ₹20,000 at 30%.
 *
 * Both are computable from what is already recorded, because every sale stamps
 * its own cost into the ledger as it leaves. Nothing here estimates anything.
 */

const SCALE_AS_REAL = sql.raw(`${QTY_SCALE}.0`)

/**
 * What the goods on a ledger row were worth as they left.
 *
 * `qty_change` is negative for an issue, so the sign flips back. Rounded at the
 * row rather than the total: money is integer paise and a sum of fractions is
 * not.
 */
const COST = sql<Money>`CAST(ROUND(
  -${schema.stockLedger.qtyChange} * ${schema.stockLedger.unitCost} / ${SCALE_AS_REAL}
) AS INTEGER)`

export interface CustomerProfit {
  bills: number
  revenue: Money
  cost: Money
  margin: Money
  /** Basis points of revenue, so 2350 reads as 23.5%. */
  marginBp: number
  /** Sales to this customer whose issue carried no cost. See `noCostBasis`. */
  uncostedLines: number
}

/**
 * Revenue, cost and margin for one customer over a range.
 *
 * Counted in two passes and combined here rather than joined: the ledger has a
 * row per issue and the bill has a row per line, so joining first multiplies one
 * by the other and both figures come out too large by the number of rows on the
 * other side. `marginByProduct` solves the same problem with two CTEs.
 *
 * Returns are not subtracted here. A return posts its own ledger rows and its
 * own bill, so it is already absent from both sides of this — the revenue was
 * never counted and the goods came back at the rate they left at.
 */
export async function customerProfit(
  db: SqlDriver, customerId: string, range: DateRange,
): Promise<CustomerProfit> {
  const onRegister = range.registerId
    ? [eq(schema.bills.registerId, range.registerId)]
    : []

  const scope = [
    eq(schema.bills.customerId, customerId),
    eq(schema.bills.docstatus, SUBMITTED),
    between(schema.bills.postingDate, range.from, range.to),
    ...onRegister,
  ]

  const [sold] = await q(db)
    .select({
      bills: sql<number>`COUNT(DISTINCT ${schema.bills.id})`,
      revenue: sql<Money>`COALESCE(SUM(${schema.billItems.taxableValue}), 0)`,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(...scope))

  const [spent] = await q(db)
    .select({
      cost: sql<Money>`COALESCE(SUM(${COST}), 0)`,
      uncosted: sql<number>`SUM(CASE WHEN ${schema.stockLedger.unitCost} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(schema.stockLedger)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.stockLedger.voucherId))
    .where(and(eq(schema.stockLedger.voucherType, 'bill'), ...scope))

  const revenue = (sold?.revenue ?? 0) as Money
  const cost = (spent?.cost ?? 0) as Money
  const margin = (revenue - cost) as Money

  return {
    bills: sold?.bills ?? 0,
    revenue,
    cost,
    margin,
    marginBp: revenue === 0 ? 0 : Math.round((margin / revenue) * 10_000),
    uncostedLines: spent?.uncosted ?? 0,
  }
}

export interface CustomerItem {
  productId: string
  name: string
  qty: Qty
  unit: string
  revenue: Money
  cost: Money
  margin: Money
  marginBp: number
}

/**
 * What this customer actually buys, by what the shop makes on it.
 *
 * Ordered by margin rather than by revenue, because the two disagree often
 * enough to be worth the choice: the line a customer spends most on is
 * frequently the one the shop competes hardest on.
 */
export async function customerItems(
  db: SqlDriver, customerId: string, range: DateRange, limit = 20,
): Promise<CustomerItem[]> {
  const onRegister = range.registerId
    ? [eq(schema.bills.registerId, range.registerId)]
    : []

  const scope = [
    eq(schema.bills.customerId, customerId),
    eq(schema.bills.docstatus, SUBMITTED),
    between(schema.bills.postingDate, range.from, range.to),
    ...onRegister,
  ]

  const sold = q(db).$with('sold').as(
    q(db)
      .select({
        productId: schema.billItems.productId,
        /* Aliased, because the final select joins `products`, which has a
           `name` of its own — and a bare `name` is then ambiguous. SQLite
           refuses rather than picking one, which is the better of the two. */
        name: sql<string>`MAX(${schema.billItems.productName})`.as('product_name'),
        baseQty: sql<Qty>`SUM(${schema.billItems.baseQty})`.as('base_qty'),
        revenue: sql<Money>`SUM(${schema.billItems.taxableValue})`.as('revenue'),
      })
      .from(schema.billItems)
      .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
      .where(and(...scope))
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
      .where(and(eq(schema.stockLedger.voucherType, 'bill'), ...scope))
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
    // Left, so an item retired since it was sold keeps its place on the list.
    .leftJoin(schema.products, eq(schema.products.id, sold.productId))
    .orderBy(desc(margin))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    margin: (r.revenue - r.cost) as Money,
    marginBp: r.revenue === 0 ? 0 : Math.round(((r.revenue - r.cost) / r.revenue) * 10_000),
  }))
}
