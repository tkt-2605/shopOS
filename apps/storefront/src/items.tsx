import { useEffect, useState } from 'react'
import { imageUrl, type CatalogItem, type ShopState } from './api'
import { addToCart, rupees, setQty, shownName } from './money'
import { firstUnit, saving } from './shelf'
import type { Shop } from './useShop'

/* The pieces every page is built from: the bar that says whether the shop can
   take an order, an item's tile, a row of tiles, and an item's own sheet. */

const BAR: Record<ShopState, string> = {
  checking: 'Checking the shop…',
  open: 'Open now · taking orders',
  closed: 'Shop closed for online orders. You can still browse.',
  unreachable: 'Can’t reach the shop right now. It may be closed or offline. Try again later.',
  offline: 'You’re offline. Showing your saved copy.',
}

export const barText = (state: ShopState) => BAR[state]

export function StateBar({ state, onRetry }: { state: ShopState; onRetry: () => void }) {
  return (
    <div className="bar" data-state={state} role="status">
      <span className="dot" aria-hidden />
      <span>{BAR[state]}</span>
      {(state === 'unreachable' || state === 'offline') && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  )
}

export function savedNote(state: ShopState, since: string | undefined): string | null {
  if (state === 'open' || !since) return null
  return `Saved copy from ${new Date(since).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. Prices and stock may have changed.`
}

function Price({ item }: { item: CatalogItem }) {
  const u = firstUnit(item)
  const off = saving(u)
  return (
    <span className="price-line">
      <span className="price">{rupees(u.price)}</span>
      {off && <s className="mrp">{rupees(u.mrp!)}</s>}
      {item.units.length > 1 && <span className="muted"> / {u.unit}</span>}
    </span>
  )
}

/** One item on a list: tap to open it, and + / − right here for a single-unit item. */
export function Tile({ item, shop, onOpen }: { item: CatalogItem; shop: Shop; onOpen: (i: CatalogItem) => void }) {
  const u = firstUnit(item)
  const off = saving(u)
  const at = shop.cart.findIndex((l) => l.productId === item.id && l.unit === u.unit)
  const inCart = at >= 0 ? shop.cart[at]!.qty : 0
  const add = () => shop.setCart(addToCart(shop.cart, { productId: item.id, name: shownName(item), unit: u.unit, qty: 1, price: u.price }))

  return (
    <li className="tile" data-out={!item.available}>
      <button type="button" className="tile-open" onClick={() => onOpen(item)}>
        <span className="pic">
          {item.thumb ? <img src={imageUrl(item.thumb)} alt="" loading="lazy" width={200} height={200} /> : <span className="noimg">{shownName(item).slice(0, 1)}</span>}
          {off && <span className="badge">{off.percent}% off</span>}
          {!item.available && <span className="badge out">Out of stock</span>}
        </span>
        <span className="name">{shownName(item)}</span>
        <Price item={item} />
      </button>
      {item.units.length > 1
        ? <button type="button" className="add" onClick={() => onOpen(item)}>Choose</button>
        : inCart === 0
          ? <button type="button" className="add" onClick={add}>Add</button>
          : (
            <span className="stepper">
              <button type="button" aria-label="One fewer" onClick={() => shop.setCart(setQty(shop.cart, at, inCart - 1))}>−</button>
              <span>{inCart}</span>
              <button type="button" aria-label="One more" onClick={() => shop.setCart(setQty(shop.cart, at, inCart + 1))}>+</button>
            </span>
          )}
    </li>
  )
}

export function Grid({ items, shop, onOpen }: { items: readonly CatalogItem[]; shop: Shop; onOpen: (i: CatalogItem) => void }) {
  return <ul className="grid">{items.map((i) => <Tile key={i.id} item={i} shop={shop} onOpen={onOpen} />)}</ul>
}

/** A titled row that scrolls sideways, for the home page. */
export function Row({ title, items, shop, onOpen, more }: {
  title: string; items: readonly CatalogItem[]; shop: Shop; onOpen: (i: CatalogItem) => void; more?: () => void
}) {
  if (items.length === 0) return null
  return (
    <section className="row">
      <div className="row-head">
        <h2>{title}</h2>
        {more && <button type="button" className="link-button" onClick={more}>See all</button>}
      </div>
      <ul className="row-items">{items.map((i) => <Tile key={i.id} item={i} shop={shop} onOpen={onOpen} />)}</ul>
    </section>
  )
}

export function ItemSheet({ item, shop, onClose, onOpen, related }: {
  item: CatalogItem; shop: Shop; onClose: () => void; onOpen: (i: CatalogItem) => void; related: readonly CatalogItem[]
}) {
  const [unit, setUnit] = useState(0)
  const [qty, setQtyState] = useState(1)
  const [added, setAdded] = useState(false)
  useEffect(() => { shop.sawItem(item.id); setUnit(0); setQtyState(1); setAdded(false) }, [item.id])
  const chosen = item.units[unit] ?? item.units[0]!
  const off = saving(chosen)

  async function share() {
    const url = `${location.origin}/#/item/${item.id}`
    try {
      if (navigator.share) await navigator.share({ title: shownName(item), url })
      else await navigator.clipboard.writeText(url)
    } catch {
      // Cancelled; nothing to do.
    }
  }

  return (
    <div className="sheet" role="dialog" aria-label={shownName(item)} onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="close" aria-label="Close" onClick={onClose}>×</button>
        {item.photo ? <img src={imageUrl(item.photo)} alt="" className="photo" /> : <div className="photo noimg">{shownName(item).slice(0, 1)}</div>}
        <h2>{shownName(item)}</h2>
        {item.units.length > 1 && (
          <div className="chips">
            {item.units.map((u, i) => (
              <button key={u.unit} type="button" aria-pressed={i === unit} onClick={() => setUnit(i)}>
                {u.unit} · {rupees(u.price)}
              </button>
            ))}
          </div>
        )}
        <p className="big">
          {rupees(chosen.price)} <span className="muted">per {chosen.unit}</span>
        </p>
        {off && <p className="save">MRP <s>{rupees(chosen.mrp!)}</s> · you save {rupees(off.amount)} ({off.percent}%)</p>}
        {!item.available && <p className="out-note">Out of stock at the moment. You can still ask for it; the shop will confirm.</p>}
        <div className="row-actions">
          <span className="stepper">
            <button type="button" onClick={() => setQtyState(Math.max(1, qty - 1))} aria-label="One fewer">−</button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQtyState(Math.min(999, qty + 1))} aria-label="One more">+</button>
          </span>
          <button type="button" className="primary grow" onClick={() => {
            shop.setCart(addToCart(shop.cart, { productId: item.id, name: shownName(item), unit: chosen.unit, qty, price: chosen.price }))
            setAdded(true)
          }}>{added ? 'Added ✓ Add more' : `Add · ${rupees(chosen.price * qty)}`}</button>
        </div>
        <button type="button" className="link-button" onClick={() => void share()}>Share this item</button>
        {related.length > 0 && (
          <>
            <h3>You may also need</h3>
            <ul className="row-items">{related.map((i) => <Tile key={i.id} item={i} shop={shop} onOpen={onOpen} />)}</ul>
          </>
        )}
      </div>
    </div>
  )
}
