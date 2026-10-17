import { useEffect, useState } from 'react'
import { Money } from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { discrepancies, onDiscrepancies, watchDiscrepancies, type Found } from '../core/discrepancyWatch'
import { goTo } from '../core/nav'
import { Alert } from './components'
import { useSwitchedOff } from '../core/switches'

/**
 * Something in the shop's records does not add up, and nobody here has seen it.
 *
 * On every screen, for whoever may open the dashboard, because the moment it
 * is found -- a sync bringing in the other counter's refund of the shirt this
 * counter also refunded -- is a moment nobody is looking at a report. It stays
 * until each one is marked seen on the dashboard, and comes back for the next.
 */
export function DiscrepancyBanner({ canReview }: { canReview: boolean }) {
  const { db } = useCore()
  const [found, setFound] = useState<Found[]>(discrepancies)
  // The vendor can take the banner down at a shop where it misbehaves; Needs Attention keeps the list.
  const bannerOff = useSwitchedOff('needs_attention_banner')

  useEffect(() => onDiscrepancies(setFound), [])
  useEffect(() => { watchDiscrepancies(db) }, [db])

  const unseen = found.filter((d) => !d.seen)
  if (!canReview || unseen.length === 0 || bannerOff) return null

  const money = unseen.reduce((sum, d) => sum + (d.area === 'money' ? d.amount ?? 0 : 0), 0)
  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <Alert>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <strong>
              {unseen.length === 1 ? 'One thing' : `${unseen.length} things`} in the shop’s records
              {unseen.length === 1 ? ' does' : ' do'} not add up
              {money > 0 ? `, ${Money.formatWithSymbol(money as Money.Money)} at stake` : ''}.
            </strong>
            <div>{unseen[0]!.title}{unseen.length > 1 ? `, and ${unseen.length - 1} more` : ''}.</div>
          </div>
          <button className="btn sm" type="button" onClick={() => goTo('dashboard')}>Review</button>
        </div>
      </Alert>
    </div>
  )
}
