import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Valuation, businessDate,
  productHistory, productProfit, productValuation,
  type StockMovement, type ProductProfit,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { Modal, Empty, Rupees } from './components'
import { Completeness } from './Completeness'

/**
 * One product's life, read out of the ledger.
 *
 * This is the screen `stock_ledger` has been waiting for since Phase 0. Every
 * movement has been recorded with what it cost at the time, and the only way to
 * see any of it was a Cost button that printed the current valuation as a single
 * number.
 *
 * A single number is the wrong shape for this one, because the average cost is
 * *derived* rather than stored — `domain/valuation.ts` argues why, and the
 * argument holds — and a derived figure a shopkeeper cannot take apart is one
 * they have to either trust or ignore. "Why does this say 272.73 when I have
 * always paid 300" has an answer, and it is in these rows: a receipt that came
 * in at 285 before the price went up, and a spell of negative stock that floored
 * the value at zero.
 */

/** From before any shop existed to after any will. Text dates, so this sorts. */
const ALL_TIME = { from: '0000-01-01', to: '9999-12-31' }

function monthToDate(): { from: string; to: string } {
  const today = businessDate()
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

interface Loaded {
  valuation: Valuation.Valuation
  month: ProductProfit
  ever: ProductProfit
  movements: StockMovement[]
}

export function ProductHistory({
  productId, name, baseUnit, onClose,
}: {
  productId: string
  name: string
  baseUnit: string
  onClose: () => void
}) {
  const { db } = useCore()
  const [data, setData] = useState<Loaded | null>(null)

  const load = useCallback(async () => {
    const [valuation, month, ever, movements] = await Promise.all([
      productValuation(db, productId),
      productProfit(db, productId, monthToDate()),
      productProfit(db, productId, ALL_TIME),
      productHistory(db, productId),
    ])
    setData({ valuation, month, ever, movements })
  }, [db, productId])

  useEffect(() => { void load() }, [load])

  return (
    <Modal
      title={name}
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      {data === null ? <Empty>Reading the ledger…</Empty> : (
        <>
          {/* What these figures are figures of. A bill rung up at the other
              counter is part of this product's profit, and until it has arrived
              the margin below is this machine's share of it. */}
          <Completeness />

          <div className="stat-row">
            <div>
              <h3>On the shelf now</h3>
              <div className="total-line">
                <span>On hand</span>
                <span className="num">
                  {Quantity.formatQty(data.valuation.qtyOnHand)} {baseUnit}
                </span>
              </div>
              <div className="total-line">
                <span>Average cost</span><Rupees value={data.valuation.averageCost} />
              </div>
              <div className="total-line grand">
                <span>Stock value</span>
                <Rupees value={data.valuation.totalValue} className="amount" />
              </div>
              <div className="src">
                Moving average, replayed from every movement below and what it cost
                at the time. There is no cost price on the product: a single figure
                overwritten on each delivery would make today's profit a function
                of today's buying price.
              </div>
            </div>

            <div>
              <h3>Profit</h3>
              <table>
                <thead>
                  <tr><th /><th className="r">This month</th><th className="r">All time</th></tr>
                </thead>
                <tbody>
                  <Line label="Sold" a={qty(data.month, baseUnit)} b={qty(data.ever, baseUnit)} />
                  <MoneyLine label="Revenue" a={data.month.revenue} b={data.ever.revenue} />
                  <MoneyLine label="Cost of goods" a={data.month.cost} b={data.ever.cost} />
                  <tr className="grand">
                    <td>Profit</td>
                    <td className="r"><Rupees value={data.month.margin} /></td>
                    <td className="r"><Rupees value={data.ever.margin} /></td>
                  </tr>
                  <Line
                    label="Margin"
                    a={pct(data.month)}
                    b={pct(data.ever)}
                  />
                </tbody>
              </table>
              {data.ever.uncostedLines > 0 && (
                <div className="src warn-note">
                  {data.ever.uncostedLines === 1
                    ? 'One sale of this item left the shelf with no cost recorded, so'
                    : `${data.ever.uncostedLines} sales of this item left the shelf with no cost recorded, so`}
                  {' '}the profit above is higher than the truth. Enter a unit cost when
                  this item is next received.
                </div>
              )}
            </div>
          </div>

          <h3>Every movement</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Document</th>
                <th className="r">In</th><th className="r">Out</th>
                <th className="r">Rate</th><th className="r">Value</th>
                <th className="r">Balance</th><th>By</th>
              </tr>
            </thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={`${m.voucherId}-${m.at}-${m.qtyChange}`}>
                  <td className="num">{m.postingDate}</td>
                  <td>
                    {m.docNo ?? <span className="src">—</span>}
                    <div className="src">{describe(m)}</div>
                  </td>
                  <td className="r num">
                    {m.qtyChange > 0 ? Quantity.formatQty(m.qtyChange) : ''}
                  </td>
                  <td className="r num">
                    {m.qtyChange < 0 ? Quantity.formatQty(Math.abs(m.qtyChange) as never) : ''}
                  </td>
                  <td className="r num">
                    {m.unitCost === null
                      ? <span className="src" title="No cost was recorded for this movement">none</span>
                      : Money.format(m.unitCost)}
                  </td>
                  <td className="r num">
                    {m.value === null ? '' : Money.format(m.value)}
                  </td>
                  {/* Below zero is a real state — a shop can sell what its records
                      say it does not have — so it is shown rather than clamped. */}
                  {/* Another counter's running total is not this shelf's, so it is not shown as one. */}
                  <td className="r num">{m.balanceQty === null ? '—' : Quantity.formatQty(m.balanceQty)}</td>
                  <td className="src">{m.by ?? '—'}</td>
                </tr>
              ))}
              {data.movements.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Empty>This item has never moved. Bring stock in to start its history.</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  )
}

/** What kind of movement it was, in the words the screens that made it use. */
function describe(m: StockMovement): string {
  if (m.voucherType === 'bill') return 'Sale'
  if (m.voucherType === 'bill_reversal') return 'Sale cancelled'
  if (m.voucherType === 'sales_return') return 'Return'
  if (m.voucherType === 'sales_return_reversal') return 'Return cancelled'
  if (m.voucherType === 'stock_entry') return ENTRY[m.entryType ?? ''] ?? 'Stock entry'
  if (m.voucherType === 'stock_entry_reversal') return 'Stock entry cancelled'
  return m.voucherType.replace(/_/g, ' ')
}

const ENTRY: Record<string, string> = {
  purchase: 'Purchase',
  opening: 'Opening stock',
  adjustment: 'Adjustment',
  wastage: 'Wastage',
}

function qty(p: ProductProfit, unit: string): string {
  return `${Quantity.formatQty(p.qtySold)} ${unit}`
}

function pct(p: ProductProfit): string {
  return p.revenue === 0 ? '—' : `${(p.marginBp / 100).toFixed(1)}%`
}

function Line({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr><td>{label}</td><td className="r num">{a}</td><td className="r num">{b}</td></tr>
  )
}

function MoneyLine({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="r"><Rupees value={a} /></td>
      <td className="r"><Rupees value={b} /></td>
    </tr>
  )
}
