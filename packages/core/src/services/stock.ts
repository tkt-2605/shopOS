import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { type Qty, qty, addQty, hasAtLeast, QTY_SCALE } from '../quantity.js'
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
  const row = await db.get<{ qty_on_hand: number }>(
    `SELECT qty_on_hand FROM product_stock WHERE product_id = ?`,
    [productId],
  )
  return qty(row?.qty_on_hand ?? 0)
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

  await tx.execute(
    `INSERT INTO stock_ledger
       (id, product_id, posting_date, qty_change, unit_cost, balance_qty, voucher_type, voucher_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(), posting.productId, posting.postingDate, posting.qtyChange,
      unitCost, after, posting.voucherType, posting.voucherId,
      posting.userId ?? null, now,
    ],
  )

  await tx.execute(
    `INSERT INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (product_id) DO UPDATE SET
       qty_on_hand = excluded.qty_on_hand,
       stock_value = excluded.stock_value,
       updated_at = excluded.updated_at`,
    [posting.productId, after, afterValue, now],
  )

  return after
}

interface Holding {
  qty: Qty
  value: number
}

async function holding(tx: SqlDriver, productId: string): Promise<Holding> {
  const row = await tx.get<{ qty_on_hand: number; stock_value: number }>(
    `SELECT qty_on_hand, stock_value FROM product_stock WHERE product_id = ?`,
    [productId],
  )
  return { qty: qty(row?.qty_on_hand ?? 0), value: row?.stock_value ?? 0 }
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
  const row = await tx.get<{ unit_cost: number }>(
    `SELECT unit_cost FROM stock_ledger
      WHERE product_id = ? AND unit_cost IS NOT NULL
      ORDER BY (qty_change > 0) DESC, rowid DESC
      LIMIT 1`,
    [productId],
  )
  return (row?.unit_cost ?? null) as Money | null
}

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
  const row = await tx.get<{ unit_cost: number | null }>(
    `SELECT unit_cost FROM stock_ledger
      WHERE voucher_type = ? AND voucher_id = ? AND product_id = ? AND unit_cost IS NOT NULL
      ORDER BY rowid LIMIT 1`,
    [voucherType, voucherId, productId],
  )
  return (row?.unit_cost ?? null) as Money | null
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
    const tracked = await db.get<{ is_stock_tracked: number }>(
      `SELECT is_stock_tracked FROM products WHERE id = ?`,
      [req.productId],
    )
    if (!tracked || tracked.is_stock_tracked === 0) continue

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

export async function recomputeStock(db: SqlDriver, opts: { repair: boolean } = { repair: false }): Promise<StockDrift[]> {
  /* Replayed rather than summed.
     
     The cache used to be checked against SUM(qty_change * unit_cost), which is
     only the same answer while stock never goes below zero. Once a shop can
     sell against a wrong count, the running value floors at zero and a later
     delivery rebases it, and neither of those survives being added up — the
     check would report drift on every overdrawn item for ever. So the ledger is
     replayed through the one function that defines the rule. */
  const ledger = await db.query<{ product_id: string; qty_change: number; unit_cost: number | null }>(
    `SELECT product_id, qty_change, unit_cost FROM stock_ledger ORDER BY product_id, rowid`,
  )

  const byProduct = new Map<string, LedgerMovement[]>()
  for (const row of ledger) {
    const movements = byProduct.get(row.product_id) ?? []
    movements.push({ qtyChange: qty(row.qty_change), unitCost: (row.unit_cost ?? null) as Money | null })
    byProduct.set(row.product_id, movements)
  }

  const cache = await db.query<{ product_id: string; cached: number | null; cached_value: number | null }>(
    `SELECT p.id AS product_id, ps.qty_on_hand AS cached, ps.stock_value AS cached_value
       FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id`,
  )

  const drift: StockDrift[] = []
  const now = new Date().toISOString()

  for (const row of cache) {
    const truth = movingAverage(byProduct.get(row.product_id) ?? [])
    const cached = qty(row.cached ?? 0)
    const cachedValue = row.cached_value ?? 0
    if (cached === truth.qtyOnHand && cachedValue === truth.totalValue) continue

    drift.push({
      productId: row.product_id,
      cached,
      actual: truth.qtyOnHand,
      cachedValue: cachedValue as Money,
      actualValue: truth.totalValue,
    })

    if (opts.repair) {
      await db.execute(
        `INSERT INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (product_id) DO UPDATE SET
           qty_on_hand = excluded.qty_on_hand,
           stock_value = excluded.stock_value,
           updated_at = excluded.updated_at`,
        [row.product_id, truth.qtyOnHand, truth.totalValue, now],
      )
    }
  }

  return drift
}

export async function reverseVoucher(
  tx: SqlDriver,
  voucherType: string,
  voucherId: string,
  postingDate: string,
  userId?: string | null,
): Promise<void> {
  const movements = await tx.query<{ product_id: string; qty_change: number; unit_cost: number | null }>(
    `SELECT product_id, qty_change, unit_cost FROM stock_ledger
      WHERE voucher_type = ? AND voucher_id = ? AND qty_change <> 0
      ORDER BY rowid`,
    [voucherType, voucherId],
  )

  for (const m of movements) {
    await postMovement(tx, {
      productId: m.product_id,
      qtyChange: qty(-m.qty_change),
      unitCost: (m.unit_cost ?? null) as Money | null,
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
  const rows = await db.query<{ qty_change: number; unit_cost: number | null }>(
    `SELECT qty_change, unit_cost FROM stock_ledger WHERE product_id = ? ORDER BY posting_date, rowid`,
    [productId],
  )
  const movements = rows.map((r) => ({
    qtyChange: qty(r.qty_change),
    unitCost: (r.unit_cost ?? null) as Money | null,
  }))
  return method === 'fifo' ? fifo(movements) : movingAverage(movements)
}
