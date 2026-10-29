import { useEffect, useState } from 'react'
import { answerChanges, myOrder, cancelOrder, type Order, type OrderStatus } from './api'
import { changesIn, type LineChange } from './shelf'
import { SignInPanel } from './cart'
import { PageHead } from './items'
import { addToCart, orderLabel, rupees } from './money'
import { againFrom } from './shelf'
import type { Shop } from './useShop'

/* A customer's orders, and one order followed step by step. */

const STATUS: Record<OrderStatus, string> = {
  pending: 'Order sent',
  accepted: 'Confirmed',
  packing: 'Packing',
  ready: 'Ready for pickup',
  collected: 'Completed',
  rejected: 'Not accepted',
  cancelled: 'Cancelled',
}

const SAY: Record<OrderStatus, string> = {
  pending: 'The shop has your order and will confirm it shortly.',
  accepted: 'The shop has accepted your order and confirmed the price.',
  packing: 'Your order is being packed.',
  ready: 'Your order is ready. Come to the counter, give your order number and pay there.',
  collected: 'Collected. Thank you for shopping with us.',
  rejected: 'The shop could not take this order.',
  cancelled: 'This order was cancelled.',
}

const STEPS: { key: OrderStatus; label: string; doing: string }[] = [
  { key: 'pending', label: 'Order sent', doing: 'Pickup order placed' },
  { key: 'accepted', label: 'Confirmed', doing: 'The shop confirmed the price' },
  { key: 'packing', label: 'Packed', doing: 'Being packed' },
  { key: 'ready', label: 'Ready for pickup', doing: 'Waiting at the counter' },
  { key: 'collected', label: 'Completed', doing: 'Collected and paid' },
]

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null

const isLive = (s: OrderStatus) => s === 'pending' || s === 'accepted' || s === 'packing' || s === 'ready'

/**
 * Each step with when it happened, or "Waiting". A shop that marks an order
 * ready without marking it packing has still been through packing, so a later
 * step fills in the ones before it.
 */
export function Tracker({ order }: { order: Order }) {
  if (order.status === 'rejected' || order.status === 'cancelled') {
    return (
      <ol className="timeline">
        <li className="done"><span className="dot" /><strong>Order sent</strong><small>{when(order.placedAt)}</small></li>
        <li className="stop"><span className="dot" /><strong>{STATUS[order.status]}</strong><small>{when(order.answeredAt) ?? ''}{order.reason ? ` · ${order.reason}` : ''}</small></li>
      </ol>
    )
  }
  const at = STEPS.findIndex((s) => s.key === order.status)
  const times: Partial<Record<OrderStatus, string | null>> = {
    pending: when(order.placedAt), accepted: when(order.answeredAt), packing: when(order.packingAt), ready: when(order.readyAt),
  }
  const rows = STEPS.map((s, i) => {
    const state = i < at || order.status === 'collected' ? 'done' : i === at ? 'now' : 'todo'
    return { key: s.key as string, label: s.label, state, detail: state === 'todo' ? 'Waiting' : [times[s.key], s.doing].filter(Boolean).join(' · ') }
  })
  /* The shop changed it: a step of its own, the customer's turn until they answer. */
  if (order.proposal) {
    rows[0]!.state = 'done'
    rows.splice(1, 0, { key: 'revised', label: 'Shop changed it — your turn', state: 'now', detail: `${when(order.proposal.at)} · review the changes below` })
  } else if (order.agreedAt) {
    rows.splice(1, 0, { key: 'revised', label: 'Shop changed it', state: 'done', detail: `${when(order.agreedAt)} · you took the changes` })
  }
  return (
    <ol className="timeline">
      {rows.map((r) => (
        <li key={r.key} className={r.state}>
          <span className="dot" />
          <strong>{r.label}</strong>
          <small>{r.detail}</small>
        </li>
      ))}
    </ol>
  )
}

function Pill({ order }: { order: Order }) {
  return order.proposal
    ? <span className="pill" data-status="revised">{order.seenTotal === 0 ? 'Quotation ready' : 'Review changes'}</span>
    : <span className="pill" data-status={order.status}>{STATUS[order.status]}</span>
}

