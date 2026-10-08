import { useCallback, useEffect, useState } from 'react'
import {
  Batches, Money, Quantity, batchesOf, businessDate, expiringBatches,
  type BatchRow, type ExpiringBatch,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { useShopChanged } from '../../core/useShopChanged'
import { deviceSetting, setDeviceSetting } from '../../core/device'
import { Modal, Empty } from '../../ui/components'

/*
 * Batches on the Inventory screen: what is about to expire, and one item's
 * batches. Shown only while the switch is on; see `services/batches.ts`.
 */

const STATE_LABEL: Record<Batches.ExpiryState, string> = {
  expired: 'expired', soon: 'expires soon', ok: '', none: '',
}

function ExpiryCell({ expiry, today }: { expiry: string | null; today: string }) {
  const state = Batches.expiryState(expiry, today)
  return (
    <td className="num" style={{ color: state === 'expired' ? 'var(--danger)' : undefined }}>
      {expiry ? Batches.formatExpiry(expiry) : '—'}
      {STATE_LABEL[state] && <div className="src">{STATE_LABEL[state]}</div>}
    </td>
  )
}

/** How far ahead the card looks. 0 is "already expired only". */
const WINDOWS = [0, 30, 60, 90, 180] as const
const WINDOW_SETTING = 'inventory_expiry_days'
const OPEN_SETTING = 'inventory_expiry_open'

function remembered(): { days: number; open: boolean } {
  const days = Number(deviceSetting(WINDOW_SETTING))
  return {
    days: (WINDOWS as readonly number[]).includes(days) ? days : Batches.EXPIRY_SOON_DAYS,
    open: deviceSetting(OPEN_SETTING) !== 'no',
  }
}

/**
 * Batches with stock that have expired or will within the chosen window,
 * soonest first: what to take off the shelf, and what to send back to the
 * distributor while there is still time to.
 *
 * The window and whether the list is open are this machine's, like the theme:
 * the till at the counter and the one in the back room want different things.
 * Folded, the heading still says how many there are.
 */
export function ExpiringCard() {
  const { db } = useCore()
  const [rows, setRows] = useState<ExpiringBatch[] | null>(null)
  const [{ days, open }, setView] = useState(remembered)
  const today = businessDate()

  const load = useCallback(async () => {
    const found = await expiringBatches(db, { today, withinDays: days })
    setRows(days === 0 ? found.filter((r) => Batches.expiryState(r.expiryDate, today) === 'expired') : found)
  }, [db, today, days])
  useEffect(() => { void load() }, [load])
  useShopChanged(load)

  const choose = (change: Partial<{ days: number; open: boolean }>) => {
    setView((v) => ({ ...v, ...change }))
    if (change.days !== undefined) void setDeviceSetting(WINDOW_SETTING, String(change.days))
    if (change.open !== undefined) void setDeviceSetting(OPEN_SETTING, change.open ? null : 'no')
  }

  if (rows === null) return null
  const expired = rows.filter((r) => Batches.expiryState(r.expiryDate, today) === 'expired').length

  return (
    <div className="card">
      <div className="card-head">
        <h2>{days === 0 ? 'Expired, still on the shelf' : 'Expiring soon'}</h2>
        <span className="src">
          {rows.length === 0 ? 'none' : `${rows.length} batch${rows.length === 1 ? '' : 'es'}`}
        </span>
        {days > 0 && expired > 0 && <span className="badge">{expired} already expired</span>}
        <div className="spacer" />
        <select className="select" aria-label="Expiring within" value={days}
          onChange={(e) => choose({ days: Number(e.target.value) })}>
          {WINDOWS.map((d) => (
            <option key={d} value={d}>{d === 0 ? 'Expired only' : `Within ${d} days`}</option>
          ))}
        </select>
        <button className="btn sm" onClick={() => choose({ open: !open })} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (rows.length === 0 ? (
        <div className="card-body src">
          {days === 0 ? 'Nothing expired with stock left.' : `Nothing with stock expires in the next ${days} days.`}
        </div>
      ) : (
        <div className="card-scroll" style={{ maxHeight: 240 }}>
          <table>
            <thead>
              <tr><th>Item</th><th>Batch</th><th>Expiry</th><th className="r">On hand</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.batchId}>
                  <td>{r.productName}</td>
                  <td className="num">{r.batchNo}</td>
                  <ExpiryCell expiry={r.expiryDate} today={today} />
                  <td className="r num">{Quantity.formatQty(r.balance)} {r.baseUnit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

/** One item's batches and what each holds, beside what the shelf holds in all. */
export function ProductBatches({ productId, name, baseUnit, onHand, onClose }: {
  productId: string
  name: string
  baseUnit: string
  onHand: Quantity.Qty
  onClose: () => void
}) {
  const { db } = useCore()
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const today = businessDate()

  useEffect(() => { void batchesOf(db, productId).then(setRows) }, [db, productId])

  const held = Quantity.addQty(...(rows ?? []).filter((r) => r.balance > 0).map((r) => r.balance))
  const rest = Quantity.subQty(onHand, held)

  return (
    <Modal title={`Batches of ${name}`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      {rows === null ? null : rows.length === 0 ? (
        <Empty>No batches recorded. Stock in with a batch number to start.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Batch</th><th>Expiry</th><th className="r">MRP</th><th className="r">Rate</th>
              <th className="r">On hand</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.batchId} style={{ opacity: r.balance > 0 ? 1 : 0.55 }}>
                <td className="num">{r.batchNo}</td>
                <ExpiryCell expiry={r.expiryDate} today={today} />
                {/* A batch's own price (070); blank is the item's. */}
                <td className="r num">{r.mrp !== null ? Money.formatWithSymbol(r.mrp) : ''}</td>
                <td className="r num">{r.rate !== null ? Money.formatWithSymbol(r.rate) : ''}</td>
                <td className="r num">{Quantity.formatQty(r.balance)} {baseUnit}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="src">
                {rest >= 0
                  ? 'Without a batch — received before batches were on, or with none typed'
                  : 'Batches hold more than the shelf — a count or write-off was not put against a batch'}
              </td>
              <td className="r num">{Quantity.formatQty(rest)} {baseUnit}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Modal>
  )
}
