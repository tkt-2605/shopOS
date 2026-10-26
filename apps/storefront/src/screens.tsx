import { useEffect, useMemo, useRef, useState } from 'react'
import {
  imageUrl, placeOrder, saveContact, signIn, myOrder, cancelOrder, ApiError,
  type CatalogItem, type Order, type OrderStatus, type ShopState,
} from './api'
import { showGoogleButton } from './google'
import { read, write, forget } from './keep'
import { addToCart, cartTotal, rupees, setQty, shownName } from './money'
import type { Shop } from './useShop'

const BAR: Record<ShopState, string> = {
  checking: 'Checking the shop…',
  open: 'Open now · taking orders',
  closed: 'Shop closed for online orders. You can still browse.',
  unreachable: 'Can’t reach the shop right now. It may be closed or offline. Try again later.',
  offline: 'You’re offline. Showing your saved copy.',
}

export function StateBar({ state, onRetry }: { state: ShopState; onRetry: () => void }) {
  return (
    <div className="bar" data-state={state} role="status">
      <span>{BAR[state]}</span>
      {(state === 'unreachable' || state === 'offline') && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  )
}

function savedNote(state: ShopState, since: string | undefined): string | null {
  if (state === 'open' || !since) return null
  return `Saved copy from ${new Date(since).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. Prices and stock may have changed.`
}

// ---------------------------------------------------------------- browsing

export function Browse({ shop }: { shop: Shop }) {
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<CatalogItem | null>(null)
  const catalog = shop.held?.catalog

  const under = useMemo(() => {
    if (!catalog || category === null) return null
    const ids = new Set([category])
    let grew = true
    while (grew) {
      grew = false
      for (const c of catalog.categories) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true }
    }
    return ids
  }, [catalog, category])

  const items = useMemo(() => {
    if (!catalog) return []
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    return catalog.items.filter((i) =>
      (under === null || (i.categoryId !== null && under.has(i.categoryId)))
      && words.every((w) => i.name.toLowerCase().includes(w) || (i.brand ?? '').toLowerCase().includes(w)))
  }, [catalog, under, search])

  if (!catalog) {
    return <p className="empty">{shop.state === 'checking' ? 'Loading the shop…' : 'The shop’s items have not loaded yet. They will once the shop can be reached.'}</p>
  }
  const note = savedNote(shop.state, shop.held?.since)
  const tops = catalog.categories.filter((c) => c.parentId === null || !catalog.categories.some((p) => p.id === c.parentId))

  return (
    <>
      {note && <p className="saved">{note}</p>}
      <input className="search" type="search" placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="chips">
        <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)}>All</button>
        {tops.map((c) => (
          <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>
        ))}
      </div>
      <ul className="grid">
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" className="tile" onClick={() => setOpen(i)}>
              {i.thumb ? <img src={imageUrl(i.thumb)} alt="" loading="lazy" width={200} height={200} /> : <span className="noimg" />}
              <span className="name">{shownName(i)}</span>
              <span className="price">{rupees(i.units[0]!.price)}{i.units.length > 1 ? ' +' : ''}</span>
              {!i.available && <span className="out">Out of stock</span>}
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p className="empty">Nothing matches.</p>}
      {open && <ItemSheet item={open} shop={shop} onClose={() => setOpen(null)} />}
    </>
  )
}

