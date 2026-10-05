import { useState } from 'react'
import {
  Quantity, submitDocument, cancelDocument, quotationToSalesOrder, receivePurchaseOrder,
  documentToCart, periodClosedMessage, type DocumentDetail,
} from '@shopos/core'
import { useCore } from '../../core/CoreProvider'
import { printDocumentSheet } from '../../core/printHtml'
import { requestRepeat } from '../../core/repeat'
import { Field, Modal, Alert, Rupees, DocStatusBadge } from '../components'
import type { DeskConfig } from './types'

export function Detail({ doc, config, canCancel, canWrite, canBill, onClose, onChanged, onError, userId }: {
  doc: DocumentDetail
  config: DeskConfig
  canCancel: boolean
  canWrite: boolean
  canBill: boolean
  onClose: () => void
  onChanged: (message: string) => void
  onError: (message: string | null) => void
  userId: string
}) {
  const { db } = useCore()
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const label = config.labels[doc.kind]!
  const isDraft = doc.docstatus === 0
  const isIssued = doc.docstatus === 1
  const anythingLeft = doc.items.some((i) => i.remainingQty > 0)
  /**
   * Whether anything has been billed or received against this yet.
   *
   * `cancelDocument` refuses outright once any line has been acted on, so
   * offering the button in that state was offering a button that could not
   * work: pressing it opened a box, asked for a reason, took the reason, and
   * then refused. The refusal was correct and arrived three steps too late.
   */
  const untouched = doc.progress === 'open'

  async function print() {
    onError(null)
    const result = await printDocumentSheet(db, doc.id)
    if (!result.ok) onError(result.message)
  }

  async function issue() {
    setBusy(true)
    const result = await submitDocument(db, { documentId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) { onError('That document could not be issued.'); return }
    onChanged(`${label.name} ${doc.docNo} issued.`)
  }

  async function toOrder() {
    setBusy(true)
    const result = await quotationToSalesOrder(db, { quotationId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'EXPIRED' ? 'That quotation is past its valid-until date. Raise a fresh one at today’s prices.'
        : result.code === 'NOTHING_LEFT' ? 'Every line on that quotation has already been ordered.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue the quotation first.'
        : 'That quotation could not be turned into an order.',
      )
      return
    }
    onChanged(`Sales order ${result.docNo} raised from ${doc.docNo}, at the quoted rates.`)
  }

  /**
   * Puts what is still outstanding on the counter, at the rates that were
   * promised.
   *
   * It creates nothing. The order is marked off when the bill is paid, not when
   * the cart is loaded — a cashier who is interrupted halfway has delivered
   * nothing, and an order the shop believes it has already sent out is worse
   * than one that says nothing at all.
   */
  async function bill() {
    setBusy(true)
    const result = await documentToCart(db, { documentId: doc.id })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'EXPIRED' ? 'That quotation is past its valid-until date. Raise a fresh one at today’s prices.'
        : result.code === 'NOTHING_LEFT' ? 'Everything on this has already been billed.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue it first.'
        : 'That could not be put on the counter.',
      )
      return
    }
    /* The counter claims this as it mounts; the shell is what switches to it.
       Closing first so the cashier arrives at the till, not at a dialog. */
    onClose()
    requestRepeat({
      docNo: result.docNo,
      customerId: result.customerId,
      order: { id: result.documentId, docNo: result.docNo },
      lines: result.lines.map((l) => ({
        productId: l.productId,
        saleUnit: l.saleUnit,
        qty: Quantity.toUnits(l.qty),
        rate: l.rate,
        includesTax: l.includesTax,
      })),
    })
  }

  async function receive() {
    setBusy(true)
    const result = await receivePurchaseOrder(db, { purchaseOrderId: doc.id, actorId: userId })
    setBusy(false)
    if (!result.ok) {
      onError(
        result.code === 'NOTHING_LEFT' ? 'Everything on that order has already been received.'
        : result.code === 'NOT_SUBMITTED' ? 'Issue the order first.'
        : result.code === 'PERIOD_CLOSED' ? periodClosedMessage(result.closedThrough)
        : 'Those goods could not be received.',
      )
      return
    }
    onChanged(`Received into stock at the ordered cost.`)
  }

  async function cancel() {
    if (!cancelling?.trim()) return
    setBusy(true)
    const result = await cancelDocument(db, { documentId: doc.id, reason: cancelling.trim(), actorId: userId })
    setBusy(false)
    setCancelling(null)
    if (!result.ok) {
      onError(
        /* Two different situations and two different ways out. Part-done has a
           remainder somebody may still want; all-done has none, and telling a
           shopkeeper that "part of this has been delivered" when all of it has
           sends them looking for a missing part that does not exist. */
        result.code === 'FULLY_FULFILLED'
          ? `Everything on this ${label.name.toLowerCase()} has already been billed, so there is nothing left to cancel.`
        : result.code === 'PARTLY_FULFILLED'
          ? 'Part of this has already been delivered or received, so it cannot be cancelled. Raise a fresh one for the remainder instead.'
        : 'That document could not be cancelled.',
      )
      return
    }
    onChanged(`${label.name} ${doc.docNo} cancelled.`)
  }

  return (
    <Modal
      title={`${label.name} ${doc.docNo}`}
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={() => void print()}>Print</button>
        {isDraft && canWrite && (
          <button className="btn primary" disabled={busy} onClick={() => void issue()}>Issue</button>
        )}
        {isIssued && canCancel && untouched && (
          <button className="btn" disabled={busy} onClick={() => setCancelling('')}>Cancel it</button>
        )}
        {isIssued && anythingLeft && canWrite && doc.kind === 'quotation' && (
          <button className="btn" disabled={busy} onClick={() => void toOrder()}>Make a sales order</button>
        )}
        {isIssued && anythingLeft && canBill && config.party === 'customer' && (
          <button className="btn primary" disabled={busy} onClick={() => void bill()}>Bill it</button>
        )}
        {isIssued && anythingLeft && canWrite && doc.kind === 'purchase_order' && (
          <button className="btn primary" disabled={busy} onClick={() => void receive()}>Receive into stock</button>
        )}
      </>}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5, marginBottom: 10 }}>
        <span><span style={{ color: 'var(--ink-3)' }}>Date </span>{doc.postingDate}</span>
        <span>
          <span style={{ color: 'var(--ink-3)' }}>{config.party === 'supplier' ? 'Supplier ' : 'Customer '}</span>
          {doc.partyName ?? 'Not recorded'}
        </span>
        {doc.validUntil && <span><span style={{ color: 'var(--ink-3)' }}>Valid until </span>{doc.validUntil}</span>}
        <span><DocStatusBadge status={doc.docstatus} /></span>
      </div>

      {doc.cancelReason && <Alert kind="warn">Cancelled: {doc.cancelReason}</Alert>}

      {/* Why the Cancel button is not there, said once, where somebody looking
          for it would look. A control that silently disappears is a control the
          shopkeeper assumes they have lost a permission for. */}
      {isIssued && !untouched && (
        <Alert kind="ok">
          {anythingLeft
            ? `Part of this has been ${config.party === 'supplier' ? 'received' : 'billed'} already, so it can no longer be cancelled. Raise a fresh ${label.name.toLowerCase()} for what is left.`
            : `Everything on this has been ${config.party === 'supplier' ? 'received' : 'billed'}. It is finished, and there is nothing left to cancel.`}
        </Alert>
      )}
      {doc.notes && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 8 }}>{doc.notes}</div>}

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="r">Ordered</th>
            <th className="r">{doc.kind === 'purchase_order' ? 'Received' : 'Billed'}</th>
            <th className="r">Left</th>
            <th className="r">Rate</th>
            <th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((i) => (
            <tr key={i.id}>
              <td>{i.productName}<div className="src">{i.saleUnit}</div></td>
              <td className="r num">{Quantity.formatQty(i.qty)}</td>
              <td className="r num">{Quantity.formatQty(i.fulfilledQty)}</td>
              <td className="r num">{Quantity.formatQty(i.remainingQty)}</td>
              <td className="r"><Rupees value={i.rate} /></td>
              <td className="r"><Rupees value={i.lineTotal} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={5} className="r">Total</th>
            <th className="r"><Rupees value={doc.grandTotal} /></th>
          </tr>
        </tfoot>
      </table>

      {cancelling !== null && (
        <div style={{ marginTop: 12 }}>
          <Field label="Why is it being cancelled?" hint="Kept against the document, so the reason is answerable later.">
            <input className="input" id="doc-cancel-reason" autoFocus value={cancelling}
              onChange={(e) => setCancelling(e.target.value)} placeholder="The school went elsewhere" />
          </Field>
          <button className="btn" disabled={busy || cancelling.trim() === ''} onClick={() => void cancel()}>
            Cancel this {label.name.toLowerCase()}
          </button>
        </div>
      )}
    </Modal>
  )
}
