import { useEffect, useState } from 'react'
import { imageUrl, type CatalogItem, type ShopState } from './api'
import { addToCart, rupees, setQty, shownName } from './money'
import { bestTier, firstUnit, saving } from './shelf'
import type { Layout, Shop } from './useShop'

/* The pieces every page is built from: the bar that says whether the shop can
   take an order, an item as a card or as a line, and an item's own sheet. */

const BAR: Record<ShopState, string> = {
  checking: 'Checking the shop…',
  open: 'Open now · taking orders',
  closed: 'Shop closed for online orders. You can still browse.',
  asleep: 'The shop is closed now. You can order when it opens.',
  unreachable: 'Can’t reach the shop right now. It may be closed or offline. Try again later.',
  offline: 'You’re offline. Showing your saved copy.',
}

export const barText = (state: ShopState) => BAR[state]

const MOON = 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'
const CARD: Record<'closed' | 'asleep' | 'unreachable' | 'offline', { title: string; icon: string }> = {
  closed: { title: 'Closed for online orders', icon: MOON },
  asleep: { title: 'Closed now', icon: MOON },
  unreachable: { title: 'Can’t reach the shop', icon: 'M7 17l-3 3M17 7l3-3M9 7l-2 2a3.5 3.5 0 0 0 5 5l2-2M10 6l8 8M15 17l2-2a3.5 3.5 0 0 0-5-5' },
  offline: { title: 'You’re offline', icon: 'M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01M3 3l18 18' },
}

/**
 * Only says something when the shop cannot take an order ("open" is a dot in
 * the app bar): what is wrong in a few words, how old the copy being browsed
 * is, and a round button to look again.
 */