const CHANGE: Record<LineChange['kind'], string> = {
  same: '', fewer: 'Fewer', more: 'More', removed: 'Taken off', added: 'Added',
}

/** The shop's changed list beside what was asked for, with the answer buttons. */
function Changes({ order, session, onAnswered }: { order: Order; session: string | null; onAnswered: (o: Order) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const proposal = order.proposal!
  const changes = changesIn(order.lines, proposal.lines)

  async function answer(take: boolean) {
    if (!session) return
    if (!take && !confirm('Cancel this order?')) return
    setBusy(true)
    setError(null)
    try {
      onAnswered((await answerChanges(session, order.id, take)).order)
    } catch {
      setError('That did not reach the shop. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="changes">
      <h2>{order.seenTotal === 0 ? 'Your quotation from the shop' : 'The shop changed your order'}</h2>
      {proposal.note && <p className="changes-note">“{proposal.note}”</p>}
      <ul>
        {changes.map((c, i) => (
          <li key={i} data-kind={c.kind}>
            <span className="what">
              <span className="name">{c.name}</span>
              <span className="muted">
                {c.kind === 'removed' ? <s>{c.from} {c.unit}</s>
                  : c.kind === 'added' ? <>{c.to} {c.unit} × {rupees(c.price)}</>
                  : c.from !== c.to ? <><s>{c.from}</s> → <strong>{c.to}</strong> {c.unit} × {rupees(c.price)}</>
                  : <>{c.to} {c.unit} × {rupees(c.price)}</>}
              </span>
            </span>
            {CHANGE[c.kind] && <span className="change-tag">{CHANGE[c.kind]}</span>}
          </li>
        ))}
      </ul>
      <div className="changes-total">
        <span>{order.seenTotal === 0 ? 'Total' : 'New total'}</span>
        <span>{order.seenTotal > 0 && <s className="muted">{rupees(order.seenTotal)}</s>} <strong>{rupees(proposal.total)}</strong></span>
      </div>
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary wide" disabled={busy} onClick={() => void answer(true)}>{order.seenTotal === 0 ? 'Accept quotation' : 'Accept changes'}</button>
      <button type="button" className="danger wide" disabled={busy} onClick={() => void answer(false)}>Cancel order</button>
    </div>
  )
}

export function Orders({ shop, onOpen }: { shop: Shop; onOpen: (id: string) => void }) {
  useEffect(() => { void shop.refreshOrders() }, [])
  if (shop.session === null) return <SignInPanel shop={shop} />
  const list = shop.orders?.orders ?? []
  const live = list.filter((o) => isLive(o.status))
  const past = list.filter((o) => !live.includes(o))
  return (
    <>
      <PageHead title="Orders" sub="Your pickup orders" />
      {shop.state !== 'open' && shop.state !== 'closed' && shop.orders && (
        <p className="saved">As of {new Date(shop.orders.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.</p>
      )}
      {live.length > 0 && <h2 className="section">In progress</h2>}
      {live.map((o) => <OrderCard key={o.id} order={o} onOpen={onOpen} />)}
      {past.length > 0 && <h2 className="section">Past orders</h2>}
      {past.map((o) => <OrderCard key={o.id} order={o} onOpen={onOpen} />)}
      {list.length === 0 && <p className="empty">No orders yet.</p>}
    </>
  )
}

function OrderCard({ order, onOpen }: { order: Order; onOpen: (id: string) => void }) {
  const items = order.lines.reduce((n, l) => n + l.qty, 0)
  return (
    <button type="button" className="order-card" onClick={() => onOpen(order.id)}>
      <span className="top">
        <strong>{orderLabel(order.orderNo)}</strong>
        <Pill order={order} />
      </span>
      <span className="top">
        <span className="muted">{when(order.placedAt)}</span>
        <strong>{(order.tillTotal ?? order.seenTotal) > 0 ? rupees(order.tillTotal ?? order.seenTotal) : 'Quotation'}</strong>
      </span>
      <span className="muted">{items} item{items === 1 ? '' : 's'} · Pay at pickup</span>
    </button>
  )
}

export function OrderView({ shop, id, go }: { shop: Shop; id: string; go: (to: string) => void }) {
  /* The copy kept on the phone, which may arrive a moment after the page opens, until the shop answers with a fresher one. */
  const kept = shop.orders?.orders.find((o) => o.id === id) ?? null
  const [fetched, setOrder] = useState<Order | null>(null)
  const order = fetched ?? kept
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!shop.session) return
    const fetchIt = () => { void myOrder(shop.session!, id).then((r) => setOrder(r.order)).catch(() => undefined) }
    fetchIt()
    const timer = setInterval(fetchIt, 30_000)
    return () => clearInterval(timer)
  }, [shop.session, id])

  if (!order) return <p className="empty">This order is not on this phone. It will show once the shop can be reached.</p>
  const live = isLive(order.status)
  const catalog = shop.held?.catalog

  async function cancel() {
    if (!shop.session || !confirm(order!.status === 'pending' ? 'Cancel this order?' : 'Ask the shop to cancel this order?')) return
    try {
      setOrder((await cancelOrder(shop.session, id)).order)
      void shop.refreshOrders()
    } catch {
      setError('It could not be cancelled just now.')
    }
  }

  return (
    <>
      <button type="button" className="link-button" onClick={() => go('/orders')}>← Orders</button>
      <div className="order-title">
        <div>
          <h1>{orderLabel(order.orderNo)}</h1>
          <p className="sub">{when(order.placedAt)}</p>
        </div>
        <Pill order={order} />
      </div>
      <p className="say">
        {order.proposal ? 'The shop could not fill your order exactly and has sent it back changed. Take the changes or cancel.'
          : order.status === 'pending' && order.agreedAt ? 'You took the shop’s changes. The shop will confirm shortly.'
          : SAY[order.status]}
      </p>
      {order.proposal && <Changes order={order} session={shop.session} onAnswered={(o) => { setOrder(o); void shop.refreshOrders() }} />}
      {order.cancelRequested && live && <p className="notice">You asked to cancel. The shop will confirm.</p>}
      {order.status === 'ready' && (
        <div className="collect-code">
          <span>Show this at the counter</span>
          <span className="code">#{order.orderNo}</span>
        </div>
      )}
      <Tracker order={order} />

      <h2 className="section">{order.proposal ? 'What you first asked for' : 'Items'}</h2>
      <ul className="order-lines">
        {order.lines.map((l, i) => (
          <li key={i}>
            <span className="what">
              <span className="name">{l.name}</span>
              <span className="muted">{l.qty} {l.unit}{l.seenPrice > 0 && <> × {rupees(l.seenPrice)}</>}</span>
            </span>
            {l.seenPrice > 0 && <span className="price">{rupees(l.seenPrice * l.qty)}</span>}
          </li>
        ))}
      </ul>
      {order.seenTotal === 0 && order.tillTotal === null ? (
        <p className="notice">{order.proposal ? 'The shop has sent your quotation above.' : order.status === 'pending' ? 'Waiting for the shop’s quotation.' : 'Asked for a quotation.'}</p>
      ) : <div className="summary">
        <div><span>Subtotal</span><span>{rupees(order.seenTotal)}</span></div>
        {order.tillTotal !== null && order.tillTotal !== order.seenTotal && (
          <div><span>Confirmed by the shop</span><span>{rupees(order.tillTotal)}</span></div>
        )}
        <div className="grand"><span>Total (pay at store)</span><span>{rupees(order.tillTotal ?? order.seenTotal)}</span></div>
      </div>}
      <div className="summary">
        <div><span>Fulfillment</span><span>Store pickup</span></div>
        {order.note && <div><span>Your note</span><span>{order.note}</span></div>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="order-actions">
        {catalog && (
          <button type="button" className="primary wide" onClick={() => {
            let cart = shop.cart
            for (const l of againFrom(order.lines, catalog)) cart = addToCart(cart, l)
            shop.setCart(cart)
            go('/cart')
          }}>Order these again</button>
        )}
        {live && !order.cancelRequested && !order.proposal && (
          <button type="button" className="danger wide" onClick={() => void cancel()}>
            {order.status === 'pending' ? 'Cancel order' : 'Ask to cancel'}
          </button>
        )}
      </div>
    </>
  )
}
