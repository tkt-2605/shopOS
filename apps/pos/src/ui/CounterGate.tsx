import type { ReactNode } from 'react'
import { useCore } from '../core/CoreProvider'
import { goTo } from '../core/nav'

/**
 * The door in front of the screens that mint numbers.
 *
 * A shop with two tills gives each counter its own prefix, because that prefix
 * is the only thing keeping two machines billing at the same moment from
 * minting the same invoice number. A till that has never been asked which
 * counter it sits at used to be handed the shop's first one -- which is the
 * *other* till's -- and would bill on it until a sync refused, long after both
 * machines held bills with the same number.
 *
 * `resolveDeviceRegister` stops guessing once a shop has a peer, so that till
 * now has no counter at all. This is what it meets instead of the billing
 * screen: one question, and the screen that answers it.
 *
 * Only in front of billing and the cash counter. Everything else -- yesterday's
 * bills, the stock, the reports -- is about the shop rather than about this
 * machine, and is no less true for not knowing which counter is asking.
 */
export function CounterGate({ children }: { children: ReactNode }) {
  const { registerId } = useCore()
  if (registerId !== '') return <>{children}</>

  return (
    <div className="centre">
      <div className="panel">
        <div className="panel-head">
          <h1>Which counter is this?</h1>
          <p>This machine has not been told which counter it sits at.</p>
        </div>
        <div className="panel-body">
          <p style={{ fontSize: 13.5, color: 'var(--ink-2)', margin: 0 }}>
            This shop has more than one till, and each counter has its own
            number series. Until this machine says which one it is, it cannot
            bill — two tills on one counter would hand two different customers
            the same bill number.
          </p>
          <button className="btn primary lg" onClick={() => goTo('registers')}>
            Choose the counter
          </button>
        </div>
      </div>
    </div>
  )
}
