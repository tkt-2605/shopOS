import { Money, type CustomerListItem } from '@shopos/core'
import { Modal } from '../../ui/components'
import type { ShortLine } from './cart'

export type Tender = 'cash' | 'upi' | 'card' | 'credit'

/**
 * Taking the money: points first if the customer has any, then the shelf's
 * shortfall answered, then the tender.
 */
export function PaymentDialog({
  due, customer, redeemable, redeemPoints, setRedeemPoints, redeemedValue,
  sellingShort, short, acknowledged, shortKey, onAcknowledge, blockedOnShort, busy, onPay, onClose,
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
  onPay: (method: Tender) => void
  onClose: () => void
}) {
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

      {due === 0 ? (
        <button className="btn primary lg" disabled={blockedOnShort || busy} onClick={() => onPay('cash')}>
          Settle with points
        </button>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button className="btn primary lg" disabled={blockedOnShort || busy} onClick={() => onPay('cash')}>Cash</button>
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
