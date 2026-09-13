import { type Money, ZERO, paise } from '../money.js'
import { type Qty, qty, QTY_SCALE } from '../quantity.js'

/**
 * Valuation is computable because every inbound movement carries the cost it came
 * in at. The old system kept a single mutable cost on the product, overwritten on
 * each receipt — which made COGS a function of today's price rather than what was
 * actually paid, and destroyed the history needed to fix it later.
 */

export interface LedgerMovement {
  qtyChange: Qty
  unitCost: Money | null
}

export interface Valuation {
  qtyOnHand: Qty
  totalValue: Money
  averageCost: Money
  /**
   * What one base unit last cost, kept for when the shelf is empty or overdrawn.
   * Without it a sale made against a wrong count has no cost at all, and every
   * margin report counts it as pure profit.
   */
  lastKnownCost: Money | null
}

/**
 * Moving average, including when the shelf is overdrawn.
 *
 * A shop can sell what its records say it does not have — the counts are wrong
 * on day one and a till that refuses the item in the customer's hand gets
 * abandoned. Once that is allowed, quantity on hand goes below zero, and three
 * things have to be decided rather than fallen into:
 *
 *   - **Nothing below zero is worth anything.** Value floors at zero when the
 *     quantity does, because the shop has not paid for goods it does not have.
 *   - **Goods still leave at a cost.** Issued from an empty or overdrawn shelf,
 *     the last rate known for the item is used. The alternative — no cost at all
 *     — silently reports the sale as pure profit, which is a worse lie than an
 *     old rate.
 *   - **A receipt that clears the hole rebases.** Five units arriving against a
 *     shortfall of three leaves two units, worth what those two cost — not what
 *     all five cost. Spreading the whole delivery over the survivors was the bug
 *     this replaces, and it inflated the average by the size of the shortfall.
 *
 * This is the single definition of the rule: the live posting path and the
 * rebuild-from-ledger path both answer to it, so the cache and the truth cannot
 * drift apart.
 */
export function movingAverage(movements: LedgerMovement[]): Valuation {
  let onHand = 0
  let value = 0
  let lastCost: number | null = null

  for (const m of movements) {
    if (m.unitCost !== null && m.unitCost !== undefined) lastCost = m.unitCost

    if (m.qtyChange > 0) {
      const rate = m.unitCost ?? lastCost ?? 0
      const wasShort = onHand < 0
      onHand += m.qtyChange
      value = wasShort
        // Whatever is left over after the hole is filled, at the rate it came in.
        ? (onHand > 0 ? Math.round((onHand * rate) / QTY_SCALE) : 0)
        : value + Math.round((m.qtyChange * rate) / QTY_SCALE)
      continue
    }

    // Only the part that was actually on the shelf carries value out with it.
    const covered = Math.max(0, Math.min(-m.qtyChange, onHand))
    if (covered > 0 && onHand > 0) value -= Math.round((value / onHand) * covered)
    onHand += m.qtyChange
    if (onHand <= 0) value = 0
  }

  return {
    qtyOnHand: qty(onHand),
    totalValue: paise(Math.max(0, value)),
    averageCost: onHand > 0 ? paise(Math.round((value * QTY_SCALE) / onHand)) : ZERO,
    lastKnownCost: lastCost === null ? null : paise(lastCost),
  }
}

interface Layer {
  qty: number
  unitCost: number
}

export interface FifoResult extends Valuation {
  consumedCost: Money
}

export function fifo(movements: LedgerMovement[]): FifoResult {
  const layers: Layer[] = []
  let consumed = 0

  for (const m of movements) {
    if (m.qtyChange > 0) {
      layers.push({ qty: m.qtyChange, unitCost: m.unitCost ?? 0 })
      continue
    }

    let remaining = -m.qtyChange
    while (remaining > 0 && layers.length > 0) {
      const layer = layers[0]!
      const take = Math.min(remaining, layer.qty)
      consumed += Math.round((take * layer.unitCost) / QTY_SCALE)
      layer.qty -= take
      remaining -= take
      if (layer.qty === 0) layers.shift()
    }
  }

  const onHand = layers.reduce((s, l) => s + l.qty, 0)
  const value = layers.reduce((s, l) => s + Math.round((l.qty * l.unitCost) / QTY_SCALE), 0)
  const lastCost = movements.reduce<number | null>(
    (last, m) => (m.unitCost === null || m.unitCost === undefined ? last : m.unitCost), null,
  )

  return {
    qtyOnHand: qty(onHand),
    totalValue: paise(value),
    averageCost: onHand > 0 ? paise(Math.round((value * QTY_SCALE) / onHand)) : ZERO,
    lastKnownCost: lastCost === null ? null : paise(lastCost),
    consumedCost: paise(consumed),
  }
}
