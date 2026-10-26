import { useCallback, useEffect, useState } from 'react'
import { Permissions, Quantity, documentToCart } from '@shopos/core'
import {
  answersOnlineOrders, ordersForShop, reviewWebOrder, acceptWebOrder, rejectWebOrder, markWebOrder, cancelWebOrder, verifyPhone,
  type ShopWebOrder, type ShopOrderFilter, type ReviewLine, type WebOrderStatus,
} from '@shopos/core/web'
import { useCore, useUser } from '../core/CoreProvider'
import { requestRepeat } from '../core/repeat'
import { openWhatsApp } from '../core/webHost'
import { Alert, Card, Empty, Field, Modal, Rupees } from './components'

/**
 * Orders from the storefront, as the shop answers them.
 *
 * A pending order is a request with the prices the customer saw. Accepting it
 * raises an ordinary sales order priced by the till; from then on it is billed
 * like any other with "Bill it", and the customer's phone reads it as
 * collected once every line is billed. Only the main till takes answers --
 * the services refuse anywhere else (`answersOnlineOrders`), and the buttons
 * are not offered -- but every till sees the orders and any counter can bill one.
 */

const STATUS: Record<WebOrderStatus, string> = {
  pending: 'Waiting for you',
  accepted: 'Accepted',
  packing: 'Being packed',
  ready: 'Ready to collect',
  collected: 'Collected',
  rejected: 'Turned away',
  cancelled: 'Cancelled',
}

const FILTERS: { id: ShopOrderFilter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'open', label: 'Not collected' },
  { id: 'done', label: 'Finished' },
  { id: 'all', label: 'All' },
]

const REFRESH_MS = 20_000

export function OnlineOrders() {
  const { db } = useCore()
  const [filter, setFilter] = useState<ShopOrderFilter>('waiting')
  const [rows, setRows] = useState<ShopWebOrder[]>([])
  const [open, setOpen] = useState<ShopWebOrder | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows(await ordersForShop(db, filter))
  }, [db, filter])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1000 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        Orders placed on the storefront, to collect and pay at the counter. Accepting one makes it a
        sales order at today’s prices; nothing is set aside on the shelf, so check it is there first.
      </div>
      <Card>
        <div className="segment">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </Card>
      <div className="card card-scroll">
        <table>
          <thead>
            <tr><th>Order</th><th>Placed</th><th>Customer</th><th>State</th><th className="r">Total</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                <td>W-{r.orderNo}</td>
                <td>{new Date(r.placedAt).toLocaleString()}</td>
                <td>{r.contactName} <span className="src">{r.contactPhone}</span></td>
                <td>
                  {STATUS[r.status]}
                  {r.cancelRequested && r.status !== 'cancelled' && <span className="src"> · asked to cancel</span>}
                  {r.overdue && <span className="src"> · overdue</span>}
                </td>
                <td className="r"><Rupees value={r.tillTotal ?? r.seenTotal} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5}><Empty>No orders here</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <OrderDetail
          order={open}
          onClose={() => setOpen(null)}
          onDone={(message) => { setOpen(null); setNotice(message); setError(null); void refresh() }}
          onError={setError}
        />
      )}
    </div>
  )
}

