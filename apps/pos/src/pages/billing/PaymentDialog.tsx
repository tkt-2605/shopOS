import { useRef, useState } from 'react'
import { Money, type CustomerListItem } from '@shopos/core'
import { Modal } from '../../ui/components'
import type { ShortLine } from './cart'
import { cashNotes } from './cashNotes'

export type Tender = 'cash' | 'upi' | 'card' | 'credit'

/**
 * Taking the money: points first if the customer has any, then the shelf's
 * shortfall answered, then the tender.
 *
 * Cash asks what was handed over, so the cashier is told the change rather
 * than working it out with a queue watching, and the receipt can say it. Left
 * blank, the cash was exact. And when the counter has not been opened today,
 * it says so before the first cash is taken -- cash taken at a closed counter
 * goes into no drawer, and the evening's count cannot find it.
 */
export function PaymentDialog({
  due, customer, redeemable, redeemPoints, setRedeemPoints, redeemedValue,
  sellingShort, short, acknowledged, shortKey, onAcknowledge, blockedOnShort, busy, onPay, onClose,
  drawerClosed, canOpenDrawer, onOpenDrawer,
}: {
  due: Money.Money
  customer: CustomerListItem | null
  /** How many points this bill can absorb. */
  redeemable: number
  redeemPoints: number
  setRedeemPoints: (points: number) => void
  redeemedValue: number
  sellingShort: boolean
  short: Map<string, ShortLine>
  acknowledged: string
  shortKey: string
  onAcknowledge: () => void
  blockedOnShort: boolean
  busy: boolean
  /** `tendered` is the cash handed over, when the cashier typed it. */
  onPay: (method: Tender, tendered?: Money.Money) => void
  onClose: () => void
  /** True when no cash session is open at this counter. */
  drawerClosed: boolean
  canOpenDrawer: boolean
  /** Opens the counter with this much in the drawer; answers an error to show, or null. */
  onOpenDrawer: (openingCash: Money.Money) => Promise<string | null>
}) {
  const [received, setReceived] = useState('')
  const [float, setFloat] = useState('')
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const receivedRef = useRef<HTMLInputElement>(null)

  const tendered = received.trim() === '' ? null : Money.parseMoney(received)
  const underpaid = tendered !== null && tendered < due
  const change = tendered !== null && !underpaid ? ((tendered - due) as Money.Money) : null
  const payCash = () => {
    if (blockedOnShort || busy || underpaid || (received.trim() !== '' && tendered === null)) return
    onPay('cash', tendered !== null && tendered > due ? tendered : undefined)
  }

  return (
    <Modal
      title={`Take payment — ${Money.formatWithSymbol(due)}`}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Cancel</button>}
    >
      {redeemable > 0 && (
        <div style={{ padding: '11px 13px', background: 'var(--ok-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12.5, flex: 1 }}>
              {customer!.name} has <strong>{customer!.loyaltyPoints} points</strong>.
              Up to {redeemable} can go against this bill.
            </span>
            <input
              className="qty-input num" type="number" min={0} max={redeemable}
              value={redeemPoints}
              onChange={(e) => setRedeemPoints(Math.max(0, Math.min(redeemable, Number(e.target.value) || 0)))}
            />
            <button className="btn sm" onClick={() => setRedeemPoints(redeemable)}>All</button>
          </div>
          {redeemPoints > 0 && (
            <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--ink-2)' }}>
              {redeemPoints} points pay {Money.formatWithSymbol(redeemedValue as never)} — {Money.formatWithSymbol(due)} left.
            </div>
          )}
        </div>
      )}

      {/* Above the money, not below it. This is the last point at which
          changing the quantity costs nothing, and the buttons stay out of
          reach until it has been answered one way or the other. Under
          `block` the service refuses instead and this never shows. */}
      {sellingShort && (
        <div className="short-gate">
          <div className="short-gate-text">
            <div className="short-gate-head">
              Not enough stock for {short.size === 1 ? 'this item' : `${short.size} items`}
            </div>
            {[...short.values()].map((w) => (
              <div key={w.name} className="short-gate-line">
                {w.name} — <span className="num">{w.have}</span> {w.unit} in stock,
                selling <span className="num">{w.want}</span>
              </div>
            ))}
            <div className="short-gate-note">
              {acknowledged === shortKey
                ? 'The count will go below zero and the item will be on “Counts that need fixing”.'
                : 'Change the quantity on the bill, or sell it anyway and fix the count later.'}
            </div>
          </div>
          {acknowledged !== shortKey && (
            <button className="btn warn" onClick={onAcknowledge}>
              Sell anyway
            </button>
          )}
        </div>
      )}

      {due > 0 && drawerClosed && (
        <div className="drawer-gate">
          <div className="drawer-gate-head">The counter has not been opened</div>
          <div className="drawer-gate-note">
            Cash taken now goes into no drawer, and the day’s count will not find it.
            {canOpenDrawer ? ' Count the cash already in the drawer and open the counter first.' : ' Ask someone who can open the counter.'}
          </div>
          {canOpenDrawer && (
            <div className="drawer-gate-row">
              <label htmlFor="opening-cash">Cash in the drawer now</label>
              <input
                id="opening-cash" className="input num" style={{ width: 120 }} placeholder="0.00"
                value={float} onChange={(e) => setFloat(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || (float.trim() !== '' && Money.parseMoney(float) === null)}
                onClick={() => {
                  void onOpenDrawer((Money.parseMoney(float) ?? 0) as Money.Money).then((error) => {
                    setDrawerError(error)
                    if (!error) receivedRef.current?.focus()
                  })
                }}
              >
                Open the counter
              </button>
            </div>
          )}
          {drawerError && <div className="drawer-gate-note warn-note">{drawerError}</div>}
        </div>
      )}

      {due > 0 && (
        <div className="cash-tender">
          <div className="cash-tender-row">
            <label htmlFor="cash-received">Cash received</label>
            <input
              id="cash-received" ref={receivedRef} className="input num cash-received" autoFocus
              placeholder={Money.format(due)} value={received}
              onChange={(e) => setReceived(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); payCash() } }}
            />
            <div className={`cash-change ${underpaid ? 'warn-note' : ''}`}>
              {underpaid
                ? <>Short by <span className="num">{Money.formatWithSymbol((due - tendered!) as Money.Money)}</span></>
                : change !== null
                  ? <>Change <span className="num">{Money.formatWithSymbol(change)}</span></>
                  : 'Blank is the exact amount'}
            </div>
          </div>
          <div className="cash-notes">
            {cashNotes(due).map((note) => (
              <button key={note} className="btn sm" onClick={() => { setReceived(Money.format(note as Money.Money)); receivedRef.current?.focus() }}>
                {Money.formatWithSymbol(note as Money.Money)}
              </button>
            ))}
          </div>
        </div>
      )}

      {due === 0 ? (
        <button className="btn primary lg" disabled={blockedOnShort || busy} onClick={() => onPay('cash')}>
          Settle with points
        </button>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button className="btn primary lg" disabled={blockedOnShort || busy || underpaid} onClick={payCash}>
            {change !== null && change > 0 ? `Cash — give ${Money.formatWithSymbol(change)} back` : 'Cash'}
          </button>
          <button className="btn lg" disabled={blockedOnShort || busy} onClick={() => onPay('upi')}>UPI</button>
          <button className="btn lg" disabled={blockedOnShort || busy} onClick={() => onPay('card')}>Card</button>
          <button
            className="btn lg"
            disabled={blockedOnShort || busy || !customer}
            onClick={() => onPay('credit')}
          >
            Credit
          </button>
        </div>
      )}

      {!customer && <span className="hint">Credit and loyalty points both need a customer on the bill.</span>}
    </Modal>
  )
}
