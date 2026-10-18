import { useEffect, useState } from 'react'
import { billEmailNote, retryBillEmail, type BillEmailNote } from '@shopos/core'
import { useCore } from '../core/CoreProvider'

/**
 * Whether this bill was emailed to its customer, on the main till that sends
 * them (`core/billMail.ts`). Nothing on a till that never sent it, and nothing
 * for a customer nobody ticked.
 */
export function BillEmailLine({ billId }: { billId: string }) {
  const { db } = useCore()
  const [note, setNote] = useState<BillEmailNote | null>(null)

  useEffect(() => {
    let live = true
    void billEmailNote(db, billId).then((n) => { if (live) setNote(n) })
    return () => { live = false }
  }, [db, billId])

  if (!note) return null
  const when = new Date(note.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

  if (note.error) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--warn)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>Not emailed to {note.to}: {note.error}</span>
        <button className="btn ghost sm" onClick={() => void retryBillEmail(db, billId).then(() => setNote(null))}>
          Try again
        </button>
      </div>
    )
  }
  return (
    <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
      Emailed to {note.to}, {when}
    </div>
  )
}