function OrderDetail({ order, onClose, onDone, onError }: {
  order: ShopWebOrder
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string | null) => void
}) {
  const { db, registerId } = useCore()
  const user = useUser()
  const [isMain, setIsMain] = useState(true)
  useEffect(() => { void answersOnlineOrders(db).then(setIsMain) }, [db])
  const canAnswer = isMain && Permissions.can(user.permissions, 'document', 'create')
  const canCancel = isMain && Permissions.can(user.permissions, 'document', 'cancel')
  const canBill = Permissions.can(user.permissions, 'bill', 'create')
  const canCheckPhone = Permissions.can(user.permissions, 'customer', 'write')
  const [lines, setLines] = useState<ReviewLine[] | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void reviewWebOrder(db, order.id).then((r) => setLines(r?.lines ?? null))
  }, [db, order.id])

  async function act(work: () => Promise<string | null>) {
    setBusy(true)
    onError(null)
    try {
      const done = await work()
      if (done) onDone(done)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const accept = () => act(async () => {
    const r = await acceptWebOrder(db, { webOrderId: order.id, actorId: user.id, registerId })
    if (r.ok) return `W-${order.orderNo} accepted as ${r.docNo}.`
    onError(r.code === 'NOT_THE_MAIN' ? 'Answer online orders on the main till.'
      : r.code === 'NOT_PENDING' ? 'It has already been answered.'
      : r.code === 'UNKNOWN_PRODUCT' ? 'An item on it no longer exists.'
      : `It could not be accepted (${r.code}).`)
    return null
  })

  const reject = () => act(async () => {
    const r = await rejectWebOrder(db, { webOrderId: order.id, actorId: user.id, reason })
    if (r.ok) return `W-${order.orderNo} turned away.`
    onError(r.code === 'REASON_REQUIRED' ? 'Say why, so the customer knows.' : 'It has already been answered.')
    return null
  })

  const mark = (to: 'packing' | 'ready') => act(async () => {
    const r = await markWebOrder(db, { webOrderId: order.id, actorId: user.id, to })
    return r.ok ? `W-${order.orderNo} is ${to === 'ready' ? 'ready to collect' : 'being packed'}.` : null
  })

  const cancel = () => act(async () => {
    const r = await cancelWebOrder(db, { webOrderId: order.id, actorId: user.id, reason })
    if (r.ok) return `W-${order.orderNo} cancelled.`
    onError(r.code === 'REASON_REQUIRED' ? 'Say why, so the customer knows.'
      : r.code === 'ALREADY_BILLED' ? 'Some of it has been billed. Cancel or return the bill first.'
      : 'It cannot be cancelled now.')
    return null
  })

  const checkPhone = () => act(async () => {
    const r = await verifyPhone(db, { accountId: order.accountId, actorId: user.id })
    return r.ok ? `${order.contactPhone} checked with the customer.` : null
  })

  const bill = () => act(async () => {
    if (!order.documentId) return null
    const result = await documentToCart(db, { documentId: order.documentId })
    if (!result.ok) {
      onError(result.code === 'NOTHING_LEFT' ? 'Everything on it has already been billed.' : 'It could not be put on the counter.')
      return null
    }
    onClose()
    requestRepeat({
      docNo: result.docNo,
      customerId: result.customerId,
      order: { id: result.documentId, docNo: result.docNo },
      lines: result.lines.map((l) => ({
        productId: l.productId, saleUnit: l.saleUnit, qty: Quantity.toUnits(l.qty), rate: l.rate, includesTax: l.includesTax,
      })),
    })
    return null
  })

  const whatsapp = () => {
    const text = order.status === 'ready'
      ? `Your order W-${order.orderNo} is ready to collect.`
      : `About your order W-${order.orderNo}:`
    void openWhatsApp(order.contactPhone, text).catch((err: unknown) => onError(String(err)))
  }

  const waiting = order.status === 'pending'
  const live = order.status === 'accepted' || order.status === 'packing' || order.status === 'ready'

  return (
    <Modal
      title={`W-${order.orderNo} · ${STATUS[order.status]}`}
      onClose={onClose}
      wide
      footer={(
        <>
          <button className="btn" onClick={whatsapp}>WhatsApp</button>
          <div className="spacer" />
          {waiting && canAnswer && <button className="btn" disabled={busy} onClick={() => void reject()}>Turn away</button>}
          {waiting && canAnswer && <button className="btn primary" disabled={busy} onClick={() => void accept()}>Accept</button>}
          {live && canCancel && <button className="btn" disabled={busy} onClick={() => void cancel()}>Cancel order</button>}
          {order.status === 'accepted' && canAnswer && <button className="btn" disabled={busy} onClick={() => void mark('packing')}>Packing</button>}
          {(order.status === 'accepted' || order.status === 'packing') && canAnswer && (
            <button className="btn" disabled={busy} onClick={() => void mark('ready')}>Ready</button>
          )}
          {live && canBill && <button className="btn primary" disabled={busy} onClick={() => void bill()}>Bill it</button>}
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <strong>{order.contactName}</strong> · {order.contactPhone}
          {order.account?.phoneVerified
            ? <span className="src"> · phone checked</span>
            : canCheckPhone && (
              <button className="btn" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void checkPhone()}>
                Phone checked with customer
              </button>
            )}
          {order.account?.email && <div className="src">{order.account.email}</div>}
        </div>
        {order.note && <div>“{order.note}”</div>}
        {!isMain && (waiting || live) && (
          <div className="src">Accept, turn away and mark ready on the main till. You can bill it here.</div>
        )}
        {order.cancelRequested && live && <Alert kind="warn">The customer has asked to cancel this order.</Alert>}
        {order.reason && <div className="src">Reason: {order.reason}</div>}

        <table>
          <thead>
            <tr><th>Item</th><th className="r">Qty</th><th className="r">They saw</th><th className="r">Till price</th><th className="r">On hand</th></tr>
          </thead>
          <tbody>
            {(lines ?? order.lines.map((l) => ({ ...l, tillPrice: l.seenPrice, onHand: 0, listed: true }))).map((l, i) => (
              <tr key={i}>
                <td>{l.name} <span className="src">{l.unit}</span>{!l.listed && <span className="src"> · no longer listed</span>}</td>
                <td className="r">{l.qty}</td>
                <td className="r"><Rupees value={l.seenPrice} /></td>
                <td className="r" style={l.tillPrice !== l.seenPrice ? { fontWeight: 600 } : undefined}><Rupees value={l.tillPrice} /></td>
                <td className="r">{lines ? Quantity.toUnits(l.onHand as never) : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="r">
          They saw <Rupees value={order.seenTotal} />
          {order.tillTotal !== null && <> · accepted at <Rupees value={order.tillTotal} /></>}
        </div>

        {(waiting || live) && (canAnswer || canCancel) && (
          <Field label="Reason (to turn away or cancel)" hint="The customer sees this on their phone.">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Out of stock" />
          </Field>
        )}
      </div>
    </Modal>
  )
}
