import { useEffect, useState } from 'react'
import { Batches, Quantity, businessDate, planSale, type SalePlan } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'

/**
 * Which batch a line of the bill will come out of, under the item's name.
 *
 * Asks `planSale`, which is the same rule `submitBill` applies, so what is
 * shown here is what the bill will record. The cashier can pick another batch
 * -- the pack in the customer's hand is the one that left -- and the choice is
 * passed to `submitBill` as the line's pick.
 *
 * Renders nothing for an item that has never had a batch.
 */
export function LineBatch({ productId, baseQty, pick, onPick }: {
  productId: string
  /** Base units, scaled. */
  baseQty: Quantity.Qty
  pick: string | null
  onPick: (batchId: string | null) => void
}) {
  const { db } = useCore()
  const [plan, setPlan] = useState<SalePlan | null>(null)
  const today = businessDate()

  useEffect(() => {
    let live = true
    void planSale(db, productId, baseQty, { today, pick }).then((p) => { if (live) setPlan(p) })
    return () => { live = false }
  }, [db, productId, baseQty, pick, today])

  if (!plan || plan.pool.length === 0) return null
  const inStock = plan.pool.filter((b) => b.balance > 0)
  const names = new Map(plan.pool.map((b) => [b.batchId, b]))

  const said = plan.takes.map((t) => {
    const b = names.get(t.batchId)!
    const exp = b.expiryDate ? ` exp ${Batches.formatExpiry(b.expiryDate)}` : ''
    return `${b.batchNo}${plan.takes.length > 1 ? ` ×${Quantity.formatQty(t.qty)}` : ''}${exp}`
  }).join(', ')

  return (
    <div className="src" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span>Batch</span>
      {inStock.length > 1 ? (
        <select
          className="select unit-select"
          aria-label="Batch"
          value={pick ?? ''}
          onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Soonest expiry</option>
          {inStock.map((b) => (
            <option key={b.batchId} value={b.batchId}>
              {b.batchNo}{b.expiryDate ? ` · ${Batches.formatExpiry(b.expiryDate)}` : ''} · {Quantity.formatQty(b.balance)} left
            </option>
          ))}
        </select>
      ) : null}
      <span>{said || 'none left — from stock without a batch'}</span>
      {plan.expired && <span className="warn-note">past its expiry date</span>}
    </div>
  )
}
