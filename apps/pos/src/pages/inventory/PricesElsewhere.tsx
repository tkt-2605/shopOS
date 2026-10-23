import { useEffect, useState } from 'react'
import { Money, Quantity, pricesElsewhere, type PriceElsewhere } from '@shopos/core'
import { useCore } from '../../core/CoreProvider'

/**
 * Where else this item has a price, under its selling rate.
 *
 * Read-only: price lists and customers' own prices are set on Special Prices.
 * The item only says they exist, so somebody changing the selling rate is not
 * surprised when the school still pays what it was promised.
 */
export function PricesElsewhere({ productId }: { productId: string }) {
  const { db } = useCore()
  const [found, setFound] = useState<PriceElsewhere[]>([])
  useEffect(() => {
    let live = true
    // A line of reference only: a read that fails, or lands after the form closed, shows nothing.
    pricesElsewhere(db, productId).then((rows) => { if (live) setFound(rows) }, () => undefined)
    return () => { live = false }
  }, [db, productId])
  if (found.length === 0) return null

  /* One phrase per list or customer, its rungs together: "Wholesale ₹8.50, 10+ ₹8". */
  const byWho = new Map<string, PriceElsewhere[]>()
  for (const p of found) byWho.set(`${p.kind}:${p.who}`, [...(byWho.get(`${p.kind}:${p.who}`) ?? []), p])
  const phrases = [...byWho.values()].map((rungs) => `${rungs[0]!.who} ${rungs.map((r) => {
    const from = r.minQty > Quantity.QTY_SCALE ? `${Quantity.formatQty(r.minQty as Quantity.Qty)}+ ` : ''
    return `${from}₹${Money.format(r.rate as Money.Money)}${r.saleUnit && rungs.some((x) => x.saleUnit !== r.saleUnit) ? `/${r.saleUnit}` : ''}`
  }).join(', ')}`)

  return (
    <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-3)' }}>
      Also priced: {phrases.join(' · ')}. Change these on Special Prices.
    </div>
  )
}
