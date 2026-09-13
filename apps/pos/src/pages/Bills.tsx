import { useCallback, useEffect, useState } from 'react'
import {
  Money, Quantity, Permissions,
  listBills, countBills, loadBillDetail, cancelBill, listReturns, cancelReturn,
  type BillListItem, type BillDetail, type ReturnListItem, type BillStatusFilter,
} from '@shopos/core'
import { useCore, useUser } from '../core/CoreProvider'
import {
  Modal, Empty, Alert, Rupees, DocStatusBadge, DateRangePicker, rangePreset, type Range,
} from '../ui/components'
import { printBill } from '../core/print'
import { Attachments } from '../ui/Attachments'
import { ReturnSheet } from '../ui/ReturnSheet'
import { usePickList } from '../ui/PickList'
import { requestRepeat } from '../core/repeat'
import { countAttachments } from '@shopos/core'

/** A page of bills. Enough to scroll, few enough that the query stays quick. */
const PAGE = 50

const STATUSES: { id: BillStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'returned', label: 'Returned' },
  { id: 'credit', label: 'On credit' },
]

export default function Bills() {
  const { db } = useCore()
  const user = useUser()
  const [bills, setBills] = useState<BillListItem[]>([])
  const [total, setTotal] = useState(0)
  const [open, setOpen] = useState<BillDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  /* A month, not everything. A shop three years in has tens of thousands of
     bills and the answer to "where is that bill" is almost always recent. */
  const [range, setRange] = useState<Range>(() => rangePreset('month'))
  const [status, setStatus] = useState<BillStatusFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const canCancel = Permissions.can(user.permissions, 'bill', 'cancel')
  // Evidence is not the document: a cancelled bill can still gain the
  // photograph that explains why it was cancelled.
  const canAttach = Permissions.can(user.permissions, 'bill', 'write')
  const canReturn = Permissions.can(user.permissions, 'sales_return', 'create')
    && Permissions.can(user.permissions, 'sales_return', 'submit')
  const canUnreturn = Permissions.can(user.permissions, 'sales_return', 'cancel')
  const canSell = Permissions.can(user.permissions, 'bill', 'create')
  const [photos, setPhotos] = useState<Map<string, number>>(new Map())
  const [returning, setReturning] = useState(false)
  const [returns, setReturns] = useState<ReturnListItem[]>([])
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const where = {
        from: range.from, to: range.to, status,
        ...(search.trim() ? { search: search.trim() } : {}),
      }
      const rows = await listBills(db, { ...where, limit: PAGE, offset: page * PAGE })
      setBills(rows)
      setTotal(await countBills(db, where))
      // One query for the page rather than one per row, and only to answer a
      // question the list cannot otherwise answer: is there a photograph on this
      // bill, without opening every one of them.
      setPhotos(await countAttachments(db, 'bill', rows.map((b) => b.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The bills could not be listed.')
    }
  }, [db, range.from, range.to, status, search, page])

  useEffect(() => { void refresh() }, [refresh])

  /* Changing what is being looked for puts you back at the first page. Staying
     on page four of a filter that now has one page shows an empty screen and no
     reason for it. */
  useEffect(() => { setPage(0) }, [range.from, range.to, status, search])

  useEffect(() => {
    if (!open) { setReturns([]); return }
    void listReturns(db, open.id).then(setReturns)
  }, [db, open])

  /**
   * The same again.
   *
   * Quantities and the customer carry over; the price does not. Every line is
   * re-priced at today's rates on the counter, so a bill from March cannot walk
   * back in at March's prices.
   */
  function sellAgain(bill: BillDetail) {
    requestRepeat({
      docNo: bill.docNo,
      customerId: bill.customerId ?? null,
      lines: bill.items.map((i) => ({
        productId: i.productId,
        saleUnit: i.saleUnit,
        qty: Quantity.toUnits(i.qty),
      })),
    })
    setOpen(null)
  }

  async function undoReturn(returnId: string, docNo: string) {
    if (!window.confirm(`Cancel ${docNo}? The goods go back out of stock and the refund is taken back.`)) return
    await cancelReturn(db, { returnId, actorId: user.id })
    if (open) {
      setOpen(await loadBillDetail(db, open.id))
      setReturns(await listReturns(db, open.id))
    }
    await refresh()
  }

  async function reprint(billId: string) {
    const result = await printBill(db, billId)
    if (result.ok) {
      setNote('Sent to the printer.')
      setTimeout(() => setNote(null), 5000)
      return
    }
    setError(result.message)
  }

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

  /* A hundred bills is a hundred tab stops unless the list is one. Arrows move
     down it, Enter opens the bill — the same keys as every other list here. */
  const pick = usePickList({
    count: bills.length,
    as: 'grid',
    onPick: (i) => {
      const row = bills[i]
      if (row) void loadBillDetail(db, row.id).then(setOpen)
    },
  })

  return (
    <>
      {error && <div style={{ marginBottom: 14 }}><Alert>{error}</Alert></div>}
      {note && (
        <div style={{ marginBottom: 14 }}>
          <Alert kind="ok">{note}</Alert>
        </div>
      )}

      <div className="filter-bar" style={{ marginBottom: 14 }}>
        <DateRangePicker value={range} onChange={setRange} />

        <div className="segment">
          {STATUSES.map((s) => (
            <button key={s.id} aria-selected={status === s.id} onClick={() => setStatus(s.id)}>
              {s.label}
            </button>
          ))}
        </div>

        <input
          className="input" style={{ width: 200 }} type="search"
          placeholder="Number or customer"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />

        <div style={{ flex: 1 }} />
        <span className="filter-count">
          {total === 0 ? 'Nothing here' : showing(page, bills.length, total)}
        </span>
      </div>

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
          <tbody {...pick.listProps}>
            {bills.map((b, i) => (
              <tr key={b.id} {...pick.rowProps(i)}>
                <td className="num">{b.docNo}</td>
                <td className="num">{b.postingDate}</td>
                <td>{b.customerName ?? <span style={{ color: 'var(--ink-3)' }}>Walk-in</span>}</td>
                <td>{b.createdBy ?? '—'}</td>
                <td className="r">
                  {b.creditTotal > 0 ? <Rupees value={b.creditTotal} /> : <span style={{ color: 'var(--ink-3)' }}>—</span>}
                </td>
                <td className="r"><Rupees value={b.grandTotal} /></td>
                <td>
                  <DocStatusBadge status={b.docstatus} />
                  {b.returned && (
                    <span className="badge warn" style={{ marginLeft: 6 }} title="Some goods came back">
                      returned
                    </span>
                  )}
                  {(photos.get(b.id) ?? 0) > 0 && (
                    <span className="badge" style={{ marginLeft: 6 }} title="Has photographs attached">
                      {photos.get(b.id)} photo{photos.get(b.id) === 1 ? '' : 's'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {bills.length === 0 && (
              <tr><td colSpan={7}><Empty>No bills match what you have asked for</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <div className="filter-bar" style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Newer
          </button>
          <button
            className="btn sm"
            disabled={(page + 1) * PAGE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Older
          </button>
          <span className="filter-count">Page {page + 1} of {Math.ceil(total / PAGE)}</span>
        </div>
      )}

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
              <span style={{ flex: 1 }} />
              {/* `printBill` has existed since v1 and had exactly one caller,
                  the counter. A customer who has lost their bill was, until
                  now, told to find it. */}
              <button className="btn" onClick={() => void reprint(open.id)}>Print again</button>
              {canSell && open.docstatus === 1 && (
                <button className="btn" onClick={() => sellAgain(open)}>Sell these again</button>
              )}
              {open.docstatus === 1 && anythingLeft(open) && (
                canReturn
                  ? <button className="btn" onClick={() => setReturning(true)}>Take goods back</button>
                  /* Said rather than hidden: a cashier who cannot refund should know
                     that is the reason, not wonder where the button went. */
                  : <button className="btn" disabled title="Taking goods back needs permission">
                      Take goods back
                    </button>
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
                        {canUnreturn && r.docstatus === 1 && (
                          <button className="btn ghost sm" onClick={() => void undoReturn(r.id, r.docNo)}>
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

          <Attachments entity="bill" entityId={open.id} canEdit={canAttach} onChange={() => void refresh()} />
        </Modal>
      )}

      {open && returning && (
        <ReturnSheet
          bill={open}
          onClose={() => setReturning(false)}
          onDone={async (message) => {
            setReturning(false)
            setNote(message)
            setTimeout(() => setNote(null), 8000)
            setOpen(await loadBillDetail(db, open.id))
            await refresh()
          }}
        />
      )}
    </>
  )
}

/** "1–50 of 214", or "214 bills" when they all fit. */
function showing(page: number, shown: number, total: number): string {
  if (total <= PAGE) return `${total} ${total === 1 ? 'bill' : 'bills'}`
  const first = page * PAGE + 1
  return `${first}–${first + shown - 1} of ${total}`
}

/** Whether anything on the bill has not already come back. */
function anythingLeft(bill: BillDetail): boolean {
  return bill.items.some((i) => i.qty - i.returnedQty > 0)
}
