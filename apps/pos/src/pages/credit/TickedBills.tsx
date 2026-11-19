import { useRef, useState } from 'react'
import { useCore } from '../../core/CoreProvider'
import { Modal } from '../../ui/components'
import { printBillsDue } from '../../core/print'
import { billsDuePdf, invoicesPdf, cancelInvoicesPdf, type InvoicesProgress } from '../../core/pdf'

/*
 * What can be made from the bills ticked on a customer's account: the one
 * long bill, on the roll or as a PDF, and every ticked bill's own invoice in
 * one PDF. References only: no payment is taken, no stock moves, nothing is
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

  /* Every ticked bill's own invoice in one PDF. It can be many pages, so a
     screen counts them and Cancel stops it at any point: between bills here,
     or Edge itself once it is printing. */
  const [making, setMaking] = useState<InvoicesProgress | null>(null)
  const stop = useRef(false)

  async function invoices() {
    onError(null)
    stop.current = false
    setMaking({ stage: 'pages', done: 0, total: picked.length })
    try {
      const result = await invoicesPdf(db, customerId, picked, setMaking, () => stop.current)
      if (result.ok) await onChanged(`Invoices saved to ${result.path}`)
      else if (!('stopped' in result)) onError(result.message)
    } finally {
      setMaking(null)
    }
  }

  function cancel() {
    stop.current = true
    void cancelInvoicesPdf()
  }

  return (
    <>
      <button className="btn sm" disabled={none} onClick={() => void printOne()}>Print as one bill</button>
      <button className="btn sm" disabled={none} onClick={() => void oneAsPdf()}>One bill as PDF</button>
      <button className="btn sm" disabled={none || making !== null} onClick={() => void invoices()}>All invoices as one PDF</button>
      {making && (
        <Modal
          title="Making the PDF"
          onClose={cancel}
          footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={cancel}>Cancel</button></>}
        >
          <InvoicesMaking progress={making} />
        </Modal>
      )}
    </>
  )
}

/** What the wait for the invoices PDF shows: a count, then Edge at work. */
function InvoicesMaking({ progress }: { progress: InvoicesProgress }) {
  const done = progress.stage === 'pages' ? progress.done : progress.total
  const share = progress.total === 0 ? 0 : done / progress.total
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 320 }}>
      <div>
        {progress.stage === 'pages'
          ? `Getting invoice ${progress.done + 1} of ${progress.total} ready…`
          : `Printing ${progress.total} invoice${progress.total === 1 ? '' : 's'} into one PDF…`}
      </div>
      <div style={{ height: 8, background: 'var(--rule-soft)' }} role="progressbar"
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={done}>
        <div style={{ height: '100%', width: `${Math.round(share * 100)}%`, background: 'var(--accent)' }} />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
        The till goes on working. Cancel stops it, and nothing is saved.
      </div>
    </div>
  )
}
