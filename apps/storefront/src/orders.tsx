import { useEffect, useState } from 'react'
import { myOrder, cancelOrder, type Order, type OrderStatus } from './api'
import { SignIn } from './cart'
import { addToCart, orderLabel, rupees } from './money'
import { againFrom } from './shelf'
import type { Shop } from './useShop'

/* A customer's orders, and one order followed step by step. */

const STATUS: Record<OrderStatus, string> = {
  pending: 'Waiting for the shop',
  accepted: 'Accepted',
  packing: 'Being packed',
  ready: 'Ready to collect',
  collected: 'Collected',
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

const STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'pending', label: 'Placed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'packing', label: 'Packing' },
  { key: 'ready', label: 'Ready' },
  { key: 'collected', label: 'Collected' },
]

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null

/**
 * Placed, accepted, packing, ready, collected -- each with when it happened.
 * A shop that marks an order ready without marking it packing has still been
 * through packing, so a later step fills in the ones before it.
 */
export function Tracker({ order }: { order: Order }) {
  if (order.status === 'rejected' || order.status === 'cancelled') {
    return (
      <div className="tracker stopped">
        <div className="step done"><span className="mark">✓</span><span>Placed<small>{when(order.placedAt)}</small></span></div>
        <div className="step stop"><span className="mark">×</span><span>{STATUS[order.status]}<small>{when(order.answeredAt)}</small></span></div>
      </div>
    )
  }
  const at = STEPS.findIndex((s) => s.key === order.status)
  const times: Record<string, string | null> = {
    pending: when(order.placedAt), accepted: when(order.answeredAt), packing: when(order.packingAt), ready: when(order.readyAt), collected: null,
  }
  return (
    <ol className="tracker">
      {STEPS.map((s, i) => (
        <li key={s.key} className={`step ${i < at || order.status === 'collected' ? 'done' : i === at ? 'now' : 'todo'}`}>
          <span className="mark">{i < at || order.status === 'collected' ? '✓' : i + 1}</span>
          <span>{s.label}{i <= at && times[s.key] && <small>{times[s.key]}</small>}</span>
        </li>
      ))}
    </ol>
  )
}

export function Orders({ shop, onOpen }: { shop: Shop; onOpen: (id: string) => void }) {
  useEffect(() => { void shop.refreshOrders() }, [])
  if (shop.session === null) return <SignIn shop={shop} />
  const list = shop.orders?.orders ?? []
  const live = list.filter((o) => ['pending', 'accepted', 'packing', 'ready'].includes(o.status))
  const past = list.filter((o) => !live.includes(o))
  return (
    <>
      <h1>My orders</h1>
      {shop.state !== 'open' && shop.state !== 'closed' && shop.orders && (
        <p className="saved">As of {new Date(shop.orders.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.</p>
      )}
      {live.length > 0 && <h2 className="section">In progress</h2>}
      {live.map((o) => <OrderCard key={o.id} order={o} onOpen={onOpen} />)}
      {past.length > 0 && <h2 className="section">Past orders</h2>}
      {past.map((o) => <OrderCard key={o.id} order={o} onOpen={onOpen} />)}
      {list.length === 0 && <p className="empty">No orders yet.</p>}
      <p className="muted">Signed in as {shop.account?.email ?? shop.account?.name}</p>
      <button type="button" className="link-button" onClick={() => void shop.signOut()}>Sign out</button>
    </>
  )
}

function OrderCard({ order, onOpen }: { order: Order; onOpen: (id: string) => void }) {
  const items = order.lines.reduce((n, l) => n + l.qty, 0)
  return (
    <button type="button" className="order-card" data-status={order.status} onClick={() => onOpen(order.id)}>
      <span className="top">
        <strong>{orderLabel(order.orderNo)}</strong>
        <span className="pill" data-status={order.status}>{STATUS[order.status]}</span>
      </span>
      <span className="muted">
        {new Date(order.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        {' · '}{items} item{items === 1 ? '' : 's'} · {rupees(order.tillTotal ?? order.seenTotal)}
      </span>
      <span className="names">{order.lines.map((l) => l.name).join(', ')}</span>
    </button>
  )
}

export function OrderView({ shop, id, go }: { shop: Shop; id: string; go: (to: string) => void }) {
  const kept = shop.orders?.orders.find((o) => o.id === id) ?? null
  const [order, setOrder] = useState<Order | null>(kept)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!shop.session) return
    const fetchIt = () => { void myOrder(shop.session!, id).then((r) => setOrder(r.order)).catch(() => undefined) }
    fetchIt()
    const timer = setInterval(fetchIt, 30_000)
    return () => clearInterval(timer)
  }, [shop.session, id])

  if (!order) return <p className="empty">This order is not on this phone. It will show once the shop can be reached.</p>
  const live = order.status === 'pending' || order.status === 'accepted' || order.status === 'packing' || order.status === 'ready'
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
      <button type="button" className="link-button" onClick={() => go('/orders')}>← My orders</button>
      <div className="order-head" data-status={order.status}>
        <span className="label">{orderLabel(order.orderNo)}</span>
        <span className="pill" data-status={order.status}>{STATUS[order.status]}</span>
        <p>{SAY[order.status]}</p>
        {order.reason && <p className="reason">{order.reason}</p>}
        {order.cancelRequested && live && <p className="muted">You asked to cancel. The shop will confirm.</p>}
      </div>
      <Tracker order={order} />
      {order.status === 'ready' && (
        <div className="collect-code">
          <span className="muted">Show this at the counter</span>
          <span className="code">#{order.orderNo}</span>
        </div>
      )}
      <ul className="cart-lines">
        {order.lines.map((l, i) => (
          <li key={i}>
            <span className="what">
              <span className="name">{l.name}</span>
              <span className="muted">{l.unit} · {rupees(l.seenPrice)} each</span>
            </span>
            <span className="end">
              <span className="price">{rupees(l.seenPrice * l.qty)}</span>
              <span className="muted">× {l.qty}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="summary">
        {order.tillTotal !== null && order.tillTotal !== order.seenTotal && (
          <div><span>You saw</span><s>{rupees(order.seenTotal)}</s></div>
        )}
        <div className="grand">
          <span>{order.tillTotal !== null ? 'Total' : 'About'}</span>
          <span>{rupees(order.tillTotal ?? order.seenTotal)}</span>
        </div>
        {order.note && <p className="muted">Your note: “{order.note}”</p>}
        <p className="muted">Placed {when(order.placedAt)}</p>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="order-actions">
        {catalog && (
          <button type="button" className="primary" onClick={() => {
            let cart = shop.cart
            for (const l of againFrom(order.lines, catalog)) cart = addToCart(cart, l)
            shop.setCart(cart)
            go('/cart')
          }}>Order these again</button>
        )}
        {live && !order.cancelRequested && (
          <button type="button" onClick={() => void cancel()}>
            {order.status === 'pending' ? 'Cancel order' : 'Ask to cancel'}
          </button>
        )}
      </div>
    </>
  )
}
