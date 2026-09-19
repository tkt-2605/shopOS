import { useCallback, useEffect, useState } from 'react'
import {
  Quantity,
  supplierItems, supplierPurchases,
  type SupplierItem, type PurchaseLine,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Modal, Empty, Rupees } from './components'
import { Completeness } from './Completeness'

/**
 * What a supplier sends, and what they have been charging for it.
 *
 * The deliveries list answers "what arrived on Tuesday". This answers the
 * question a shopkeeper actually negotiates on — what do I buy from them, how
 * much of it, and has the price moved — which a list ordered by date cannot,
 * because the two deliveries worth comparing are six weeks and forty rows
 * apart.
 *
 * First and last rate, rather than a computed trend. Two numbers a person can
 * check against their own paperwork beat one they have to take on trust, and
 * whether 285 to 300 is a rise worth arguing about is a judgement about this
 * supplier that the shopkeeper is better placed to make than a query is.
 */

interface Loaded {
  items: SupplierItem[]
  lines: PurchaseLine[]
}

export function SupplierWorth({
  supplierId, name, onClose,
}: {
  supplierId: string
  name: string
  onClose: () => void
}) {
  const { db } = useCore()
  const [data, setData] = useState<Loaded | null>(null)

  const load = useCallback(async () => {
    const [items, lines] = await Promise.all([
      supplierItems(db, supplierId),
      supplierPurchases(db, supplierId),
    ])
    setData({ items, lines })
  }, [db, supplierId])

  useEffect(() => { void load() }, [load])

  const spent = data?.items.reduce((a, i) => a + i.spent, 0) ?? 0

  return (
    <Modal
      title={name}
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {data === null ? <Empty>Reading the deliveries…</Empty> : (
        <>
          <Completeness />

          <div className="total-line grand">
            <span>Bought from them, all time</span>
            <Rupees value={spent} className="amount" />
          </div>

          <h3>What they send</h3>
          <table>
            <thead>
              <tr>
                <th>Item</th><th className="r">Deliveries</th><th className="r">Quantity</th>
                <th className="r">Spent</th>
                <th className="r">First rate</th><th className="r">Last rate</th>
                <th>Last received</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.productId}>
                  <td>{i.name}</td>
                  <td className="r num">{i.deliveries}</td>
                  <td className="r num">{Quantity.formatQty(i.qty as never)}</td>
                  <td className="r"><Rupees value={i.spent} /></td>
                  <td className="r">{rate(i.firstRate)}</td>
                  <td className="r">
                    {rate(i.lastRate)}
                    {/* Said only when both ends are known and they differ. A
                        supplier who has sent something once has no trend, and
                        an arrow drawn from one number is an invention. */}
                    {i.firstRate !== null && i.lastRate !== null && i.lastRate !== i.firstRate && (
                      <div className="src">
                        {i.lastRate > i.firstRate ? '↑ ' : '↓ '}
                        {Math.abs(Math.round(((i.lastRate - i.firstRate) / i.firstRate) * 1000) / 10)}%
                      </div>
                    )}
                  </td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{i.lastReceived}</td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr><td colSpan={7}><Empty>Nothing has been received from this supplier</Empty></td></tr>
              )}
            </tbody>
          </table>

          <h3>Every delivery</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Entry</th><th>Item</th>
                <th className="r">Quantity</th><th className="r">Rate</th><th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={`${l.docNo}-${i}`}>
                  <td className="num">{l.postingDate}</td>
                  <td className="num">{l.docNo}</td>
                  <td>{l.productName}</td>
                  <td className="r num">{Quantity.formatQty(l.qty as never)}</td>
                  <td className="r">{rate(l.unitCost)}</td>
                  <td className="r"><Rupees value={l.amount} /></td>
                </tr>
              ))}
              {data.lines.length === 0 && (
                <tr><td colSpan={6}><Empty>Nothing yet</Empty></td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  )
}

/**
 * A rate, or a word saying there is none.
 *
 * Zero is what an unrecorded cost is stored as on a stock entry line, and
 * printing ₹0.00 claims the goods were free. The distinction matters here more
 * than on most screens, because this is the page somebody checks a supplier's
 * prices against.
 */
function rate(value: number | null): React.ReactNode {
  if (value === null || value === 0) return <span className="src">none</span>
  return <Rupees value={value} />
}