export function StateBar({ state, since, hours, onRetry }: {
  state: ShopState; since: string | undefined; hours: string | null | undefined; onRetry: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  if (state === 'open' || state === 'checking') return null
  const card = CARD[state]
  const copy = since ? `Saved copy from ${new Date(since).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : null
  const sub = state === 'asleep'
    ? hours ? `Open ${hours} · browse now, order when it opens` : 'Browse now, order when the shop opens'
    : state === 'closed'
    ? [hours ? `Open ${hours}` : 'Browse now, order when the shop opens', copy].filter(Boolean).join(' · ')
    : [copy ?? 'Nothing saved yet', 'prices may have changed'].join(' · ')
  return (
    <div className="state-card" data-state={state} role="status">
      <span className="state-icon" aria-hidden>
        <svg viewBox="0 0 24 24"><path d={card.icon} /></svg>
      </span>
      <span className="state-text">
        <strong>{card.title}</strong>
        <small>{sub}</small>
      </span>
      <button type="button" className="state-retry" aria-label="Try again" data-busy={busy} disabled={busy}
        onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)) }}>
        <svg viewBox="0 0 24 24" aria-hidden><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
      </button>
    </div>
  )
}


/** The page title block every tab opens with. */
export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

/**
 * The count between − and +, typed straight in. It takes effect on leaving the
 * box or on Enter; an empty box goes back to what it was, 0 is passed on (the
 * cart removes the line), and nothing goes above 999.
 */
export function QtyInput({ value, onChange, min = 0 }: { value: number; onChange: (qty: number) => void; min?: number }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number.parseInt(text, 10)
    if (Number.isNaN(n)) { setText(String(value)); return }
    const next = Math.min(999, Math.max(min, n))
    setText(String(next))
    if (next !== value) onChange(next)
  }
  return (
    <input className="qty-input" type="text" inputMode="numeric" pattern="[0-9]*" aria-label="Quantity" value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 3))}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

/** "50+ at ₹8": the best quantity price, when the shop shows them. */
function BulkTag({ item }: { item: CatalogItem }) {
  const best = bestTier(firstUnit(item))
  return best ? <span className="tier-tag">{best.minQty}+ at {rupees(best.price)} each</span> : null
}

/** An empty photo: a quiet picture glyph rather than words. */
export function NoImage({ className = '' }: { className?: string }) {
  return (
    <span className={`noimg ${className}`}>
      <svg viewBox="0 0 24 24" aria-hidden><path d="M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 15M15.5 9.5h.01" /></svg>
    </span>
  )
}

function Price({ item }: { item: CatalogItem }) {
  const u = firstUnit(item)
  const off = saving(u)
  return (
    <span className="price-line">
      {u.price > 0
        ? <span className="price">{rupees(u.price)}<span className="per">/{u.unit}</span></span>
        : <span className="price ask">Price on request<span className="per"> · {u.unit}</span></span>}
      {off && <s className="mrp">{rupees(u.mrp!)}</s>}
    </span>
  )
}

/** Add, or − n + once it is in the cart; an item sold in more than one unit opens to choose. */
function AddButton({ item, shop }: { item: CatalogItem; shop: Shop }) {
  const u = firstUnit(item)
  const at = shop.cart.findIndex((l) => l.productId === item.id && l.unit === u.unit)
  const inCart = at >= 0 ? shop.cart[at]!.qty : 0
  if (item.units.length > 1) {
    return <button type="button" className="add" onClick={() => { location.hash = `/item/${item.id}` }}>ADD<small>{item.units.length} options</small></button>
  }
  if (inCart === 0) {
    return (
      <button type="button" className="add" onClick={() =>
        shop.setCart(addToCart(shop.cart, { productId: item.id, name: shownName(item), unit: u.unit, qty: 1, price: u.price }))}>ADD</button>
    )
  }
  return (
    <span className="stepper">
      <button type="button" aria-label="One fewer" onClick={() => shop.setCart(setQty(shop.cart, at, inCart - 1))}>−</button>
      <span>{inCart}</span>
      <button type="button" aria-label="One more" onClick={() => shop.setCart(setQty(shop.cart, at, inCart + 1))}>+</button>
    </span>
  )
}

/** A card: photo, brand above the name, price with the MRP struck through. */
export function Tile({ item, shop, onOpen }: { item: CatalogItem; shop: Shop; onOpen: (i: CatalogItem) => void }) {
  const off = saving(firstUnit(item))
  return (
    <li className="tile" data-out={!item.available}>
      <button type="button" className="tile-open" onClick={() => onOpen(item)}>
        <span className="pic">
          {item.thumb ? <img src={imageUrl(item.thumb)} alt="" loading="lazy" width={200} height={200} /> : <NoImage />}
          {off && <span className="badge">{off.percent}% OFF</span>}
          {!item.available && <span className="badge out">Out of stock</span>}
        </span>
        <span className="brand-tag">{item.brand ?? ' '}</span>
        <span className="name">{item.name}</span>
        <BulkTag item={item} />
      </button>
      <div className="tile-foot">
        <Price item={item} />
        <AddButton item={item} shop={shop} />
      </div>
    </li>
  )
}

/** A line with no photo, for a quick list on a slow line; open it to see the photo. */
export function Line({ item, shop, onOpen }: { item: CatalogItem; shop: Shop; onOpen: (i: CatalogItem) => void }) {
  return (
    <li className="line" data-out={!item.available}>
      <button type="button" className="line-open" onClick={() => onOpen(item)}>
        <span className="brand-tag">{item.brand ?? ''}</span>
        <span className="name">{item.name}</span>
        <BulkTag item={item} />
        <Price item={item} />
        {!item.available && <span className="out-note">Out of stock</span>}
      </button>
      <AddButton item={item} shop={shop} />
    </li>
  )
}

export function Items({ items, shop, onOpen, layout }: {
  items: readonly CatalogItem[]; shop: Shop; onOpen: (i: CatalogItem) => void; layout: Layout
}) {
  return layout === 'list'
    ? <ul className="lines">{items.map((i) => <Line key={i.id} item={i} shop={shop} onOpen={onOpen} />)}</ul>
    : <ul className="grid">{items.map((i) => <Tile key={i.id} item={i} shop={shop} onOpen={onOpen} />)}</ul>
}
