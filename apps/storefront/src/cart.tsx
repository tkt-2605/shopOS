import { useEffect, useRef, useState } from 'react'
import { imageUrl, placeOrder, saveContact, signIn, ApiError, type Order } from './api'
import { showGoogleButton } from './google'
import { barText } from './items'
import { read, write, forget } from './keep'
import { rupees, setQty } from './money'
import { checkCart, repriced, saving } from './shelf'
import type { Shop } from './useShop'

/* The cart and checkout. Each line is held up against today's catalogue: a
   price that moved is shown and used, a line the shop no longer sells online
   is marked and left out of the order. */

export function Cart({ shop, onPlaced, go }: { shop: Shop; onPlaced: (order: Order) => void; go: (to: string) => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (shop.cart.length === 0) {
    return (
      <div className="empty-cart">
        <p className="empty">Your cart is empty.</p>
        <button type="button" className="primary" onClick={() => go('/shop')}>Start shopping</button>
      </div>
    )
  }

  const lines = checkCart(shop.cart, shop.held?.catalog)
  const gone = lines.filter((l) => l.now === null)
  const moved = lines.filter((l) => l.now !== null && l.now.price !== l.price)
  const good = repriced(lines)
  const total = good.reduce((s, l) => s + l.price * l.qty, 0)
  const saved = lines.reduce((s, l) => s + (l.now ? (saving(l.now)?.amount ?? 0) * l.qty : 0), 0)
  const count = good.reduce((n, l) => n + l.qty, 0)

  const needsContact = shop.account !== null && (!shop.account.name || !shop.account.phone)
  const canOrder = shop.state === 'open' && shop.session !== null && !needsContact && good.length > 0

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
        lines: good.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty, price: l.price })),
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
      <div className="cart-head">
        <h1>Cart <span className="muted">· {count} item{count === 1 ? '' : 's'}</span></h1>
        <button type="button" className="link-button" onClick={() => { if (confirm('Empty the cart?')) shop.setCart([]) }}>Empty cart</button>
      </div>
      {moved.length > 0 && <p className="notice">Some prices changed since you added them. The cart shows today’s.</p>}
      {gone.length > 0 && <p className="notice bad">{gone.length === 1 ? 'One item is' : `${gone.length} items are`} no longer sold online and will be left out.</p>}

      <ul className="cart-lines">
        {lines.map((l, i) => (
          <li key={`${l.productId}-${l.unit}`} data-gone={l.now === null}>
            {l.item?.thumb ? <img src={imageUrl(l.item.thumb)} alt="" width={64} height={64} /> : <span className="noimg">{l.name.slice(0, 1)}</span>}
            <span className="what">
              <span className="name">{l.name}</span>
              <span className="muted">
                {l.unit} · {rupees(l.now?.price ?? l.price)} each
                {l.now && l.now.price !== l.price && <> (was {rupees(l.price)})</>}
              </span>
              {l.now === null && <span className="out-note">No longer sold online</span>}
              {l.item && !l.item.available && l.now && <span className="out-note">Out of stock; the shop will confirm</span>}
            </span>
            <span className="end">
              <span className="price">{rupees((l.now?.price ?? l.price) * l.qty)}</span>
              <span className="stepper small">
                <button type="button" aria-label="One fewer" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty - 1))}>−</button>
                <span>{l.qty}</span>
                <button type="button" aria-label="One more" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty + 1))}>+</button>
              </span>
              <button type="button" className="link-button" onClick={() => shop.setCart(setQty(shop.cart, i, 0))}>Remove</button>
            </span>
          </li>
        ))}
      </ul>

      <div className="summary">
        <div><span>Items ({count})</span><span>{rupees(total)}</span></div>
        {saved > 0 && <div className="save"><span>You save against MRP</span><span>−{rupees(saved)}</span></div>}
        <div className="grand"><span>To pay at the counter</span><span>{rupees(total)}</span></div>
        <p className="muted">The shop confirms the final price when it accepts your order. You pay when you collect.</p>
      </div>

      {shop.session === null
        ? <SignIn shop={shop} />
        : needsContact
          ? <Contact shop={shop} />
          : (
            <>
              <p className="muted">Ordering as {shop.account?.name} · {shop.account?.phone}</p>
              <label className="field">
                <span>Note for the shop (optional)</span>
                <textarea value={note} maxLength={300} placeholder="e.g. I will collect after 6 pm" onChange={(e) => setNote(e.target.value)} />
              </label>
              {error && <p className="error">{error}</p>}
              {shop.state !== 'open' && <p className="error">{barText(shop.state)}</p>}
              <button type="button" className="primary wide" disabled={!canOrder || busy} onClick={() => void place()}>
                {busy ? 'Sending…' : `Place order · ${rupees(total)}`}
              </button>
            </>
          )}
      <button type="button" className="link-button" onClick={() => go('/shop')}>← Continue shopping</button>
    </>
  )
}

export function SignIn({ shop }: { shop: Shop }) {
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
      <p><strong>Sign in to order</strong></p>
      <p className="muted">Your orders stay on your account, so you can follow them from any phone.</p>
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
      <p><strong>Your name and phone</strong></p>
      <p className="muted">So the shop can call you when your order is ready.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Mobile</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary wide" onClick={() => void save()}>Save and continue</button>
    </div>
  )
}
