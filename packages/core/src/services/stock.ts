import { eq, and, ne, inArray, isNotNull, asc, desc, sql } from 'drizzle-orm'
import type { SqlDriver } from '../db/driver.js'
import { q, schema } from '../db/q.js'
import { newId } from '../ids.js'
import { type Qty, qty, addQty, hasAtLeast, QTY_SCALE, QTY_ZERO } from '../quantity.js'
import type { Money } from '../money.js'
import { movingAverage, fifo, type LedgerMovement, type Valuation, type FifoResult } from '../domain/valuation.js'

/**
 * stock_ledger is the truth; product_stock is a cache kept in the same transaction
 * so the preflight is O(1). recomputeStock() rebuilds the cache from the ledger and
 * reports any drift — if that ever returns a non-empty list, something wrote stock
 * outside this module.
 */

export interface StockPosting {
  productId: string
  qtyChange: Qty
  unitCost?: Money | null
  voucherType: string
  voucherId: string
  postingDate: string
  userId?: string | null
}

export async function currentStock(db: SqlDriver, productId: string): Promise<Qty> {
  const [row] = await q(db)
    .select({ onHand: schema.productStock.qtyOnHand })
    .from(schema.productStock)
    .where(eq(schema.productStock.productId, productId))
  return row?.onHand ?? QTY_ZERO
}

export async function postMovement(tx: SqlDriver, posting: StockPosting): Promise<Qty> {
  if (posting.qtyChange === 0) throw new RangeError('stock movement of zero')

  const held = await holding(tx, posting.productId)
  const after = addQty(held.qty, posting.qtyChange)

  // Goods leaving are valued at what the goods on the shelf cost, unless the
  // caller already knows (a reversal puts back exactly what it took out). With
  // nothing on the shelf there is no average to read, so the last rate the item
  // was known at stands in — see `movingAverage`, which defines the rule this
  // follows. A sale with no cost at all reports as pure profit.
  const unitCost = posting.unitCost
    ?? (posting.qtyChange < 0
      ? unitValueOf(held) ?? await lastKnownCost(tx, posting.productId)
      : null)

  const afterValue = valueAfter(held, posting.qtyChange, unitCost, after)

  const now = new Date().toISOString()

  await q(tx).insert(schema.stockLedger).values({
    id: newId(),
    productId: posting.productId,
    postingDate: posting.postingDate,
    qtyChange: posting.qtyChange,
    unitCost,
    balanceQty: after,
    voucherType: posting.voucherType,
    voucherId: posting.voucherId,
    createdBy: posting.userId ?? null,
    createdAt: now,
  })

  await cacheStock(tx, posting.productId, after, afterValue, now)

  return after
}

/**
 * The cache, written as one statement.
 *
 * Upsert rather than read-then-write: two tills posting movements for the same
 * product would otherwise both find no row and both insert one.
 */
