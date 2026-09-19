import { useCallback, useEffect, useState } from 'react'
import {
  Quantity, businessDate,
  customerProfit, customerItems, customerAccount,
  type CustomerProfit, type CustomerItem, type CustomerAccount,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Modal, Empty, Rupees } from './components'
import { Completeness } from './Completeness'

/**
 * What one customer is worth, rather than only what they owe.
 *
 * The Credit screen has always answered the second question. The first had no
 * answer anywhere, and it is the one a discount gets argued over: somebody
 * buying fifty thousand rupees of goods at four points is a different customer
 * from one buying twenty at thirty, and until now they looked identical on
 * every screen the shop had.
 *
 * Nothing here estimates anything. Every sale stamped its own cost into the
 * ledger as it left, so the margin is what actually happened.
 */

const ALL_TIME = { from: '0000-01-01', to: '9999-12-31' }

function monthToDate(): { from: string; to: string } {
  const today = businessDate()
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

interface Loaded {
  month: CustomerProfit
  ever: CustomerProfit
  items: CustomerItem[]
  account: CustomerAccount
}

export function CustomerWorth({
  customerId, name, code, onClose,
}: {
  customerId: string
  name: string
  code: string | null
  onClose: () => void
}) {
  const { db } = useCore()
  const [data, setData] = useState<Loaded | null>(null)

  const load = useCallback(async () => {
    const [month, ever, items, account] = await Promise.all([
      customerProfit(db, customerId, monthToDate()),
      customerProfit(db, customerId, ALL_TIME),
      customerItems(db, customerId, ALL_TIME),
      customerAccount(db, customerId),
    ])
    setData({ month, ever, items, account })
  }, [db, customerId])

  useEffect(() => { void load() }, [load])

  return (
    <Modal
      title={code ? `${name} — ${code}` : name}
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {data === null ? <Empty>Reading their history…</Empty> : (
        <>
          <Completeness />

          <div className="stat-row">
            <div>
              <h3>The account</h3>
              <div className="total-line">
                <span>Bought</span><Rupees value={data.account.totals.bought} />
              </div>
              <div className="total-line">
                <span>Paid</span><Rupees value={data.account.totals.paid} />
              </div>
              <div className="total-line">
                <span>Returned</span><Rupees value={data.account.totals.returned} />
              </div>
              <div className="total-line grand">
                <span>{data.account.closingBalance < 0 ? 'In advance' : 'Owing'}</span>
                <Rupees value={Math.abs(data.account.closingBalance)} className="amount" />
              </div>
            </div>

            <div>
              <h3>What the shop makes on them</h3>
              <table>
                <thead>
                  <tr><th /><th className="r">This month</th><th className="r">All time</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Bills</td>
                    <td className="r num">{data.month.bills}</td>
                    <td className="r num">{data.ever.bills}</td>
                  </tr>
                  <tr>
                    <td>Revenue</td>
                    <td className="r"><Rupees value={data.month.revenue} /></td>
                    <td className="r"><Rupees value={data.ever.revenue} /></td>
                  </tr>
                  <tr>
                    <td>Cost of goods</td>
                    <td className="r"><Rupees value={data.month.cost} /></td>
                    <td className="r"><Rupees value={data.ever.cost} /></td>
                  </tr>
                  <tr className="grand">
                    <td>Profit</td>
                    <td className="r"><Rupees value={data.month.margin} /></td>
                    <td className="r"><Rupees value={data.ever.margin} /></td>
                  </tr>
                  <tr>
                    <td>Margin</td>
                    <td className="r num">{pct(data.month)}</td>
                    <td className="r num">{pct(data.ever)}</td>
                  </tr>
                </tbody>
              </table>
              {data.ever.uncostedLines > 0 && (
                <div className="src warn-note">
                  {data.ever.uncostedLines === 1
                    ? 'One sale to this customer left the shelf with no cost recorded, so'
                    : `${data.ever.uncostedLines} sales to this customer left the shelf with no cost recorded, so`}
                  {' '}the profit above is higher than the truth.
                </div>
              )}
            </div>
          </div>

          {/* By margin rather than by spend, because the two disagree often
              enough to be worth the choice: the line a customer spends most on
              is frequently the one the shop competes hardest on. */}
          <h3>What they buy, by what it earns</h3>
          <table>
            <thead>
              <tr>
                <th>Item</th><th className="r">Quantity</th>
                <th className="r">Revenue</th><th className="r">Cost</th>
                <th className="r">Profit</th><th className="r">Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.productId}>
                  <td>{i.name}</td>
                  <td className="r num">{Quantity.formatQty(i.qty)} {i.unit}</td>
                  <td className="r"><Rupees value={i.revenue} /></td>
                  <td className="r"><Rupees value={i.cost} /></td>
                  <td className="r"><Rupees value={i.margin} /></td>
                  <td className="r num">{i.revenue === 0 ? '—' : `${(i.marginBp / 100).toFixed(1)}%`}</td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr><td colSpan={6}><Empty>They have not bought anything yet</Empty></td></tr>
              )}
            </tbody>
          </table>

          <h3>Their account, line by line</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Document</th><th>What</th>
                <th className="r">Charged</th><th className="r">Paid</th><th className="r">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.account.entries.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td className="num">{e.postingDate}</td>
                  <td className="num">{e.docNo}</td>
                  <td>{e.description}</td>
                  <td className="r">{e.debit === 0 ? '' : <Rupees value={e.debit} />}</td>
                  <td className="r">{e.credit === 0 ? '' : <Rupees value={e.credit} />}</td>
                  <td className="r"><Rupees value={e.balance} /></td>
                </tr>
              ))}
              {data.account.entries.length === 0 && (
                <tr><td colSpan={6}><Empty>Nothing on this account yet</Empty></td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  )
}

function pct(p: CustomerProfit): string {
  return p.revenue === 0 ? '—' : `${(p.marginBp / 100).toFixed(1)}%`
}
