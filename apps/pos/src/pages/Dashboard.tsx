import { useEffect, useState } from 'react'
import {
  Money, Quantity, Reports, businessDate, addDays, totalOutstandingAll, lowStock, type SqlDriver,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { lastStockCheck, type StockCheck } from '../core/maintenance'
import { Stat, Card, Empty, Alert, Rupees } from '../ui/components'
import { useShopChanged } from '../core/useShopChanged'
import { Completeness } from '../ui/Completeness'
import { SetupChecklist } from '../ui/SetupChecklist'

interface Snapshot {
  todaySales: number
  todayBills: number
  outstanding: number
  lowStock: { name: string; qty: number; unit: string }[]
  /** What the last full ledger replay found, or null if one has never run. */
  stock: StockCheck | null
}

export default function Dashboard() {
  const { db } = useCore()
  const [snap, setSnap] = useState<Snapshot | null>(null)

  useEffect(() => { void load(db).then(setSnap) }, [db])
  // The one screen whose whole point is today's numbers.
  useShopChanged(() => { void load(db).then(setSnap) })

  if (!snap) return <Empty>Loading…</Empty>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Above the numbers rather than under them: a qualification read after
          the figure has already been believed is not a qualification. */}
      <SetupChecklist />
      <Completeness />
      <div className="stat-row">
        <Stat label="Sales today" value={<Rupees value={snap.todaySales} />} sub={`${snap.todayBills} bills`} />
        <Stat label="Outstanding credit" value={<Rupees value={snap.outstanding} />} sub="across all customers" />
        <Stat label="Low stock" value={snap.lowStock.length} sub="items under 10 units" />
      </div>

      {snap.stock && snap.stock.drift > 0 && (
        <Alert>
          {snap.stock.drift} product(s) show a difference between the stock ledger and the cached
          quantity, as of {whenChecked(snap.stock.at)}. Run a stock recompute from Inventory.
        </Alert>
      )}

      <Card title="Running low">
        {snap.lowStock.length === 0 ? (
          <Empty>Nothing is running low</Empty>
        ) : (
          <table>
            <thead><tr><th>Item</th><th className="r">On hand</th></tr></thead>
            <tbody>
              {snap.lowStock.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="r num">{Quantity.formatQty(p.qty as never)} {p.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

async function load(db: SqlDriver): Promise<Snapshot> {
  const today = businessDate()

  const sales = await Reports.daySales(db, today)

  /* The same figure the Credit page shows, from the same function.
   *
   * It used to be its own query here, netting every payment ever taken off
   * every credit ever given across the whole shop — which is a different number
   * from the one on the Credit page, because that one adds up the customers who
   * owe and leaves out the ones in credit. Two screens, one label, two answers,
   * and no way for a shopkeeper to tell which was the real one. */
  const credit = await totalOutstandingAll(db)

  const low = await lowStock(db, { below: Quantity.fromUnits(10), limit: 12 })

  return {
    todaySales: sales.total,
    todayBills: sales.bills,
    outstanding: credit.total,
    lowStock: low,
    /* Read, not computed.
     *
     * This line used to be `(await recomputeStock(db)).length` — a replay of
     * the entire stock ledger, every time anybody opened the home screen, to
     * decide whether to show one line of warning. On a year of trade that is
     * about 160 ms before the page can paint, and it grows with every sale the
     * shop has ever made. The replay now runs on the 02:00 timer once a week
     * and this reads what it found. */
    stock: lastStockCheck(),
  }
}

/** "today", "yesterday", or the date — enough to place it, no more. */
function whenChecked(at: string): string {
  // `at` is a UTC timestamp; the day it names is the shop's, not Greenwich's.
  const day = businessDate(new Date(at))
  const today = businessDate()
  if (day === today) return 'today'
  return day === addDays(today, -1) ? 'yesterday' : day
}

export { Money }
