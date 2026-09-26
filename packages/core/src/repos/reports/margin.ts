import { eq, and, desc, between, isNotNull, sql } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import type { Money } from '../../money.js'
import { QTY_SCALE, type Qty } from '../../quantity.js'
import { SUBMITTED } from '../../integrity/docstatus.js'
import { type DateRange, money, onRegister, returnedIn, soldIn } from './scope.js'

/**
 * Gross margin.
 *
 * Revenue is the taxable value, never the grand total: GST is collected for the
 * government, not earned, and cost is recorded exclusive of it. Comparing the two
 * on the same basis is the whole point.
 *
 * Cost comes off the stock ledger, where every issue was stamped with what the
 * goods were worth as they left, so nothing here re-derives history.
 */
export interface Margin {
  revenue: Money
  cost: Money
  margin: Money
  /** Basis points of revenue, so 2350 reads as 23.5%. */
  marginBp: number
  /** Lines whose cost was never recorded — margin understates the cost by this much. */
  uncostedLines: number
}

/* The divisor written into the statement rather than bound to it. An
   interpolated value becomes a `?`, and `? .0` is a syntax error -- which is
   the good outcome, because the alternative was integer division quietly
   halving nothing and reporting a margin that is wrong by a rounding. */
const SCALE_AS_REAL = sql.raw(`${QTY_SCALE}.0`)

/**
 * What the goods on a ledger row were worth as they left.
 *
 * `qty_change` is negative for an issue, so the sign flips back here. Rounded
 * to whole paise at the row, not at the total: money is integer paise and a sum
 * of fractions is not.
 */
const COST = sql<Money>`CAST(ROUND(
  -${schema.stockLedger.qtyChange} * ${schema.stockLedger.unitCost} / ${SCALE_AS_REAL}
) AS INTEGER)`

export async function grossMargin(db: SqlDriver, range: DateRange): Promise<Margin> {

  const [sold] = await q(db)
    .select({
      revenue: money(schema.billItems.taxableValue),
      /* A line whose issue was never stamped with a cost. Counted rather than
         guessed at: the margin understates the cost by however many of these
         there are, and a figure that quietly excludes them is worse than one
         that says how much of itself is missing. */
      uncosted: sql<number>`COALESCE(SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM stock_ledger sl
         WHERE sl.voucher_type = 'bill' AND sl.voucher_id = ${schema.bills.id}
           AND sl.product_id = ${schema.billItems.productId} AND sl.unit_cost IS NOT NULL
      ) THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(...soldIn(range)))

  const [soldCost] = await q(db)
    .select({ cost: money(COST) })
    .from(schema.stockLedger)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.stockLedger.voucherId))
    .where(and(
      eq(schema.stockLedger.voucherType, 'bill'),
      isNotNull(schema.stockLedger.unitCost),
      eq(schema.bills.docstatus, SUBMITTED),
      between(schema.bills.postingDate, range.from, range.to),
      ...onRegister(range),
    ))

  const [returned] = await q(db)
    .select({ revenue: money(schema.salesReturnItems.taxableValue) })
    .from(schema.salesReturnItems)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.salesReturnItems.returnId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(...returnedIn(range)))

  const [returnedCost] = await q(db)
    .select({ cost: money(COST) })
    .from(schema.stockLedger)
    .innerJoin(schema.salesReturns, eq(schema.salesReturns.id, schema.stockLedger.voucherId))
    .innerJoin(schema.bills, eq(schema.bills.id, schema.salesReturns.billId))
    .where(and(
      eq(schema.stockLedger.voucherType, 'sales_return'),
      isNotNull(schema.stockLedger.unitCost),
      ...returnedIn(range),
    ))

  // A return's movement is positive, so its COST comes out negative — which is
  // exactly right: goods coming back reduce the cost of what was sold.
  const revenue = (sold?.revenue ?? 0) - (returned?.revenue ?? 0)
  const cost = (soldCost?.cost ?? 0) + (returnedCost?.cost ?? 0)

  return {
    revenue: revenue as Money,
    cost: cost as Money,
    margin: (revenue - cost) as Money,
    marginBp: revenue === 0 ? 0 : Math.round(((revenue - cost) / revenue) * 10_000),
    uncostedLines: sold?.uncosted ?? 0,
  }
}

export interface ProductMargin {
  productId: string
  name: string
  qty: Qty
  unit: string
  revenue: Money
  cost: Money
  margin: Money
  marginBp: number
}

export async function marginByProduct(db: SqlDriver, range: DateRange, limit = 25): Promise<ProductMargin[]> {

  /* What was sold and what it cost are grouped separately and joined once,
     rather than joined and then grouped: the ledger has a row per issue and the
     bill has a row per line, so joining first multiplies one by the other and
     every figure comes out too large by the number of rows on the other side. */
  const sold = q(db).$with('sold').as(
    q(db)
      .select({
        productId: schema.billItems.productId,
        /* Aliased `product_name` and not `name`: the final select also joins
           `products`, which has a `name` of its own, and a bare `name` in the
           select list is ambiguous. SQLite refuses rather than picking one,
           which is the good outcome of the two available. */
        name: sql<string>`MAX(${schema.billItems.productName})`.as('product_name'),
        baseQty: sql<Qty>`SUM(${schema.billItems.baseQty})`.as('base_qty'),
        revenue: sql<Money>`SUM(${schema.billItems.taxableValue})`.as('revenue'),
      })
      .from(schema.billItems)
      .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
      .where(and(...soldIn(range)))
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
      .where(and(
        eq(schema.stockLedger.voucherType, 'bill'),
        isNotNull(schema.stockLedger.unitCost),
        eq(schema.bills.docstatus, SUBMITTED),
        between(schema.bills.postingDate, range.from, range.to),
        ...onRegister(range),
      ))
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
    // Left, so a product deleted since it was sold keeps its margin on the report.
    .leftJoin(schema.products, eq(schema.products.id, sold.productId))
    .orderBy(desc(margin))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    margin: (r.revenue - r.cost) as Money,
    marginBp: r.revenue === 0 ? 0 : Math.round(((r.revenue - r.cost) / r.revenue) * 10_000),
  }))
}
