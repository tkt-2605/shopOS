import { useEffect, useState } from 'react'
import { costHints, type CostHint, type SqlDriver } from '@shopos/core'

/**
 * The latest cost of each item in the list: the last price paid, or the cost
 * price typed on the item when that is newer (`repos/costs.ts`) -- the figure
 * the item form, Stock In and a purchase order start from, and the one nothing
 * may sell below. Read again whenever the list is, so a delivery just posted
 * shows here without leaving the page.
 */
export function useCostHints(db: SqlDriver, rows: readonly { id: string }[]): ReadonlyMap<string, CostHint> {
  const [hints, setHints] = useState<ReadonlyMap<string, CostHint>>(new Map())
  useEffect(() => {
    let live = true
    void costHints(db, rows.map((r) => r.id)).then((h) => { if (live) setHints(h) })
    return () => { live = false }
  }, [db, rows])
  return hints
}
