import type { SqlDriver } from '../db/driver.js'
import { newId } from '../ids.js'
import { type Qty, qty, addQty, hasAtLeast, QTY_SCALE } from '../quantity.js'
import type { Money } from '../money.js'
import { movingAverage, fifo, type Valuation, type FifoResult } from '../domain/valuation.js'

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
  // caller already knows (a reversal puts back exactly what it took out).
  const unitCost = posting.unitCost ?? (posting.qtyChange < 0 ? unitValueOf(held) : null)
  const valueChange = unitCost === null ? 0 : valueOf(unitCost, posting.qtyChange)
  const afterValue = after === 0 ? 0 : Math.max(0, held.value + valueChange)

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
  const rows = await db.query<{
    product_id: string; cached: number | null; actual: number
    cached_value: number | null; actual_value: number
  }>(
    `SELECT p.id AS product_id,
            ps.qty_on_hand AS cached,
            ps.stock_value AS cached_value,
            COALESCE((SELECT SUM(qty_change) FROM stock_ledger sl WHERE sl.product_id = p.id), 0) AS actual,
            COALESCE((SELECT SUM(CAST(ROUND(sl.qty_change * sl.unit_cost / ${QTY_SCALE}.0) AS INTEGER))
                        FROM stock_ledger sl
                       WHERE sl.product_id = p.id AND sl.unit_cost IS NOT NULL), 0) AS actual_value
       FROM products p
       LEFT JOIN product_stock ps ON ps.product_id = p.id`,
  )

  const drift: StockDrift[] = []
  const now = new Date().toISOString()

  for (const row of rows) {
    const cached = qty(row.cached ?? 0)
    const actual = qty(row.actual)
    const cachedValue = row.cached_value ?? 0
    const actualValue = actual === 0 ? 0 : Math.max(0, row.actual_value)
    if (cached === actual && cachedValue === actualValue) continue

    drift.push({
      productId: row.product_id,
      cached,
      actual,
      cachedValue: cachedValue as Money,
      actualValue: actualValue as Money,
    })

    if (opts.repair) {
      await db.execute(
        `INSERT INTO product_stock (product_id, qty_on_hand, stock_value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (product_id) DO UPDATE SET
           qty_on_hand = excluded.qty_on_hand,
           stock_value = excluded.stock_value,
           updated_at = excluded.updated_at`,
        [row.product_id, actual, actualValue, now],
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
