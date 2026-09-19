import { eq, and, desc, asc, sql, between } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import type { Money } from '../money.js'
import { type Qty, QTY_SCALE } from '../quantity.js'
import { SUBMITTED } from '../integrity/docstatus.js'
import type { DateRange } from './reports.js'

/**
 * One product's life: what came in, what went out, and what it was worth.
 *
 * The ledger has held all of this since Phase 0 and nothing could read it. The
 * Inventory screen had a Cost button that gave the current valuation -- a single
 * number, with no way to see how it got there -- and the rest was a table nobody
 * had a screen for.
 *
 * That matters more than a missing feature usually does, because the moving
 * average is derived rather than stored (`domain/valuation.ts` argues why), and a
 * derived number a shopkeeper cannot take apart is a number they have to either
 * trust or ignore. "Why does this say the average cost is 272.73 when I have
 * always paid 300" has an answer, and it is in these rows.
 */

/**
 * What the goods on a row were worth as they moved.
 *
 * Rounded at the row, not at the total: money is integer paise and a sum of
 * fractions is not. The divisor is written into the statement rather than bound
 * to it, because an interpolated value becomes a `?` and `? .0` is a syntax
 * error -- which is the good outcome, the alternative being integer division
 * quietly reporting a value that is wrong by a rounding.
 */
const SCALE_AS_REAL = sql.raw(`${QTY_SCALE}.0`)

const ROW_VALUE = sql<Money>`CAST(ROUND(
  ABS(${schema.stockLedger.qtyChange}) * ${schema.stockLedger.unitCost} / ${SCALE_AS_REAL}
) AS INTEGER)`

export interface StockMovement {
  at: string
  postingDate: string
  /** `bill`, `stock_entry`, `sales_return`, or one of those with `_reversal`. */
  voucherType: string
  voucherId: string
  /** The document's own number, so a row can be traced to paper. */
  docNo: string | null
  /** For a stock entry: purchase, opening, adjustment or wastage. */
  entryType: string | null
  /** Signed. Positive came in, negative went out. */
  qtyChange: Qty
  /** Null where nothing was ever recorded — see `noCostBasis`. */
  unitCost: Money | null
  /** What this movement was worth, or null when the rate is not known. */
  value: Money | null
  /** On hand immediately after, as it was recorded at the time. */
  balanceQty: Qty
  by: string | null
}

/**
 * Every movement of one product, newest first.
 *
 * `balance_qty` is read rather than recomputed. It is what the shelf said at the
 * moment of the movement, which is the question the column is answering — a
 * running total worked out now would instead say what today's arithmetic thinks
 * should have happened, and the two differing is exactly the drift
 * `recomputeStock` exists to find. A history that hides it is a history that
 * cannot be used to investigate it.
 */
export async function productHistory(
  db: SqlDriver, productId: string, limit = 200,
): Promise<StockMovement[]> {
  /* raw: the document number lives in a different table per voucher type, which
     is a discriminated union the builder has no way to express. Four left joins
     and a COALESCE says it once; the alternative is four queries and a merge in
     JavaScript for a column that is one string. */
  return db.query<StockMovement>(
    `SELECT l.created_at                       AS at,
            l.posting_date                     AS postingDate,
            l.voucher_type                     AS voucherType,
            l.voucher_id                       AS voucherId,
            COALESCE(b.doc_no, e.doc_no, r.doc_no) AS docNo,
            e.entry_type                       AS entryType,
            l.qty_change                       AS qtyChange,
            l.unit_cost                        AS unitCost,
            CASE WHEN l.unit_cost IS NULL THEN NULL ELSE
              CAST(ROUND(ABS(l.qty_change) * l.unit_cost / ${QTY_SCALE}.0) AS INTEGER)
            END                                AS value,
            l.balance_qty                      AS balanceQty,
            u.username                         AS by
       FROM stock_ledger l
       LEFT JOIN bills          b ON b.id = l.voucher_id
       LEFT JOIN stock_entries  e ON e.id = l.voucher_id
       LEFT JOIN sales_returns  r ON r.id = l.voucher_id
       LEFT JOIN users          u ON u.id = l.created_by
      WHERE l.product_id = ?
      ORDER BY l.posting_date DESC, l.rowid DESC
      LIMIT ?`,
    [productId, limit],
  )
}

export interface ProductProfit {
  qtySold: Qty
  revenue: Money
  cost: Money
  margin: Money
  /** Basis points of revenue, so 2350 reads as 23.5%. */
  marginBp: number
  /**
   * Sales of this item whose issue carried no cost.
   *
   * Counted rather than guessed at. The margin understates the cost by however
   * many of these there are, and a percentage that quietly leaves them out is
   * worse than one standing beside the number of lines it could not price.
   */
  uncostedLines: number
}

