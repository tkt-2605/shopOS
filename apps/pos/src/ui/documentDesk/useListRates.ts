import { useEffect, useState } from 'react'
import {
  Quantity, pricingContextFor, resolveSaleUnit, resolveLinePrice, type Money, type SqlDriver,
} from '@shopos/core'
import type { Line } from './types'

/*
 * The rate a blank box on a quotation or order will be filled with when it is
 * saved, worked out the way the service will work it out: this customer's
 * list, their own price, a quantity break, or the shelf. Shown in the box,
 * pale, so "list price" is a figure and not a riddle.
 *
 * A guess at a moment, as the box's text: the service decides again on save.
 */
export function useListRates(
  db: SqlDriver, lines: Line[], customerId: string | null, enabled: boolean,
): Map<string, Money.Money> {
  const [rates, setRates] = useState<Map<string, Money.Money>>(new Map())
  // What the answer depends on, so typing a rate does not ask again.
  const asked = lines.map((l) => `${l.key}|${l.product.id}|${l.saleUnit ?? ''}|${l.qty}`).join(',')

  useEffect(() => {
    if (!enabled || lines.length === 0) { setRates(new Map()); return }
    let live = true
    const id = setTimeout(() => {
      void (async () => {
        const pricing = await pricingContextFor(db, customerId)
        const found = new Map<string, Money.Money>()
        for (const l of lines) {
          const qty = Quantity.parseQty(l.qty.trim() === '' ? '1' : l.qty)
          if (qty === null || qty <= 0) continue
          const unit = await resolveSaleUnit(db, l.product.id, l.saleUnit ?? null)
          const price = await resolveLinePrice(db, pricing, { productId: l.product.id, saleUnit: unit.saleUnit, qty })
          found.set(l.key, price.rate)
        }
        if (live) setRates(found)
      })()
    }, 150)
    return () => { live = false; clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `asked` stands for the lines
  }, [db, asked, customerId, enabled])

  return rates
}
