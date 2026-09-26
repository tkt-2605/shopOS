import { useCore } from '../../core/CoreProvider'
import { printBill } from '../../core/print'
import { previewBillSheet } from '../../core/printHtml'
import { Modal, Alert, Rupees } from '../../ui/components'

/** A bill just taken: what it was numbered and what it came to. */
export interface CompletedBill {
  billId: string
  docNo: string
  total: number
  points: number
}

/** The bill is saved; this is where it is printed again or seen on A4. */
export function DoneDialog({ done, printMsg, onPrintMsg, onSheet, onNewBill, onClose }: {
  done: CompletedBill
  printMsg: string | null
  onPrintMsg: (message: string | null) => void
  onSheet: (sheet: { html: string; docNo: string }) => void
  onNewBill: () => void
  onClose: () => void
}) {
  const { db } = useCore()
  return (
    <Modal
      title="Bill complete"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={() => {
          void printBill(db, done.billId).then((r) => onPrintMsg(r.ok ? null : r.message))
        }}>Print again</button>
        {/* Over this dialog, with the counter untouched behind both. */}
        <button className="btn" onClick={() => {
          void previewBillSheet(db, done.billId).then((r) => {
            if (!r.ok) { onPrintMsg(r.message); return }
            onPrintMsg(null)
            onSheet({ html: r.html, docNo: r.docNo })
          })
        }}>A4 preview</button>
        <button className="btn primary" onClick={onNewBill}>New bill</button>
      </>}
    >
      <div style={{ fontSize: 15 }}>
        <strong className="num">{done.docNo}</strong>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700 }}><Rupees value={done.total} /></div>
      {done.points > 0 && <Alert kind="ok">{done.points} loyalty points earned</Alert>}
      {printMsg && <Alert kind="warn">{printMsg} The bill is saved — you can print it again.</Alert>}
    </Modal>
  )
}
