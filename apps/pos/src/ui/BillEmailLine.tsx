import { useEffect, useState } from 'react'
import {
  billDueForEmail, billEmailNote, retryBillEmail, sendsBillEmails, type BillEmailNote,
} from '@shopos/core'
import { useCore } from '../core/CoreProvider'
import { billMailReady } from '../core/billMail'

/**
 * Whether this bill was emailed to its customer, on the main till that sends
 * them (`core/billMail.ts`): when it went, why it could not, or -- for a bill
 * still due -- what it is waiting for. Nothing for a customer nobody ticked,
 * and nothing on a counter, which never sends.
 */
type Shown =
  | { kind: 'note'; note: BillEmailNote }
  | { kind: 'due'; to: string; waitingFor: string | null }

export function BillEmailLine({ billId }: { billId: string }) {
  const { db } = useCore()
  const [shown, setShown] = useState<Shown | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      const note = await billEmailNote(db, billId)
      if (note) return { kind: 'note', note } as const
      if (!(await sendsBillEmails(db))) return null
      const to = await billDueForEmail(db, billId)
      if (to === null) return null
      return { kind: 'due', to, waitingFor: await billMailReady() } as const
    })().then((s) => { if (live) setShown(s) })
    return () => { live = false }
  }, [db, billId, round])

  if (!shown) return null

  if (shown.kind === 'due') {
    return shown.waitingFor
      ? <div style={{ fontSize: 12.5, color: 'var(--warn)' }}>Not emailed to {shown.to} yet: {shown.waitingFor}</div>
      : <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Will be emailed to {shown.to} within two minutes.</div>
  }

  const { note } = shown
  if (note.error) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--warn)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>Not emailed to {note.to}: {note.error}</span>
        <button className="btn ghost sm" onClick={() => void retryBillEmail(db, billId).then(() => setRound((r) => r + 1))}>
          Try again
        </button>
      </div>
    )
  }
  const when = new Date(note.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  return <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Emailed to {note.to}, {when}</div>
}
