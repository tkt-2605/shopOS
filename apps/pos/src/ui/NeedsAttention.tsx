import { useEffect, useState } from 'react'
import { Money } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { checkDiscrepancies, discrepancies, markSeen, onDiscrepancies, type Found } from '../core/discrepancyWatch'
import { Card, Empty } from './components'

const AREA: Record<Found['area'], string> = {
  money: 'Money', stock: 'Stock', books: 'Books', records: 'Records', sync: 'Syncing',
}

/**
 * Everything in the shop's records that does not add up, each with what to do.
 *
 * Read again whenever the dashboard opens, as well as after syncs. Marking one
 * seen hides it from the banner on this till; it stays listed, dimmed, for as
 * long as it is still true, because seen is not the same as dealt with.
 */
export function NeedsAttention() {
  const { db } = useCore()
  const user = useUser()
  const [found, setFound] = useState<Found[]>(discrepancies)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => onDiscrepancies(setFound), [])
  useEffect(() => { void checkDiscrepancies(db) }, [db])

  async function seen(keys: string[]) {
    setError(null)
    try {
      await markSeen(db, keys, user.id)
    } catch (err) {
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const unseen = found.filter((d) => !d.seen)
  return (
    <Card
      title="Needs attention"
      {...(unseen.length > 1
        ? { actions: <button className="btn ghost sm" type="button" onClick={() => void seen(unseen.map((d) => d.key))}>Mark all seen</button> }
        : {})}
    >
      {error && <div className="ladder-note bad">{error}</div>}
      {found.length === 0 ? (
        <Empty>Everything adds up</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {found.map((d) => (
            <div key={d.key} className="attention-item" style={{ opacity: d.seen ? 0.6 : 1, borderLeft: '3px solid var(--warn)', paddingLeft: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="badge">{AREA[d.area]}</span>
                <strong style={{ flex: 1 }}>{d.title}</strong>
                {d.amount !== null && d.amount > 0 && <span className="num">{Money.formatWithSymbol(d.amount)}</span>}
                {d.seen
                  ? <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>seen</span>
                  : <button className="btn ghost sm" type="button" onClick={() => void seen([d.key])}>Seen</button>}
              </div>
              <div>{d.detail}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{d.action}</div>
              {d.refs.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }} className="num">{d.refs.join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
