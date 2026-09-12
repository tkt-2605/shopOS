import { useCallback, useEffect, useState } from 'react'
import {
  Money, getOrOpenSession, openSessionFor, sessionSummary, closeSession,
  postCashMovement, countDrawer, type SessionSummary,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Card, Modal, Field, Empty, Alert, Rupees } from '../ui/components'

const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1]

interface Movement {
  id: string
  direction: string
  amount: number
  method: string
  source_type: string
  reference: string | null
  created_at: string
}

export default function CashCounter() {
  const { db, registerId, registerName } = useCore()
  const user = useUser()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [opening, setOpening] = useState('')
  const [counting, setCounting] = useState(false)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [payout, setPayout] = useState<{ amount: string; reason: string } | null>(null)
  const [closed, setClosed] = useState<{ expected: number; actual: number; variance: number } | null>(null)

  const refresh = useCallback(async () => {
    const id = await openSessionFor(db, registerId)
    setSessionId(id)
    if (!id) { setSummary(null); setMovements([]); return }
    setSummary(await sessionSummary(db, id))
    setMovements(await db.query<Movement>(
      `SELECT id, direction, amount, method, source_type, reference, created_at
         FROM cash_movements WHERE session_id = ? ORDER BY created_at DESC LIMIT 60`, [id],
    ))
  }, [db, registerId])

  useEffect(() => { void refresh() }, [refresh])

  async function openDrawer() {
    await getOrOpenSession(db, {
      registerId, userId: user.id,
      openingCash: (Money.parseMoney(opening) ?? 0) as never,
    })
    setOpening('')
    await refresh()
  }

  async function recordPayout() {
    if (!payout || !sessionId) return
    const amount = Money.parseMoney(payout.amount)
    if (amount === null || amount <= 0) return
    await db.transaction(async (tx) => {
      await postCashMovement(tx, {
        sessionId, direction: 'out', amount,
        sourceType: 'expense', reference: payout.reason.trim() || null, userId: user.id,
      })
    })
    setPayout(null)
    await refresh()
  }

  async function doClose() {
    if (!sessionId) return
    const actual = await countDrawer(
      Object.fromEntries(Object.entries(counts).map(([note, n]) => [note, Number(n) || 0])),
    )
    const result = await closeSession(db, { sessionId, actualCash: actual, userId: user.id })
    setClosed({ expected: result.expectedCash, actual: result.actualCash, variance: result.variance })
    setCounting(false)
    setCounts({})
    await refresh()
  }

  const counted = NOTES.reduce((s, n) => s + n * 100 * (Number(counts[String(n)]) || 0), 0)

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
        <Card title={`Open the drawer — ${registerName}`}>
          <Field label="Cash in the drawer to start" hint="What is physically there now.">
            <input className="input num" id="opening-cash" autoFocus value={opening}
              onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
          </Field>
          <button className="btn primary lg" style={{ marginTop: 14, width: '100%' }} onClick={() => void openDrawer()}>
            Open drawer
          </button>
        </Card>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        {registerName} · this machine's drawer
      </div>

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
        <button className="btn" onClick={() => setPayout({ amount: '', reason: '' })}>Pay out</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setCounting(true)}>Count and close</button>
      </div>

      <div className="card card-scroll">
        <table>
          <thead><tr><th>Time</th><th>What</th><th>Method</th><th className="r">In</th><th className="r">Out</th></tr></thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="num">{m.created_at.slice(11, 16)}</td>
                <td>
                  {m.source_type.replace(/_/g, ' ')}
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
            <button className="btn primary" onClick={() => void recordPayout()}>Record</button>
          </>}
        >
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
            <button className="btn primary" onClick={() => void doClose()}>Close drawer</button>
          </>}
        >
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