async function cacheStock(
  db: SqlDriver,
  productId: string,
  onHand: Qty,
  value: number,
  now: string,
): Promise<void> {
  await q(db).insert(schema.productStock)
    .values({ productId, qtyOnHand: onHand, stockValue: value as Money, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.productStock.productId,
      set: {
        qtyOnHand: sql`excluded.qty_on_hand`,
        stockValue: sql`excluded.stock_value`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
}

interface Holding {
  qty: Qty
  value: number
}

async function holding(tx: SqlDriver, productId: string): Promise<Holding> {
  const [row] = await q(tx)
    .select({ onHand: schema.productStock.qtyOnHand, value: schema.productStock.stockValue })
    .from(schema.productStock)
    .where(eq(schema.productStock.productId, productId))
  return { qty: row?.onHand ?? QTY_ZERO, value: row?.value ?? 0 }
}

/** Moving average: what one base unit on the shelf is worth right now. */
function unitValueOf(held: Holding): Money | null {
  if (held.qty <= 0 || held.value <= 0) return null
  return Math.round((held.value * QTY_SCALE) / held.qty) as Money
}

function valueOf(unitCost: Money, quantity: Qty): number {
  return Math.round((unitCost * quantity) / QTY_SCALE)
}

/**
 * What the holding is worth after a movement. The live half of the rule written
 * out on `movingAverage`; both must agree or the cache and the ledger drift.
 */
function valueAfter(held: Holding, change: Qty, unitCost: Money | null, after: Qty): number {
  if (after <= 0) return 0

  // Coming back from a shortfall: the goods that were owed were never paid for,
  // so only what is left over carries value, at the rate it arrived at.
  if (held.qty < 0 && change > 0) {
    return unitCost === null ? 0 : Math.max(0, valueOf(unitCost, after))
  }

  const valueChange = unitCost === null ? 0 : valueOf(unitCost, change)
  return Math.max(0, held.value + valueChange)
}

/**
 * The most recent rate this item was known at. Goods bought in are preferred
 * over goods issued, because a purchase is a price somebody actually paid.
 */
async function lastKnownCost(tx: SqlDriver, productId: string): Promise<Money | null> {
  const [row] = await q(tx)
    .select({ unitCost: schema.stockLedger.unitCost })
    .from(schema.stockLedger)
    .where(and(
      eq(schema.stockLedger.productId, productId),
      isNotNull(schema.stockLedger.unitCost),
    ))
    /* Purchases before issues, then the most recent of whichever won. The
       first term is a boolean sorted descending, so every row where goods came
       *in* sorts ahead of every row where they went out. */
    .orderBy(desc(sql`${schema.stockLedger.qtyChange} > 0`), desc(ROWID))
    .limit(1)
  return row?.unitCost ?? null
}

/**
 * The order rows were written in.
 *
 * Not a column in `schema.ts` because it is not a column in the table: SQLite
 * gives every row one unless the table says otherwise, and this is how the
 * ledger's own order is read. `posting_date` is a different question -- a
 * backdated entry belongs where it was entered, not where its date puts it.
 */
const ROWID = sql`rowid`

/**
 * What the goods on hand are worth, and what one unit of them costs. Reported
 * rather than stored as a rate, because the rate is the lossy half of the pair.
 */
export async function stockValue(
  db: SqlDriver,
  productId: string,
): Promise<{ qty: Qty; value: Money; unitCost: Money | null }> {
  const held = await holding(db, productId)
  return { qty: held.qty, value: held.value as Money, unitCost: unitValueOf(held) }
}

/**
 * What a product cost when it left on a given voucher. Goods coming back from a
 * sale return at the cost they went out at — valuing them at today's average
 * instead would move money between periods every time a customer changed their mind.
 */
export async function issuedUnitCost(
  tx: SqlDriver,
  voucherType: string,
  voucherId: string,
  productId: string,
): Promise<Money | null> {
  const [row] = await q(tx)
    .select({ unitCost: schema.stockLedger.unitCost })
    .from(schema.stockLedger)
    .where(and(
      eq(schema.stockLedger.voucherType, voucherType),
      eq(schema.stockLedger.voucherId, voucherId),
      eq(schema.stockLedger.productId, productId),
      isNotNull(schema.stockLedger.unitCost),
    ))
    .orderBy(asc(ROWID))
    .limit(1)
  return row?.unitCost ?? null
}

export interface StockRequirement {
  productId: string
  productName: string
  required: Qty
}

export interface StockShortfall {
  productId: string
  productName: string
  required: Qty
  available: Qty
}

/**
 * Checks every line before anything is written. Integer quantities make this exact —
 * the float version of this comparison rejected sales of fractional-kg items the
 * shop actually had.
 */
export async function checkAvailability(
  db: SqlDriver,
  requirements: StockRequirement[],
): Promise<StockShortfall[]> {
  const shortfalls: StockShortfall[] = []

  for (const req of requirements) {
    const [tracked] = await q(db)
      .select({ isStockTracked: schema.products.isStockTracked })
      .from(schema.products)
      .where(eq(schema.products.id, req.productId))
    if (!tracked || tracked.isStockTracked === 0) continue

    const available = await currentStock(db, req.productId)
    if (!hasAtLeast(available, req.required)) {
      shortfalls.push({ productId: req.productId, productName: req.productName, required: req.required, available })
    }
  }

  return shortfalls
}

export interface StockDrift {
  productId: string
  cached: Qty
  actual: Qty
  cachedValue: Money
  actualValue: Money
}

export interface RecomputeOptions {
  /** Write the replayed figure back over the cache, rather than only reporting. */
  repair?: boolean
  /**
   * Replay only these products. Omitted means every product in the shop.
   *
   * An empty array is "nothing to replay" and returns at once — it is what a
   * caller naturally passes when nothing was touched, and treating it as "all"
   * would be a trap.
   */
  productIds?: readonly string[]
}

/**
 * How many product ids to put in one `IN (...)`.
 *
 * SQLite's parameter ceiling is 32,766 on anything current, so this is not
 * about the limit; it is about the query plan. A very long `IN` list stops
 * being a series of index seeks, and a merge that touched four hundred products
 * is better served by three queries than by one enormous one.
 */
const CHUNK = 200

/**
 * Checks the stock cache against the ledger, and optionally repairs it.
 *
 * ## Scoped, since Phase 3
 *
 * This replays the ledger, and the ledger is the longest table in the shop. On
 * a year of trade — 47,000 movements — a full replay is about 160 ms, and it
 * was being run on every Dashboard mount and after every sync round that
 * carried a single stock row. Both of those are the wrong shape: opening a
 * screen should not cost a linear pass over the shop's history, and a merge
 * that moved one product should not re-derive four hundred.
 *
 * With `productIds` it replays only those, which is the same arithmetic on a
 * hundredth of the rows. Without them it replays everything, which is still
 * exactly what a periodic drift check wants — the unbounded version is the one
 * that finds a product nobody has touched, and it stays on the weekly job.
 */
export async function recomputeStock(db: SqlDriver, opts: RecomputeOptions = {}): Promise<StockDrift[]> {
  const scope = opts.productIds
  if (scope && scope.length === 0) return []

  const drift: StockDrift[] = []
  const now = new Date().toISOString()

  for (const ids of scope ? chunked(scope, CHUNK) : [null]) {
    drift.push(...await replay(db, ids, opts.repair === true, now))
  }

  return drift
}

/** One pass: `ids` null means the whole shop. */
async function replay(
  db: SqlDriver,
  ids: readonly string[] | null,
  repair: boolean,
  now: string,
): Promise<StockDrift[]> {
  /* Replayed rather than summed.

     The cache used to be checked against SUM(qty_change * unit_cost), which is
     only the same answer while stock never goes below zero. Once a shop can
     sell against a wrong count, the running value floors at zero and a later
     delivery rebases it, and neither of those survives being added up — the
     check would report drift on every overdrawn item for ever. So the ledger is
     replayed through the one function that defines the rule.

     `ORDER BY product_id, rowid` and not by `posting_date`: the rule depends on
     the order the movements were *made*, because that is the order the cache
     was built in. A backdated stock entry belongs where it was entered, not
     where its date would put it, and sorting by date would make this function
     disagree with `postMovement` about a shop that has ever backdated one. */
  const ledger = await q(db)
    .select({
      productId: schema.stockLedger.productId,
      qtyChange: schema.stockLedger.qtyChange,
      unitCost: schema.stockLedger.unitCost,
    })
    .from(schema.stockLedger)
    .where(ids ? inArray(schema.stockLedger.productId, [...ids]) : undefined)
    .orderBy(asc(schema.stockLedger.productId), asc(ROWID))

  const byProduct = new Map<string, LedgerMovement[]>()
  for (const row of ledger) {
    const movements = byProduct.get(row.productId) ?? []
    movements.push({ qtyChange: row.qtyChange, unitCost: row.unitCost })
    byProduct.set(row.productId, movements)
  }

  /* Driven from `products` rather than from the ledger, so a product whose
     cache says something and whose ledger says nothing is still caught. That is
     the drift worth finding: a row written by something outside this module. */
  const cache = await q(db)
    .select({
      productId: schema.products.id,
      cached: schema.productStock.qtyOnHand,
      cachedValue: schema.productStock.stockValue,
    })
    .from(schema.products)
    .leftJoin(schema.productStock, eq(schema.productStock.productId, schema.products.id))
    .where(ids ? inArray(schema.products.id, [...ids]) : undefined)

  const drift: StockDrift[] = []

  for (const row of cache) {
    const truth = movingAverage(byProduct.get(row.productId) ?? [])
    const cached = row.cached ?? QTY_ZERO
    const cachedValue = row.cachedValue ?? 0
    if (cached === truth.qtyOnHand && cachedValue === truth.totalValue) continue

    drift.push({
      productId: row.productId,
      cached,
      actual: truth.qtyOnHand,
      cachedValue: cachedValue as Money,
      actualValue: truth.totalValue,
    })

    if (repair) await cacheStock(db, row.productId, truth.qtyOnHand, truth.totalValue, now)
  }

  return drift
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function reverseVoucher(
  tx: SqlDriver,
  voucherType: string,
  voucherId: string,
  postingDate: string,
  userId?: string | null,
): Promise<void> {
  const movements = await q(tx)
    .select({
      productId: schema.stockLedger.productId,
      qtyChange: schema.stockLedger.qtyChange,
      unitCost: schema.stockLedger.unitCost,
    })
    .from(schema.stockLedger)
    .where(and(
      eq(schema.stockLedger.voucherType, voucherType),
      eq(schema.stockLedger.voucherId, voucherId),
      ne(schema.stockLedger.qtyChange, QTY_ZERO),
    ))
    .orderBy(asc(ROWID))

  for (const m of movements) {
    await postMovement(tx, {
      productId: m.productId,
      qtyChange: qty(-m.qtyChange),
      unitCost: m.unitCost,
      voucherType: `${voucherType}_reversal`,
      voucherId,
      postingDate,
      userId: userId ?? null,
    })
  }
}

/** Replays a product's ledger so valuation reflects what was actually paid. */
export async function productValuation(db: SqlDriver, productId: string): Promise<Valuation>
export async function productValuation(db: SqlDriver, productId: string, method: 'moving_average'): Promise<Valuation>
export async function productValuation(db: SqlDriver, productId: string, method: 'fifo'): Promise<FifoResult>
export async function productValuation(
  db: SqlDriver,
  productId: string,
  method: 'moving_average' | 'fifo' = 'moving_average',
): Promise<Valuation | FifoResult> {
  const movements = await q(db)
    .select({
      qtyChange: schema.stockLedger.qtyChange,
      unitCost: schema.stockLedger.unitCost,
    })
    .from(schema.stockLedger)
    .where(eq(schema.stockLedger.productId, productId))
    .orderBy(asc(schema.stockLedger.postingDate), asc(ROWID))

  return method === 'fifo' ? fifo(movements) : movingAverage(movements)
}