/**
 * What one product earned over a range.
 *
 * Revenue and cost are counted in two passes and combined here rather than
 * joined. The ledger has a row per issue and the bill has a row per line, so a
 * join multiplies one by the other and both figures come out too large by the
 * number of rows on the other side. `marginByProduct` solves the same problem
 * with two CTEs; for a single product two queries say it more plainly.
 */
export async function productProfit(
  db: SqlDriver, productId: string, range: DateRange,
): Promise<ProductProfit> {
  const onRegister = range.registerId
    ? [eq(schema.bills.registerId, range.registerId)]
    : []

  const [sold] = await q(db)
    .select({
      qty: sql<Qty>`COALESCE(SUM(${schema.billItems.baseQty}), 0)`,
      revenue: sql<Money>`COALESCE(SUM(${schema.billItems.taxableValue}), 0)`,
    })
    .from(schema.billItems)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.billItems.billId))
    .where(and(
      eq(schema.billItems.productId, productId),
      eq(schema.bills.docstatus, SUBMITTED),
      between(schema.bills.postingDate, range.from, range.to),
      ...onRegister,
    ))

  const [spent] = await q(db)
    .select({
      cost: sql<Money>`COALESCE(SUM(${ROW_VALUE}), 0)`,
      uncosted: sql<number>`SUM(CASE WHEN ${schema.stockLedger.unitCost} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(schema.stockLedger)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.stockLedger.voucherId))
    .where(and(
      eq(schema.stockLedger.productId, productId),
      eq(schema.stockLedger.voucherType, 'bill'),
      eq(schema.bills.docstatus, SUBMITTED),
      between(schema.bills.postingDate, range.from, range.to),
      ...onRegister,
    ))

  const revenue = (sold?.revenue ?? 0) as Money
  const cost = (spent?.cost ?? 0) as Money
  const margin = (revenue - cost) as Money

  return {
    qtySold: (sold?.qty ?? 0) as Qty,
    revenue,
    cost,
    margin,
    marginBp: revenue === 0 ? 0 : Math.round((margin / revenue) * 10_000),
    uncostedLines: spent?.uncosted ?? 0,
  }
}

export interface NoCostBasis {
  productId: string
  name: string
  qtyOnHand: Qty
  baseUnit: string
  /** Times the item has been received without a rate. */
  receipts: number
}

/**
 * Items the shop has never recorded a cost for.
 *
 * The one report the cost model actually needs, and the answer to "there is no
 * default cost price". There is no cost on the product on purpose: a single
 * mutable figure overwritten on each receipt makes COGS a function of today's
 * price and destroys the history needed to correct it later. Cost belongs to the
 * receipt, and the rate is derived.
 *
 * What that leaves is this. A receipt entered with the cost box empty falls back
 * to the last rate known for the item, which is a reasonable guess and usually
 * right. But an item whose *first* receipt had no cost has no rate to fall back
 * to, so it enters at zero — and every sale of it reads as pure profit, for
 * ever, with nothing anywhere saying so.
 *
 * Asked as "has this item ever been received with a rate", not "is its value
 * zero". A shop that sold everything it had is at zero value legitimately.
 */
export async function noCostBasis(db: SqlDriver): Promise<NoCostBasis[]> {
  const priced = q(db).$with('priced').as(
    q(db)
      .select({
        productId: schema.stockLedger.productId,
        everPriced: sql<number>`MAX(CASE
          WHEN ${schema.stockLedger.qtyChange} > 0
           AND ${schema.stockLedger.unitCost} IS NOT NULL THEN 1 ELSE 0 END)`.as('ever_priced'),
        blankReceipts: sql<number>`SUM(CASE
          WHEN ${schema.stockLedger.qtyChange} > 0
           AND ${schema.stockLedger.unitCost} IS NULL THEN 1 ELSE 0 END)`.as('blank_receipts'),
      })
      .from(schema.stockLedger)
      .groupBy(schema.stockLedger.productId),
  )

  const rows = await q(db)
    .with(priced)
    .select({
      productId: priced.productId,
      name: schema.products.name,
      qtyOnHand: sql<Qty>`COALESCE(${schema.productStock.qtyOnHand}, 0)`,
      baseUnit: schema.products.baseUnit,
      receipts: priced.blankReceipts,
    })
    .from(priced)
    .innerJoin(schema.products, eq(schema.products.id, priced.productId))
    .leftJoin(schema.productStock, eq(schema.productStock.productId, priced.productId))
    .where(eq(priced.everPriced, 0))
    .orderBy(desc(priced.blankReceipts), asc(schema.products.name))

  return rows
}
