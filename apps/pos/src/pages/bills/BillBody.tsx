import { Money, Quantity, type BillDetail, type ReturnListItem } from '@shopos/core'
import { Alert, Rupees, DocStatusBadge } from '../../ui/components'
import { Attachments } from '../../ui/Attachments'

/**
 * One bill as it was issued: its lines, its totals, how it was paid, the goods
 * that have come back against it, and the photographs kept with it.
 *
 * What can be done to the bill lives on the dialog's footer, which belongs to
 * the page; this is the part that is read.
 */
export function BillBody({
  bill, returns, canUnreturn, canAttach, onCreditNote, onUndoReturn, onAttachmentsChange,
}: {
  bill: BillDetail
  returns: ReturnListItem[]
  canUnreturn: boolean
  canAttach: boolean
  onCreditNote: (returnId: string) => void
  onUndoReturn: (returnId: string, docNo: string) => void
  onAttachmentsChange: () => void
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <DocStatusBadge status={bill.docstatus} />
        <span style={{ color: 'var(--ink-3)' }}>{bill.postingDate}</span>
        <span>{bill.customerName ?? 'Walk-in'}</span>
      </div>

      {bill.cancelReason && <Alert kind="warn">Cancelled: {bill.cancelReason}</Alert>}

      <table>
        <thead>
          <tr>
            <th>Item</th><th>HSN</th>
            <th className="r">Qty</th><th className="r">Rate</th>
            <th className="r">Taxable</th><th className="r">GST</th><th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.items.map((i) => (
            <tr key={i.id}>
              <td>
                {i.productName}
                {i.returnedQty > 0 && (
                  <span className="badge warn" style={{ marginLeft: 6 }}>
                    {Quantity.formatQty(i.returnedQty)} returned
                  </span>
                )}
                <div className="src">{i.priceSource.replace(/_/g, ' ')}</div>
              </td>
              <td className="num">{i.hsnCode ?? '—'}</td>
              <td className="r num">{Quantity.formatQty(i.qty)} {i.saleUnit}</td>
              <td className="r">
                <Rupees value={i.rate} />
                {!i.rateIncludesTax && <div className="src">before tax</div>}
              </td>
              <td className="r"><Rupees value={i.taxableValue} /></td>
              <td className="r"><Rupees value={i.cgst + i.sgst + i.igst + i.cess} /></td>
              <td className="r"><Rupees value={i.lineTotal} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: 260 }}>
          <div className="total-line"><span>Subtotal</span><Rupees value={bill.subtotal} /></div>
          {bill.discount > 0 && <div className="total-line"><span>Discount</span><Rupees value={bill.discount} /></div>}
          <div className="total-line"><span>Taxable</span><Rupees value={bill.taxableTotal} /></div>
          <div className="total-line"><span>GST</span><Rupees value={bill.taxTotal} /></div>
          <div className="total-line grand"><span>Total</span><Rupees value={bill.grandTotal} /></div>
        </div>
      </div>

      <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
        Paid by {bill.payments.map((p) => `${p.method} ${Money.formatWithSymbol(p.amount)}`).join(', ') || '—'}
      </div>

      {returns.length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Goods taken back</div>
          <table>
            <thead>
              <tr>
                <th>Number</th><th>Date</th><th>Why</th>
                <th className="r">Goods</th><th className="r">Paid back</th><th />
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    {r.docNo}
                    {r.docstatus === 2 && <span className="badge" style={{ marginLeft: 6 }}>cancelled</span>}
                  </td>
                  <td className="num">{r.postingDate}</td>
                  <td style={{ color: 'var(--ink-3)' }}>{r.reason ?? '—'}</td>
                  <td className="r"><Rupees value={r.refundTotal} /></td>
                  <td className="r">
                    <Rupees value={r.refundCash} />
                    {r.refundMethod === 'credit' && <div className="src">off the khata</div>}
                    {r.pointsRestored > 0 && <div className="src">+ {r.pointsRestored} points</div>}
                  </td>
                  <td className="r">
                    {r.docstatus === 1 && (
                      <button className="btn ghost sm" onClick={() => onCreditNote(r.id)}>
                        Credit note
                      </button>
                    )}
                    {canUnreturn && r.docstatus === 1 && (
                      <button
                        className="btn ghost sm" style={{ marginLeft: 6 }}
                        onClick={() => onUndoReturn(r.id, r.docNo)}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Attachments entity="bill" entityId={bill.id} canEdit={canAttach} onChange={onAttachmentsChange} />
    </>
  )
}
