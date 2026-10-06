import { useEffect } from 'react'
import type { SqlDriver } from '@shopos/core'
import { linesToReprice, pricedForOf, repriceCart, type Cart } from './billCarts'

/**
 * The rate follows the line. A line's unit, its quantity and the bill's
 * customer each decide which price applies -- a box of fifty reaches the
 * fifty-or-more rung -- so when any of them changes, the line is priced again,
 * the same way the service would. See `repriceCart`.
 *
 * Returns whether a line is still waiting for its rate, which the counter
 * does not take payment through.
 */
export function useRepricing(db: SqlDriver, active: Cart, patch: (change: (cart: Cart) => Cart) => void): boolean {
  const repricing = linesToReprice(active).length > 0

  useEffect(() => {
    if (active.hydrating || !repricing) return
    let cancelled = false
    repriceCart(db, active)
      .then((change) => { if (!cancelled) patch(change) })
      .catch((err: unknown) => {
        if (cancelled) return
        /* Marked as priced, so a failure is said once rather than retried on
           every render; the cashier can type the rate. */
        const customer = active.customer?.id ?? null
        patch((cart) => (cart.tabId !== active.tabId ? cart : {
          ...cart,
          error: `A price could not be worked out: ${err instanceof Error ? err.message : String(err)}`,
          lines: cart.lines.map((l) => ({ ...l, pricedFor: pricedForOf(l, customer) })),
        }))
      })
    return () => { cancelled = true }
  }, [db, active, repricing, patch])

  return repricing
}
