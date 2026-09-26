import { useEffect, useState } from 'react'
import { onOutOfDate, outOfDate, type OutOfDate } from '../core/outOfDate'
import { Alert } from './components'

/**
 * This till is running a ShopOS too old for another till in the shop.
 *
 * On every screen, and plain about it, because what it means is easy to miss:
 * the two exchange nothing until this machine is updated, so the stock,
 * takings and credit shown here stop counting the other counter's work, and
 * nothing else on the screen looks wrong. Billing carries on -- a counter never
 * stops taking money -- and everything rung up here crosses once it is updated.
 */
export function OutOfDateBanner() {
  const [gap, setGap] = useState<OutOfDate | null>(outOfDate)

  useEffect(() => onOutOfDate(setGap), [])

  if (gap === null) return null

  const since = new Date(gap.since).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })

  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <Alert>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>This till is out of sync with the shop until it is updated.</strong>
          <div>
            Another till is on a newer ShopOS, and this one is too old to exchange
            anything with it, so it has stopped trying. Since {since}, the stock,
            takings and credit shown here do not include what the other counter
            has done.
          </div>
          <div>
            You can go on billing: nothing rung up here is lost, and it all crosses
            to the other till once this one is updated. Install the same version of
            ShopOS the other till has, on this machine.
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            This till: database version {gap.mine}. The other till: version {gap.theirs},
            which cannot talk to anything below {gap.theirFloor}.
          </div>
        </div>
      </Alert>
    </div>
  )
}
