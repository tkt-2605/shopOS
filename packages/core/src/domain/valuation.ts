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
}

export function movingAverage(movements: LedgerMovement[]): Valuation {
  let onHand = 0
  let value = 0

  for (const m of movements) {
    if (m.qtyChange > 0) {
      value += Math.round((m.qtyChange * (m.unitCost ?? 0)) / QTY_SCALE)
      onHand += m.qtyChange
    } else {
      const rate = onHand > 0 ? value / onHand : 0
      const out = Math.min(-m.qtyChange, onHand)
      value -= Math.round(rate * out)
      onHand -= out
    }
    if (onHand <= 0) {
      onHand = Math.max(0, onHand)
      if (onHand === 0) value = 0
    }
  }

  return {
    qtyOnHand: qty(onHand),
    totalValue: paise(Math.max(0, value)),
    averageCost: onHand > 0 ? paise(Math.round((value * QTY_SCALE) / onHand)) : ZERO,
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

  return {
    qtyOnHand: qty(onHand),
    totalValue: paise(value),
    averageCost: onHand > 0 ? paise(Math.round((value * QTY_SCALE) / onHand)) : ZERO,
    consumedCost: paise(consumed),
  }
}
