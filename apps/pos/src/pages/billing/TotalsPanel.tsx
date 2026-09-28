import { Money, RULE_46F_THRESHOLD, type Totals } from '@shopos/core'
import type { Cart, CartLine } from '../../core/useBillTabs'
import { Field, Alert, Rupees } from '../../ui/components'

/**
 * The right-hand side of the counter: who the bill is for, what it comes to,
 * and the button that takes the money.
 */
export function TotalsPanel({
  cart, totals, blocked, needsRecipient, loyaltyMonth, empty, unfinished, onPickCustomer, onDiscount, onPay,
}: {
  cart: Cart
  totals: Totals.ComputedTotals
  /** Lines that take no discount. */
  blocked: CartLine[]
  needsRecipient: boolean
  /** Where the customer stands against the loyalty target, when there is one. */
  loyaltyMonth: { spent: Money.Money; target: Money.Money; thisBill: Money.Money } | null
  empty: boolean
  unfinished: boolean
  onPickCustomer: () => void
  onDiscount: (typed: string) => void
  onPay: () => void
}) {
  return (
    <div className="bill-right">
      <div className="totals">
        <Field label="Customer">
          <button className="btn" style={{ width: '100%', justifyContent: 'space-between' }}
            onClick={onPickCustomer}>
            <span>{cart.customer?.name ?? 'Walk-in'}</span>
            <span style={{ color: 'var(--ink-3)' }}>Change</span>
          </button>
        </Field>
        {cart.customer && cart.customer.outstanding > 0 && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn)' }}>
            Outstanding <Rupees value={cart.customer.outstanding} />
          </div>
        )}
        {loyaltyMonth && <MonthTarget {...loyaltyMonth} />}
        {/* Said while the cart is being built rather than at the moment the
            customer holds out the money. Rule 46(f) refuses this bill at
            submit, and a refusal a cashier could have seen coming is a
            refusal that should have been a warning. */}
        {needsRecipient && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn)' }}>
            Over {Money.formatWithSymbol(RULE_46F_THRESHOLD)}, so this bill needs a
            customer with a name and address before it can be taken.
          </div>
        )}
        {/* Which order this tab is settling, said plainly and permanently:
            the notice that announced it is gone by the time the customer
            finishes at the shelf, and a counter restarted after a power cut
            would otherwise have nothing to go on. */}
        {cart.fromOrder && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
            Billing order <strong>{cart.fromOrder.docNo}</strong> — marked off when this is paid.
          </div>
        )}
      </div>

      <div className="totals">
        {cart.error && <div style={{ marginBottom: 12 }}><Alert>{cart.error}</Alert></div>}

        <div className="total-line">
          <span>Subtotal</span><Rupees value={totals.subtotal} />
        </div>
        <div className="total-line">
          <span>Discount</span>
          <input
            className="qty-input num" style={{ width: 110 }}
            placeholder="0.00" value={cart.discount}
            onChange={(e) => onDiscount(e.target.value)}
          />
        </div>
        {blocked.length > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '-4px 0 8px' }}>
            {blocked.length === 1
              ? `${blocked[0]!.product.name} takes no discount.`
              : `${blocked.length} items take no discount.`}
            {' '}Only <Rupees value={totals.discountableSubtotal} /> of this bill can be reduced.
          </div>
        )}
        <div className="total-line" style={{ color: 'var(--ink-3)' }}>
          <span>Tax included</span><Rupees value={totals.taxTotal} />
        </div>
        <div className="total-line grand">
          <span>Total</span><Rupees value={totals.grandTotal} className="amount" />
        </div>
      </div>

      <button className="pay-btn" disabled={empty || unfinished} onClick={onPay}>
        <span className="k">F12</span>
        <span>{unfinished ? 'A line has no quantity' : 'Take payment'}</span>
      </button>
    </div>
  )
}

/**
 * The loyalty target, said so the cashier can tell the customer: how much
 * this month so far, and whether this bill gets them there.
 */
function MonthTarget({ spent, target, thisBill }: { spent: Money.Money; target: Money.Money; thisBill: Money.Money }) {
  const reached = spent >= target
  const withThis = Money.add(spent, thisBill)
  const pct = Math.min(100, Math.round((Math.min(withThis, target) / target) * 100))
  const note = reached
    ? 'Target reached — this bill earns points.'
    : withThis >= target
      ? 'This bill reaches the target and earns points.'
      : <><Rupees value={Money.sub(target, withThis)} /> more this month to earn points.</>
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>This month</span>
        <span><Rupees value={spent} /> of <Rupees value={target} /></span>
      </div>
      <div role="progressbar" aria-label="Monthly loyalty target" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
        style={{ height: 4, background: 'var(--rule-strong)', margin: '4px 0' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: withThis >= target ? 'var(--ok)' : 'var(--accent)' }} />
      </div>
      <div style={{ color: withThis >= target ? 'var(--ok)' : 'var(--ink-3)' }}>{note}</div>
    </div>
  )
}
