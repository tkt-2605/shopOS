import { useCallback, useEffect, useState } from 'react'
import {
  reorderList, bySupplier, Quantity, Money, businessDate, Reports as R,
  type ReorderRow, type SupplierGroup,
} from '@shopos/core'
import { useDb } from '../core/CoreProvider'
import { Card, Empty, Alert, Rupees } from '../ui/components'
import { saveFile } from '../core/exportFile'

/**
 * What to buy.
 *
 * Grouped by distributor, because that is how an order is actually placed: the
 * shop rings Sakthi Agencies once and reads down a list, rather than working
 * through products alphabetically and ringing four people twice.
 *
 * Every row carries what it has been selling and what it last cost, so the
 * decision can be made here rather than by going back to the reports.
 */

export default function Reorder() {
  const db = useDb()
  const [groups, setGroups] = useState<SupplierGroup[]>([])
  const [includeOutOfStock, setIncludeOutOfStock] = useState(true)
  const [windowDays, setWindowDays] = useState(30)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const rows = await reorderList(db, { includeOutOfStock, windowDays })
    setGroups(bySupplier(rows))
    setLoading(false)
  }, [db, includeOutOfStock, windowDays])

  useEffect(() => { void refresh() }, [refresh])

  const total = groups.reduce((n, g) => n + g.rows.length, 0)

  async function exportCsv() {
    const rows = groups.flatMap((g) =>
      g.rows.map((r) => [
        g.supplierName ?? 'Not bought before',
        r.name,
        r.code ?? '',
        Quantity.formatQty(r.onHand),
        Quantity.formatQty(r.reorderLevel),
        Quantity.formatQty(r.suggestedQty),
        r.baseUnit,
        Quantity.formatQty(r.soldRecently),
        r.daysOfCover === null ? '' : String(r.daysOfCover),
        r.lastPurchaseRate === null ? '' : Money.format(r.lastPurchaseRate),
        r.lastPurchasedOn ?? '',
      ]),
    )
    const csv = R.toCsv(
      ['Supplier', 'Item', 'Code', 'On hand', 'Reorder at', 'Order', 'Unit',
       `Sold in ${windowDays} days`, 'Days left', 'Last rate', 'Last bought'],
      rows,
    )
    const name = `buying-list-${businessDate()}.csv`
    const saved = await saveFile(name, csv)
    setNotice(saved.ok ? `Saved to ${saved.path}` : saved.message)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1040 }}>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <Card
        title={loading ? 'Working out what to buy…' : total === 0 ? 'Nothing to buy' : `${total} to buy`}
        actions={
          total > 0 ? <button className="btn sm" onClick={() => void exportCsv()}>Export</button> : undefined
        }
      >
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={includeOutOfStock}
              onChange={(e) => setIncludeOutOfStock(e.target.checked)} />
            Include anything out of stock
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Judge sales over
            <select className="input" style={{ width: 110 }} value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}>
              <option value={7}>a week</option>
              <option value={30}>a month</option>
              <option value={90}>three months</option>
            </select>
          </label>
        </div>

        {!loading && total === 0 && (
          <div style={{ marginTop: 13 }}>
            <Empty>
              Nothing has fallen to its reorder level. Set one on an item in Inventory and it will
              appear here when it runs low.
            </Empty>
          </div>
        )}
      </Card>

      {groups.map((group) => (
        <Card
          key={group.supplierId ?? 'unknown'}
          title={group.supplierName ?? 'Not bought from anyone yet'}
        >
          {group.supplierId === null && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 9 }}>
              These have never been received against a supplier, so there is nobody to ring.
              Recording the supplier on the next stock entry puts them in a group of their own.
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">On hand</th>
                <th className="r">Reorder at</th>
                <th className="r">Order</th>
                <th className="r">Sold</th>
                <th className="r">Days left</th>
                <th className="r">Last rate</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => <Row key={row.productId} row={row} />)}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  )
}

function Row({ row }: { row: ReorderRow }) {
  const out = row.onHand <= 0
  return (
    <tr>
      <td>
        {row.name}
        {row.code && <div className="src">{row.code}</div>}
      </td>
      <td className="r num">
        {out
          ? <span className="badge bad">out</span>
          : `${Quantity.formatQty(row.onHand)} ${row.baseUnit}`}
      </td>
      <td className="r num" style={{ color: 'var(--ink-3)' }}>
        {row.reorderLevel > 0 ? Quantity.formatQty(row.reorderLevel) : '—'}
      </td>
      <td className="r num" style={{ fontWeight: 600 }}>
        {Quantity.formatQty(row.suggestedQty)} {row.baseUnit}
      </td>
      <td className="r num">{Quantity.formatQty(row.soldRecently)}</td>
      <td className="r num">
        {row.daysOfCover === null
          ? <span style={{ color: 'var(--ink-3)' }}>—</span>
          : row.daysOfCover <= 7
            ? <span className="badge warn">{row.daysOfCover}d</span>
            : `${row.daysOfCover}d`}
      </td>
      <td className="r">
        {row.lastPurchaseRate === null
          ? <span style={{ color: 'var(--ink-3)' }}>—</span>
          : <>
              <Rupees value={row.lastPurchaseRate} />
              <div className="src">{row.lastPurchasedOn}</div>
            </>}
      </td>
    </tr>
  )
}
