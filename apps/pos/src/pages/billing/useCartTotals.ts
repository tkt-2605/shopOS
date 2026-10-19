import { useEffect, useMemo, useState } from 'react'
import { Totals, chargesTax, costFloors, type Rounding, type SqlDriver, type TaxScheme } from '@shopos/core'
import { discountAmount, type Cart } from '../../core/billCarts'
import { totalsLinesOf, underCostOf } from './cart'

/**
 * What the bill on screen comes to, and which of its lines would sell below
 * cost as it stands.
 *
 * The shop's rounding rule is applied here as well as in the service. The
 * cashier is looking at this number while the customer hands over the money,
 * so it has to be the number the bill will carry -- not a near miss the
 * receipt then corrects. A percentage discount is of what may be discounted,
 * which the bill works out with no discount on it first (`discountAmount`).
 *
 * What each item cost is read when the set of items changes, not on every
 * keystroke, so a discount that takes a line below it is said while it is
 * being typed (`underCostOf`); `submitBill` is what refuses.
 */
export function useCartTotals(db: SqlDriver, cart: Cart, taxScheme: TaxScheme, rounding: Rounding) {
  const totals = useMemo(() => {
    const lines = totalsLinesOf(cart.lines, chargesTax(taxScheme))
    const discountable = Totals.computeTotals(lines, 0 as never).discountableSubtotal
    return Totals.computeTotals(lines, discountAmount(cart, discountable) as never, 'intra_state', rounding)
  }, [cart, rounding, taxScheme])

  const [floors, setFloors] = useState<ReadonlyMap<string, number>>(new Map())
  const items = [...new Set(cart.lines.map((l) => l.product.id))].sort().join(',')
  useEffect(() => {
    let live = true
    void costFloors(db, items === '' ? [] : items.split(',')).then((f) => { if (live) setFloors(f) })
    return () => { live = false }
  }, [db, items])

  const underCost = useMemo(
    () => underCostOf(cart.lines, totals.lines.map((t) => t.tax.taxableValue), floors),
    [cart.lines, totals, floors],
  )
  return { totals, underCost }
}
