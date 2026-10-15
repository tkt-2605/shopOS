import { useEffect, useState } from 'react'
import { goTo, openAccount } from '../core/nav'
import { Money, applyRemedy, type Remedy } from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { checkDiscrepancies, discrepancies, markSeen, onDiscrepancies, type Found } from '../core/discrepancyWatch'
import { Card, Empty } from './components'
import { useConfirm } from './useConfirm'

const AREA: Record<Found['area'], string> = {
  money: 'Money', stock: 'Stock', books: 'Books', records: 'Records', sync: 'Syncing',
}

/**
 * Everything in the shop's records that does not add up, each with what to do.
 *
 * Read again whenever the dashboard opens, as well as after syncs. Clearing one
 * takes it off the list and the banner on this till. Some never stop being
 * true -- a return taken twice last month is still in the records -- so a list
 * that kept everything still true would only grow. Cleared ones can be shown
 * again, and one whose facts change (a third refund, another document out of
 * the books) has a new key and comes back by itself.
 */
export function NeedsAttention() {
  const { db } = useCore()
  const user = useUser()
  const [found, setFound] = useState<Found[]>(discrepancies)
  const [error, setError] = useState<string | null>(null)
  const [showCleared, setShowCleared] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmUi, ask] = useConfirm()

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

  /* One press on the warning cancels the document that should not stand,
     after saying in plain words what that does -- through the document's own
     service, so the same permission and closed books apply. */
  async function remedy(r: Remedy) {
    setError(null)
    setNotice(null)
    if (!(await ask(QUESTION[r.act](r)))) return
    try {
      const result = await applyRemedy(db, r, user.id)
      if (!result.ok) { setError(result.why); return }
      setNotice(`${result.docNo} cancelled.`)
      await checkDiscrepancies(db)
    } catch (err) {
      setError(`That did not go through: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const unseen = found.filter((d) => !d.seen)
  const cleared = found.length - unseen.length
  const shown = showCleared ? found : unseen
  return (
    <Card
      title="Needs attention"
      {...(unseen.length > 1
        ? { actions: <button className="btn ghost sm" type="button" onClick={() => void seen(unseen.map((d) => d.key))}>Clear all</button> }
        : {})}
    >
      {confirmUi}
      {error && <div className="ladder-note bad">{error}</div>}
      {notice && <div className="ladder-note">{notice}</div>}
      {found.length === 0 ? (
        <Empty>Everything adds up</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {shown.length === 0 && <Empty>Nothing new</Empty>}
          {shown.map((d) => (
            <div key={d.key} className="attention-item" style={{ opacity: d.seen ? 0.6 : 1, borderLeft: '3px solid var(--warn)', paddingLeft: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="badge">{AREA[d.area]}</span>
                <strong style={{ flex: 1 }}>{d.title}</strong>
                {d.amount !== null && d.amount > 0 && <span className="num">{Money.formatWithSymbol(d.amount)}</span>}
                {d.seen
                  ? <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>cleared</span>
                  : <button className="btn ghost sm" type="button" onClick={() => void seen([d.key])}>Clear</button>}
              </div>
              <div>{d.detail}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{d.action}</div>
              {d.remedies && d.remedies.length > 0 && !d.seen && (
                <div className="remedies">
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{PICK[d.remedies[0]!.act]}</div>
                  {d.remedies.map((r) => (
                    <div key={r.id} className="remedy">
                      <span className="num">{r.docNo}</span>
                      {r.amount !== null && <span className="num">{Money.formatWithSymbol(r.amount)}</span>}
                      <span style={{ color: 'var(--ink-2)' }}>{[r.where, when(r.at)].filter(Boolean).join(' · ')}</span>
                      <button className="btn sm danger" type="button" onClick={() => void remedy(r)}>{BUTTON[r.act]}</button>
                    </div>
                  ))}
                </div>
              )}
              {d.kind === 'advance_spent_twice' && d.customerId && (
                <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }}
                  onClick={() => openAccount(d.customerId!)}>Take payment on the account</button>
              )}
              {d.kind === 'counted_twice' && (
                <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }}
                  onClick={() => goTo('stock_count')}>Count again</button>
              )}
              {d.refs.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }} className="num">{d.refs.join(' · ')}</div>
              )}
            </div>
          ))}
          {cleared > 0 && (
            <button className="btn ghost sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setShowCleared(!showCleared)}>
              {showCleared ? 'Hide cleared' : `Show ${cleared} cleared`}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

const BUTTON: Record<Remedy['act'], string> = {
  cancel_payment: 'Cancel this payment',
  cancel_return: 'Cancel this return',
  cancel_bill: 'Cancel this bill',
}

const PICK: Record<Remedy['act'], string> = {
  cancel_payment: 'Only one of these payments was really made. Cancel the other:',
  cancel_return: 'Only one of these returns really happened. Cancel the other:',
  cancel_bill: 'Only one of these bills should stand. Cancel the other:',
}

const money = (r: Remedy) => (r.amount === null ? '' : ` for ${Money.formatWithSymbol(r.amount)}`)
const place = (r: Remedy) => [r.where && `at ${r.where}`, r.at && when(r.at)].filter(Boolean).join(', ')

const QUESTION: Record<Remedy['act'], (r: Remedy) => string> = {
  cancel_payment: (r) => `Cancel payment ${r.docNo}${money(r)} (${place(r)})? `
    + 'It comes off the account as if it was never taken. Do this only for the payment that was not really made.',
  cancel_return: (r) => `Cancel return ${r.docNo}${money(r)} (${place(r)})? `
    + 'The item goes back out of stock and the refund is taken back. Do this only for the return that did not really happen.',
  cancel_bill: (r) => `Cancel bill ${r.docNo}${money(r)} (${place(r)})? `
    + 'Its goods go back into stock and its money comes off the takings. Do this only for the bill that should not stand.',
}

function when(at: string | null): string {
  if (at === null) return ''
  const d = new Date(at)
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
