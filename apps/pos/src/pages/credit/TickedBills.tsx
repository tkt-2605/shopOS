import { useRef, useState } from 'react'
import { useCore } from '../../core/CoreProvider'
import { Modal } from '../../ui/components'
import { printBillsDue } from '../../core/print'
import { billsDuePdf } from '../../core/pdf'
import { printInvoices, type InvoicesProgress } from '../../core/printInvoices'

/*
 * What can be made from the bills ticked on a customer's account: the one
 * long bill, on the roll or as a PDF, and every ticked bill's own invoice in
 * one print window. References only: no payment is taken, no stock moves, nothing is
 * saved to the books.
 */

export function TickedBillsActions({ customerId, picked, onError, onChanged }: {
  customerId: string
  picked: string[]
  onError: (message: string | null) => void
  onChanged: (message: string) => Promise<void>
}) {
  const { db } = useCore()
  const none = picked.length === 0

  async function printOne() {
    onError(null)
    const result = await printBillsDue(db, customerId, picked)
    if (!result.ok) onError(result.message)
  }

  async function oneAsPdf() {
    onError(null)
    const result = await billsDuePdf(db, customerId, picked)
    if (!result.ok) { onError(result.message); return }
    await onChanged(`Bills due saved to ${result.path}`)
  }

  /* Every ticked bill's own invoice in one print window. It can be many
     pages, so a screen counts them while they are got ready and Cancel stops
     it between bills; the print window then has its own Cancel. */
  const [making, setMaking] = useState<InvoicesProgress | null>(null)
  const stop = useRef(false)

  async function invoices() {
    onError(null)
    stop.current = false
    setMaking({ done: 0, total: picked.length })
    try {
      const result = await printInvoices(db, customerId, picked, setMaking, () => stop.current)
      if (!result.ok && !('stopped' in result)) onError(result.message)
    } finally {
      setMaking(null)
    }
  }

  function cancel() {
    stop.current = true
  }

  return (
    <>
      <button className="btn sm" disabled={none} onClick={() => void printOne()}>Print as one bill</button>
      <button className="btn sm" disabled={none} onClick={() => void oneAsPdf()}>One bill as PDF</button>
      <button className="btn sm" disabled={none || making !== null} onClick={() => void invoices()}>Print all invoices</button>
      {making && (
        <Modal
          title="Getting the invoices ready"
          onClose={cancel}
          footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={cancel}>Cancel</button></>}
        >
          <InvoicesMaking progress={making} />
        </Modal>
      )}
    </>
  )
}

/** What the wait for the invoices shows: how many are ready. */
function InvoicesMaking({ progress }: { progress: InvoicesProgress }) {
  const done = progress.done
  const share = progress.total === 0 ? 0 : done / progress.total
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 320 }}>
      <div>
        {`Getting invoice ${progress.done + 1} of ${progress.total} ready…`}
      </div>
      <div style={{ height: 8, background: 'var(--rule-soft)' }} role="progressbar"
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={done}>
        <div style={{ height: '100%', width: `${Math.round(share * 100)}%`, background: 'var(--accent)' }} />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        The print window opens when they are all ready. Cancel stops it, and nothing is saved.
      </div>
    </div>
  )
}
