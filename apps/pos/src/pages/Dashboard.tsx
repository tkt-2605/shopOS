import { useEffect, useState } from 'react'
import { Money, Quantity, businessDate, recomputeStock, type SqlDriver } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Stat, Card, Empty, Alert, Rupees } from '../ui/components'

interface Snapshot {
  todaySales: number
  todayBills: number
  outstanding: number
  lowStock: { name: string; qty: number; unit: string }[]
  driftCount: number
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

      {snap.driftCount > 0 && (
        <Alert>
          {snap.driftCount} product(s) show a difference between the stock ledger and the cached
          quantity. Run a stock recompute from Inventory.
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

  const credit = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(b.credit_total), 0)
          - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                        JOIN payment_entries pe ON pe.id = pa.payment_id AND pe.docstatus = 1), 0) AS total
       FROM bills b WHERE b.docstatus = 1`,
  )

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
    outstanding: Math.max(0, credit?.total ?? 0),
    lowStock: low.map((r) => ({ name: r.name, qty: r.qty, unit: r.base_unit })),
    driftCount: (await recomputeStock(db)).length,
  }
}

export { Money }