function ItemSheet({ item, shop, onClose }: { item: CatalogItem; shop: Shop; onClose: () => void }) {
  const [unit, setUnit] = useState(0)
  const [qty, setQtyState] = useState(1)
  const chosen = item.units[unit]!
  return (
    <div className="sheet" role="dialog" aria-label={shownName(item)} onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        {item.photo && <img src={imageUrl(item.photo)} alt="" className="photo" />}
        <h2>{shownName(item)}</h2>
        {item.units.length > 1 && (
          <div className="chips">
            {item.units.map((u, i) => (
              <button key={u.unit} type="button" aria-pressed={i === unit} onClick={() => setUnit(i)}>{u.unit}</button>
            ))}
          </div>
        )}
        <p className="big">
          {rupees(chosen.price)} <span className="muted">per {chosen.unit}</span>
          {chosen.mrp !== null && chosen.mrp > chosen.price && <span className="muted"> · MRP {rupees(chosen.mrp)}</span>}
        </p>
        {!item.available && <p className="out">Out of stock at the moment. You can still ask for it.</p>}
        <div className="row">
          <button type="button" onClick={() => setQtyState(Math.max(1, qty - 1))} aria-label="One fewer">−</button>
          <span className="qty">{qty}</span>
          <button type="button" onClick={() => setQtyState(Math.min(999, qty + 1))} aria-label="One more">+</button>
          <button type="button" className="primary" onClick={() => {
            shop.setCart(addToCart(shop.cart, { productId: item.id, name: shownName(item), unit: chosen.unit, qty, price: chosen.price }))
            onClose()
          }}>Add to cart</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- cart

export function Cart({ shop, onPlaced }: { shop: Shop; onPlaced: (order: Order) => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const total = cartTotal(shop.cart)

  if (shop.cart.length === 0) return <p className="empty">Your cart is empty.</p>

  const needsContact = shop.account !== null && (!shop.account.name || !shop.account.phone)
  const canOrder = shop.state === 'open' && shop.session !== null && !needsContact

  async function place() {
    if (!shop.session) return
    setBusy(true)
    setError(null)
    try {
      if (await shop.check() !== 'open') return
      /* The same id until it goes through, so an order sent twice over a bad
         line is one order. */
      const clientOrderId = (await read<string>('placing')) ?? crypto.randomUUID()
      await write('placing', clientOrderId)
      const { order } = await placeOrder(shop.session, {
        clientOrderId, catalogHash: shop.held?.hash ?? null, note,
        lines: shop.cart.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty, price: l.price })),
      })
      await forget('placing')
      shop.setCart([])
      await shop.refreshOrders()
      onPlaced(order)
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      setError(code === 'SHOP_CLOSED' ? 'The shop has just closed for online orders.'
        : code === 'TOO_MANY_OPEN' ? 'You already have three orders waiting. Collect one first.'
        : code === 'NOT_LISTED' ? 'Something in your cart is no longer sold online. Remove it and try again.'
        : code === 'SLOW_DOWN' ? 'Too many orders just now. Try again in a while.'
        : 'The order did not go through. Try again.')
      if (code === 'NOT_LISTED' || code === 'BAD_LINE') await forget('placing')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ul className="lines">
        {shop.cart.map((l, i) => (
          <li key={`${l.productId}-${l.unit}`}>
            <span className="name">{l.name} <span className="muted">{l.unit}</span></span>
            <span className="row">
              <button type="button" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty - 1))} aria-label="One fewer">−</button>
              <span className="qty">{l.qty}</span>
              <button type="button" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty + 1))} aria-label="One more">+</button>
            </span>
            <span className="price">{rupees(l.price * l.qty)}</span>
          </li>
        ))}
      </ul>
      <p className="total">Total {rupees(total)}</p>
      <p className="muted">Final price confirmed by the shop when it accepts your order. You pay at the counter when you collect.</p>

      {shop.session === null
        ? <SignIn shop={shop} />
        : needsContact
          ? <Contact shop={shop} />
          : (
            <>
              <label className="field">
                <span>Note for the shop (optional)</span>
                <textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              </label>
              {error && <p className="error">{error}</p>}
              {shop.state !== 'open' && <p className="error">{BAR[shop.state]}</p>}
              <button type="button" className="primary wide" disabled={!canOrder || busy} onClick={() => void place()}>
                {busy ? 'Sending…' : 'Place order'}
              </button>
            </>
          )}
    </>
  )
}

