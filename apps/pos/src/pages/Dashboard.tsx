import { useEffect, useState } from 'react'
import { Money, Quantity, businessDate, totalOutstandingAll, type SqlDriver } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { lastStockCheck, type StockCheck } from '../core/maintenance'
import { Stat, Card, Empty, Alert, Rupees } from '../ui/components'

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

  if (!snap) return <Empty>Loading…</Empty>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

  const sales = await db.get<{ total: number; n: number }>(
    `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS n
       FROM bills WHERE docstatus = 1 AND posting_date = ?`,
    [today],
  )

  /* The same figure the Credit page shows, from the same function.
   *
   * It used to be its own query here, netting every payment ever taken off
   * every credit ever given across the whole shop — which is a different number
   * from the one on the Credit page, because that one adds up the customers who
   * owe and leaves out the ones in credit. Two screens, one label, two answers,
   * and no way for a shopkeeper to tell which was the real one. */
  const credit = await totalOutstandingAll(db)

  const low = await db.query<{ name: string; qty: number; base_unit: string }>(
    `SELECT p.name, COALESCE(ps.qty_on_hand, 0) AS qty, p.base_unit
       FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id
      WHERE p.is_active = 1 AND p.deleted_at IS NULL AND p.is_stock_tracked = 1
        AND COALESCE(ps.qty_on_hand, 0) < ?
      ORDER BY qty LIMIT 12`,
    [Quantity.fromUnits(10)],
  )

  return {
    todaySales: sales?.total ?? 0,
    todayBills: sales?.n ?? 0,
    outstanding: credit.total,
    lowStock: low.map((r) => ({ name: r.name, qty: r.qty, unit: r.base_unit })),
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
  const day = at.slice(0, 10)
  const today = businessDate()
  if (day === today) return 'today'
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  return day === yesterday ? 'yesterday' : day
}

export { Money }
