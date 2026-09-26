import { useCallback, useEffect, useState } from 'react'
import {
  Money, Permissions, getOrOpenSession, openSessionFor, sessionSummary, closeSession,
  recordPayout, countDrawer, sessionMovements, type SessionSummary, type SessionMovement,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert, Rupees } from '../ui/components'
import { useShopChanged } from '../core/useShopChanged'
import { useAction } from '../core/useAction'
import { Completeness } from '../ui/Completeness'

const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1]

/**
 * How many of a note were typed, by the rule `countDrawer` applies: a whole
 * number, not below zero, or nothing. The screen used to add up `1.5` notes
 * that the close then ignored, so the total shown was not the total recorded.
 */
function notesOf(typed: string | undefined): number {
  const n = Number(typed)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** The time of day on this machine's clock. The stored stamp is UTC, and its own digits are five and a half hours out. */
function timeOfDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
export default function CashCounter() {
  const { db, registerId, registerName } = useCore()
  const user = useUser()
  /* Opening the drawer, taking money out of it and closing it against a count
     are three different trusts, and the role grid has always said so. */
  const canOpen = Permissions.can(user.permissions, 'cash_session', 'create')
  const canMove = Permissions.can(user.permissions, 'cash_session', 'write')
  const canClose = Permissions.can(user.permissions, 'cash_session', 'submit')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [movements, setMovements] = useState<SessionMovement[]>([])
  const [opening, setOpening] = useState('')
  const [counting, setCounting] = useState(false)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [payout, setPayout] = useState<{ amount: string; reason: string } | null>(null)
  const [closed, setClosed] = useState<{ expected: number; actual: number; variance: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Opening, paying out and closing each move money once per press.
  const action = useAction(setError)
  const refresh = useCallback(async () => {
    const id = await openSessionFor(db, registerId)
    setSessionId(id)
    if (!id) { setSummary(null); setMovements([]); return }
    setSummary(await sessionSummary(db, id))
    setMovements(await sessionMovements(db, id))
  }, [db, registerId])

  useEffect(() => { void refresh() }, [refresh])
  // And again whenever the other till sends something this list shows.
  useShopChanged(refresh)

  async function openDrawer() {
    const float = opening.trim() === '' ? 0 : Money.parseMoney(opening)
    if (float === null || float < 0) { setError('The opening cash has to be an amount, zero or more.'); return }
    setError(null)
    await action.run(async () => {
      await getOrOpenSession(db, { registerId, userId: user.id, openingCash: float as never })
      setOpening('')
      await refresh()
    })
  }

  async function payOut() {
    if (!payout || !sessionId) return
    const amount = Money.parseMoney(payout.amount)
    if (amount === null || amount <= 0) { setError('Enter an amount greater than zero.'); return }
    setError(null)
    await action.run(async () => {
      const result = await recordPayout(db, { sessionId, amount, reason: payout.reason, userId: user.id })
      if (!result.ok) {
        setError(result.code === 'SESSION_CLOSED'
          ? 'This drawer has been closed. Open it again to take money out.'
          : 'Enter an amount greater than zero.')
        return
      }
      setPayout(null)
      await refresh()
    })
  }

  async function doClose() {
    if (!sessionId) return
    setError(null)
    await action.run(async () => {
      const actual = await countDrawer(
        Object.fromEntries(Object.entries(counts).map(([note, n]) => [note, notesOf(n)])),
      )
      const result = await closeSession(db, { sessionId, actualCash: actual, userId: user.id })
      setClosed({ expected: result.expectedCash, actual: result.actualCash, variance: result.variance })
      setCounting(false)
      setCounts({})
      await refresh()
    })
  }

  const counted = NOTES.reduce((s, n) => s + n * 100 * notesOf(counts[String(n)]), 0)

  if (!sessionId) {
    return (
      <div style={{ maxWidth: 420 }}>
        {closed && (
          <div style={{ marginBottom: 14 }}>
            <Alert kind={closed.variance === 0 ? 'ok' : 'warn'}>
              Drawer closed. Expected {Money.formatWithSymbol(closed.expected as never)}, counted{' '}
              {Money.formatWithSymbol(closed.actual as never)}
              {closed.variance !== 0 && ` — ${Money.formatWithSymbol(Math.abs(closed.variance) as never)} ${closed.variance < 0 ? 'short' : 'over'}`}.
            </Alert>
          </div>
        )}
        {error && <div style={{ marginBottom: 14 }}><Alert>{error}</Alert></div>}
        <Card title={`Open the drawer — ${registerName}`}>
          <Field label="Cash in the drawer to start" hint="What is physically there now.">
            <input className="input num" id="opening-cash" autoFocus value={opening}
              onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
          </Field>
          <button className="btn primary lg" style={{ marginTop: 14, width: '100%' }}
            disabled={!canOpen || action.busy} onClick={() => void openDrawer()}>
            Open drawer
          </button>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* A drawer is counted against what the till thinks it took. If the back
          counter's card payments have not arrived, the variance is somebody
          else's sales and not a shortfall in this drawer. */}
      <Completeness />
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        {registerName} · this machine's drawer
      </div>
      {error && !payout && !counting && <Alert>{error}</Alert>}

      <div className="stat-row">
        <div className="stat">
          <div className="label">Opening float</div>
          <div className="value num">{Money.formatWithSymbol((summary?.openingCash ?? 0) as never)}</div>
        </div>
        <div className="stat">
          <div className="label">Cash in</div>
          <div className="value num">{Money.formatWithSymbol((summary?.cashIn ?? 0) as never)}</div>
        </div>
        <div className="stat">
          <div className="label">Cash out</div>
          <div className="value num">{Money.formatWithSymbol((summary?.cashOut ?? 0) as never)}</div>
        </div>
        <div className="stat">
          <div className="label">Should be in the drawer</div>
          <div className="value num">{Money.formatWithSymbol((summary?.expectedCash ?? 0) as never)}</div>
          <div className="sub">UPI and card excluded</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        {canMove && (
          <button className="btn" onClick={() => setPayout({ amount: '', reason: '' })}>Pay out</button>
        )}
        <span style={{ flex: 1 }} />
        {canClose && (
          <button className="btn primary" onClick={() => setCounting(true)}>Count and close</button>
        )}
      </div>

      <div className="card card-scroll">
        <table>
          <thead><tr><th>Time</th><th>What</th><th>Method</th><th className="r">In</th><th className="r">Out</th></tr></thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="num">{timeOfDay(m.createdAt)}</td>
                <td>
                  {m.sourceType.replace(/_/g, ' ')}
                  {m.reference && <div className="src">{m.reference}</div>}
                </td>
                <td>{m.method}</td>
                <td className="r">{m.direction === 'in' ? <Rupees value={m.amount} /> : ''}</td>
                <td className="r">{m.direction === 'out' ? <Rupees value={m.amount} /> : ''}</td>
              </tr>
            ))}
            {movements.length === 0 && <tr><td colSpan={5}><Empty>Nothing has moved yet</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {payout && (
        <Modal
          title="Pay out"
          onClose={() => setPayout(null)}
          footer={<>
            <button className="btn" onClick={() => setPayout(null)}>Cancel</button>
            <button className="btn primary" disabled={action.busy} onClick={() => void payOut()}>Record</button>
          </>}
        >
          {error && <Alert>{error}</Alert>}
          <Field label="Amount">
            <input className="input num" id="payout-amount" autoFocus value={payout.amount}
              onChange={(e) => setPayout({ ...payout, amount: e.target.value })} />
          </Field>
          <Field label="What for">
            <input className="input" id="payout-reason" value={payout.reason}
              onChange={(e) => setPayout({ ...payout, reason: e.target.value })} placeholder="Tea, delivery, petrol…" />
          </Field>
        </Modal>
      )}

      {counting && (
        <Modal
          title="Count the drawer"
          onClose={() => setCounting(false)}
          footer={<>
            <button className="btn" onClick={() => setCounting(false)}>Cancel</button>
            <button className="btn primary" disabled={action.busy} onClick={() => void doClose()}>
              {action.busy ? 'Closing…' : 'Close drawer'}
            </button>
          </>}
        >
          {error && <Alert>{error}</Alert>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {NOTES.map((n) => (
              <Field key={n} label={`₹${n}`}>
                <input className="input num" id={`note-${n}`} value={counts[String(n)] ?? ''}
                  onChange={(e) => setCounts({ ...counts, [String(n)]: e.target.value })} placeholder="0" />
              </Field>
            ))}
          </div>
          <div className="total-line"><span>Expected</span><Rupees value={summary?.expectedCash ?? 0} /></div>
          <div className="total-line"><span>Counted</span><Rupees value={counted} /></div>
          <div className="total-line grand">
            <span>Difference</span>
            <span className="amount num" style={{ color: counted - (summary?.expectedCash ?? 0) === 0 ? undefined : 'var(--warn)' }}>
              {Money.formatWithSymbol((counted - (summary?.expectedCash ?? 0)) as never)}
            </span>
          </div>
        </Modal>
      )}
    </div>
  )
}