function SignIn({ shop }: { shop: Shop }) {
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const clientId = shop.status?.googleClientId ?? null

  useEffect(() => {
    if (!clientId || !box.current) return
    void showGoogleButton(box.current, clientId, (token) => {
      void signIn(token)
        .then((r) => shop.signedIn(r.session, r.account))
        .catch(() => setError('Signing in did not work. Try again.'))
    }).catch(() => setError('Google sign-in could not load.'))
  }, [clientId])

  if (shop.state !== 'open' && shop.state !== 'closed') return <p className="muted">Sign in when the shop can be reached.</p>
  return (
    <div className="signin">
      <p>Sign in to order and to see your orders later.</p>
      <div ref={box} />
      {!clientId && <p className="muted">Sign-in is not set up at the shop yet.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Contact({ shop }: { shop: Shop }) {
  const [name, setName] = useState(shop.account?.name ?? '')
  const [phone, setPhone] = useState(shop.account?.phone ?? '')
  const [error, setError] = useState<string | null>(null)
  async function save() {
    if (!shop.session) return
    try {
      shop.setAccount((await saveContact(shop.session, name, phone)).account)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'BAD_PHONE' ? 'Give a 10-digit mobile number.' : 'Give your name and phone.')
    }
  }
  return (
    <div className="contact">
      <p>Your name and phone, so the shop can call you when your order is ready.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Mobile</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary wide" onClick={() => void save()}>Save</button>
    </div>
  )
}

// ---------------------------------------------------------------- orders

const STATUS: Record<OrderStatus, string> = {
  pending: 'Waiting for the shop',
  accepted: 'Accepted',
  packing: 'Being packed',
  ready: 'Ready to collect',
  collected: 'Collected',
  rejected: 'Not accepted',
  cancelled: 'Cancelled',
}

export function Orders({ shop, onOpen }: { shop: Shop; onOpen: (id: string) => void }) {
  useEffect(() => { void shop.refreshOrders() }, [])
  if (shop.session === null) return <SignIn shop={shop} />
  const list = shop.orders?.orders ?? []
  return (
    <>
      {shop.state !== 'open' && shop.state !== 'closed' && shop.orders && (
        <p className="saved">As of {new Date(shop.orders.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.</p>
      )}
      <ul className="lines">
        {list.map((o) => (
          <li key={o.id} onClick={() => onOpen(o.id)} className="link">
            <span className="name">W-{o.orderNo} <span className="muted">{new Date(o.placedAt).toLocaleDateString('en-IN')}</span></span>
            <span data-status={o.status}>{STATUS[o.status]}</span>
            <span className="price">{rupees(o.tillTotal ?? o.seenTotal)}</span>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="empty">No orders yet.</p>}
      <button type="button" className="link-button" onClick={() => void shop.signOut()}>Sign out</button>
    </>
  )
}

export function OrderView({ shop, id }: { shop: Shop; id: string }) {
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

  async function cancel() {
    if (!shop.session) return
    try {
      setOrder((await cancelOrder(shop.session, id)).order)
      void shop.refreshOrders()
    } catch {
      setError('It could not be cancelled just now.')
    }
  }

  return (
    <>
      <h2>W-{order.orderNo}</h2>
      <p className="status" data-status={order.status}>{STATUS[order.status]}</p>
      {order.reason && <p className="muted">{order.reason}</p>}
      {order.status === 'ready' && <p>Come to the counter and give the number W-{order.orderNo}. You pay when you collect.</p>}
      {order.cancelRequested && live && <p className="muted">You asked to cancel. The shop will confirm.</p>}
      <ul className="lines">
        {order.lines.map((l, i) => (
          <li key={i}>
            <span className="name">{l.name} <span className="muted">{l.unit}</span></span>
            <span className="qty">×{l.qty}</span>
            <span className="price">{rupees(l.seenPrice * l.qty)}</span>
          </li>
        ))}
      </ul>
      <p className="total">
        {order.tillTotal !== null ? <>Total {rupees(order.tillTotal)}</> : <>About {rupees(order.seenTotal)}</>}
      </p>
      {order.tillTotal !== null && order.tillTotal !== order.seenTotal && (
        <p className="muted">The shop’s price today. You saw {rupees(order.seenTotal)}.</p>
      )}
      {error && <p className="error">{error}</p>}
      {live && !order.cancelRequested && (
        <button type="button" className="wide" onClick={() => void cancel()}>
          {order.status === 'pending' ? 'Cancel order' : 'Ask to cancel'}
        </button>
      )}
    </>
  )
}
