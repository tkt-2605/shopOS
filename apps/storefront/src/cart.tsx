import { useEffect, useRef, useState } from 'react'
import { imageUrl, placeOrder, saveContact, signIn, ApiError, type CatalogUnit, type Order } from './api'
import { showGoogleButton } from './google'
import { barText, NoImage, PageHead, QtyInput } from './items'
import { inApp, nativeGoogleToken } from './native'
import { read, write, forget } from './keep'
import { cartMessage, rupees, setQty, waLink } from './money'
import { WHATSAPP_ICON, whatsappCart } from './contact'
import { checkCart, nextTier, repriced, saving } from './shelf'
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
      <>
        <PageHead title="Cart" sub="Nothing here yet" />
        <div className="empty-cart">
          <p className="empty">Your cart is empty.</p>
          <button type="button" className="primary" onClick={() => go('/shop')}>Start shopping</button>
        </div>
      </>
    )
  }

  const lines = checkCart(shop.cart, shop.held?.catalog)
  const gone = lines.filter((l) => l.now === null)
  const moved = lines.filter((l) => l.now !== null && l.now.price !== l.price)
  const good = repriced(lines)
  const total = good.reduce((s, l) => s + l.price * l.qty, 0)
  const saved = lines.reduce((s, l) => s + (l.now ? (saving(l.now)?.amount ?? 0) * l.qty : 0), 0)
  const bulk = lines.reduce((s, l) => s + (l.now ? (l.now.price - l.each) * l.qty : 0), 0)
  /* The shop lists without prices: this cart asks for a quotation. */
  const quoting = good.length > 0 && total === 0

  const sendTo = whatsappCart(shop.status)
  const shopName = shop.held?.catalog.shop || shop.status?.shop || 'TRT'
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
      <PageHead title="Cart" sub={`${lines.length} line${lines.length === 1 ? '' : 's'}`}>
        <button type="button" className="ghost" onClick={() => { if (confirm('Empty the cart?')) shop.setCart([]) }}>Empty</button>
      </PageHead>
      {quoting && <p className="notice">Prices are on request. Send your list and the shop replies with a quotation you can accept or cancel.</p>}
      {moved.length > 0 && !quoting && <p className="notice">Some prices changed since you added them. The cart shows today’s.</p>}
      {gone.length > 0 && <p className="notice bad">{gone.length === 1 ? 'One item is' : `${gone.length} items are`} no longer sold online and will be left out.</p>}

      <ul className="cart-lines">
        {lines.map((l, i) => (
          <li key={`${l.productId}-${l.unit}`} data-gone={l.now === null}>
            {l.item?.thumb ? <img src={imageUrl(l.item.thumb)} alt="" width={72} height={72} /> : <NoImage />}
            <span className="what">
              <span className="name">{l.name}</span>
              {quoting ? <span className="muted">{l.unit}</span> : <span className="muted">
                {rupees(l.each)} / {l.unit}
                {l.now && l.each < l.now.price && <> <s>{rupees(l.now.price)}</s></>}
                {l.now && l.now.price !== l.price && <> (was {rupees(l.price)})</>}
              </span>}
              {l.now && l.each < l.now.price && (
                <span className="bulk">Bulk price · you save {rupees((l.now.price - l.each) * l.qty)}</span>
              )}
              {l.now && <Nudge unit={l.now} qty={l.qty} onTake={(n) => shop.setCart(setQty(shop.cart, i, n))} />}
              {l.now === null && <span className="out-note">No longer sold online</span>}
              {l.item && !l.item.available && l.now && <span className="out-note">Out of stock; the shop will confirm</span>}
              <span className="stepper">
                <button type="button" aria-label="One fewer" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty - 1))}>−</button>
                <QtyInput value={l.qty} onChange={(n) => shop.setCart(setQty(shop.cart, i, n))} />
                <button type="button" aria-label="One more" onClick={() => shop.setCart(setQty(shop.cart, i, l.qty + 1))}>+</button>
              </span>
            </span>
            <span className="end">
              {!quoting && <span className="price">{rupees(l.each * l.qty)}</span>}
              <button type="button" className="ghost small" onClick={() => shop.setCart(setQty(shop.cart, i, 0))}>Remove</button>
            </span>
          </li>
        ))}
      </ul>

      {!quoting && <div className="summary">
        <div><span>Subtotal</span><span>{rupees(total + bulk)}</span></div>
        {bulk > 0 && <div className="save"><span>Bulk savings</span><span>−{rupees(bulk)}</span></div>}
        {saved > 0 && <div className="save"><span>You save against MRP</span><span>−{rupees(saved)}</span></div>}
        <div><span>Fulfillment</span><span>Store pickup</span></div>
        <div className="grand"><span>Total</span><span>{rupees(total)}</span></div>
        <p className="muted">The shop confirms the final price when it accepts your order. You pay when you collect.</p>
      </div>}

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
                {busy ? 'Sending…' : quoting ? 'Ask for a quotation · Pickup' : `Checkout · Pickup · ${rupees(total)}`}
              </button>
            </>
          )}
      {sendTo && good.length > 0 && (
        <a className="wa-cart" href={waLink(sendTo, cartMessage(shopName, good, shop.account))} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" aria-hidden><path d={WHATSAPP_ICON} /></svg>
          <span><strong>{quoting ? 'Ask on WhatsApp' : 'Send cart on WhatsApp'}</strong><small>{quoting ? 'Your list goes to the shop for a quotation.' : 'The list and total go to the shop.'} No sign-in needed.</small></span>
        </a>
      )}
      <button type="button" className="link-button" onClick={() => go('/shop')}>← Continue shopping</button>
    </>
  )
}

