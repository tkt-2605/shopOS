import { useEffect, useState } from 'react'
import {
  Money, Quantity, Permissions,
  listBills, loadBillDetail, cancelBill,
  type BillListItem, type BillDetail,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import { Modal, Empty, Alert, Rupees, DocStatusBadge } from '../ui/components'

export default function Bills() {
  const { db } = useCore()
  const user = useUser()
  const [bills, setBills] = useState<BillListItem[]>([])
  const [open, setOpen] = useState<BillDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canCancel = Permissions.can(user.permissions, 'bill', 'cancel')

  async function refresh() {
    setBills(await listBills(db, { limit: 100 }))
  }

  useEffect(() => { void refresh() }, [db])

  async function doCancel(billId: string) {
    setError(null)
    const reason = window.prompt('Why is this bill being cancelled?')
    if (reason === null) return

    const result = await cancelBill(db, { billId, reason, actorId: user.id })
    if (!result.ok) {
      setError(
        result.code === 'HAS_RETURNS'
          ? `This bill has ${result.returnCount} return(s) against it. Cancel those first.`
          : `Payments have been recorded against this bill. Cancel those first.`,
      )
      return
    }
    setOpen(null)
    await refresh()
  }

  return (
    <>
      {error && <div style={{ marginBottom: 14 }}><Alert>{error}</Alert></div>}

      <div className="card card-scroll">
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Cashier</th>
              <th className="r">Credit</th>
              <th className="r">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className="pickable" onClick={() => void loadBillDetail(db, b.id).then(setOpen)}>
                <td className="num">{b.docNo}</td>
                <td className="num">{b.postingDate}</td>
                <td>{b.customerName ?? <span style={{ color: 'var(--ink-3)' }}>Walk-in</span>}</td>
                <td>{b.createdBy ?? '—'}</td>
                <td className="r">
                  {b.creditTotal > 0 ? <Rupees value={b.creditTotal} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="r"><Rupees value={b.grandTotal} /></td>
                <td><DocStatusBadge status={b.docstatus} /></td>
              </tr>
            ))}
            {bills.length === 0 && <tr><td colSpan={7}><Empty>No bills yet</Empty></td></tr>}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal
          wide
          title={open.docNo}
          onClose={() => setOpen(null)}
          footer={
            <>
              {canCancel && open.docstatus === 1 && (
                <button className="btn danger" onClick={() => void doCancel(open.id)}>Cancel bill</button>
              )}
              <button className="btn" onClick={() => setOpen(null)}>Close</button>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <DocStatusBadge status={open.docstatus} />
            <span style={{ color: 'var(--ink-3)' }}>{open.postingDate}</span>
            <span>{open.customerName ?? 'Walk-in'}</span>
          </div>

          {open.cancelReason && <Alert kind="warn">Cancelled: {open.cancelReason}</Alert>}

          <table>
            <thead>
              <tr>
                <th>Item</th><th>HSN</th>
                <th className="r">Qty</th><th className="r">Rate</th>
                <th className="r">Taxable</th><th className="r">GST</th><th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {open.items.map((i) => (
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
                  <td className="r"><Rupees value={i.rate} /></td>
                  <td className="r"><Rupees value={i.taxableValue} /></td>
                  <td className="r"><Rupees value={i.cgst + i.sgst + i.igst} /></td>
                  <td className="r"><Rupees value={i.lineTotal} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: 260 }}>
              <div className="total-line"><span>Subtotal</span><Rupees value={open.subtotal} /></div>
              {open.discount > 0 && <div className="total-line"><span>Discount</span><Rupees value={open.discount} /></div>}
              <div className="total-line"><span>Taxable</span><Rupees value={open.taxableTotal} /></div>
              <div className="total-line"><span>GST</span><Rupees value={open.taxTotal} /></div>
              <div className="total-line grand"><span>Total</span><Rupees value={open.grandTotal} /></div>
            </div>
          </div>

          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            Paid by {open.payments.map((p) => `${p.method} ${Money.formatWithSymbol(p.amount)}`).join(', ') || '—'}
          </div>
        </Modal>
      )}
    </>
  )
}