/** "Add 3 more for ₹9 each · save ₹10": one tap takes the line up to the next quantity price. */
export function Nudge({ unit, qty, onTake }: { unit: CatalogUnit; qty: number; onTake: (qty: number) => void }) {
  const next = nextTier(unit, qty)
  if (!next) return null
  return (
    <button type="button" className="nudge" onClick={() => onTake(next.minQty)}>
      Add {next.more} more for {rupees(next.price)} each · save {rupees(next.save)}
    </button>
  )
}

/** "Your store, in your pocket": the panel a signed-out customer sees on Orders and Account. */
export function SignInPanel({ shop }: { shop: Shop }) {
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <p className="eyebrow">StoreFront by {shop.held?.catalog.shop || shop.status?.shop || 'TRT'}</p>
        <h1>Your store,<br />in your pocket</h1>
        <p>Browse stock, place pickup orders, and collect at the counter.</p>
      </div>
      <SignIn shop={shop} bare />
    </div>
  )
}

export function SignIn({ shop, bare = false }: { shop: Shop; bare?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const clientId = shop.status?.googleClientId ?? null
  const app = inApp()
  const withToken = (token: string) => {
    void signIn(token)
      .then((r) => shop.signedIn(r.session, r.account))
      .catch((err) => setError(`The shop did not accept the sign-in (${err instanceof ApiError ? err.code : 'no answer'}). Try again.`))
  }

  const reachable = shop.state === 'open' || shop.state === 'closed'
  /* The box comes and goes with `reachable` (a status check that failed once);
     each new box needs Google's button drawn in it again. */
  useEffect(() => {
    if (app || !clientId || !reachable || !box.current) return
    void showGoogleButton(box.current, clientId, withToken).catch(() => setError('Google sign-in could not load.'))
  }, [clientId, reachable])
  return (
    <div className={bare ? 'signin bare' : 'signin'}>
      <h2>Sign in</h2>
      <p className="muted">Continue with Google. We’ll ask for your mobile number once, for pickup calls.</p>
      {!reachable
        ? <p className="muted">Sign in when the shop can be reached.</p>
        : app
          ? clientId && (
            <button type="button" className="primary wide" onClick={() => {
              setError(null)
              nativeGoogleToken(clientId).then(withToken).catch((err) => {
                /* Google's code 10 is "this app is not registered": no Android client for this package and key. */
                const why = err instanceof Error ? err.message : String(err)
                setError(/10|DEVELOPER_ERROR/.test(why)
                  ? 'Google does not know this app yet (error 10). The shop needs to finish the app setup.'
                  : /cancel/i.test(why) ? 'Sign-in was cancelled.' : `Google sign-in did not work: ${why}`)
              })
            }}>Continue with Google</button>
          )
          : <div ref={box} className="google-box" />}
      {reachable && !clientId && <p className="muted">Sign-in is not set up at the shop yet.</p>}
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
      <h2>Your name and phone</h2>
      <p className="muted">So the shop can call you when your order is ready.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Mobile</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary wide" onClick={() => void save()}>Save and continue</button>
    </div>
  )
}
