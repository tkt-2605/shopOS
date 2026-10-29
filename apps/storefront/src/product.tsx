import { useEffect, useState } from 'react'
import { imageUrl, type CatalogItem } from './api'
import { NoImage, QtyInput, Tile } from './items'
import { addToCart, priceText, rupees, shownName } from './money'
import { bestTier, firstUnit, priceAt, saving } from './shelf'
import { Nudge } from './cart'
import type { Shop } from './useShop'

/* An item two ways: a quick look over the list, and its own page with the
   quantity, the line total and the add button. */

export function QuickView({ item, onClose, onOpen }: { item: CatalogItem; onClose: () => void; onOpen: () => void }) {
  const u = firstUnit(item)
  const off = saving(u)
  const best = bestTier(u)
  return (
    <div className="quick" role="dialog" aria-label={shownName(item)} onClick={onClose}>
      <div className="quick-body" onClick={(e) => e.stopPropagation()}>
        {item.photo || item.thumb
          ? <img src={imageUrl((item.photo ?? item.thumb)!)} alt="" className="quick-photo" />
          : <NoImage className="quick-photo" />}
        <div className="quick-text">
          {item.brand && <span className="brand-tag">{item.brand}</span>}
          <h2>{item.name}</h2>
          <p className="price-line">
            <span className={u.price > 0 ? 'price' : 'price ask'}>{priceText(u.price)}</span>
            {off && <s className="mrp">{rupees(u.mrp!)}</s>}
            {off && <span className="off">{off.percent}% off</span>}
          </p>
          {best && <p className="tier-tag">Buy {best.minQty}+ and pay {rupees(best.price)} each</p>}
          <div className="quick-actions">
            <button type="button" className="ghost" onClick={onClose}>Close</button>
            <button type="button" className="primary" onClick={onOpen}>Open product</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ProductPage({ item, shop, related, go, onQuick }: {
  item: CatalogItem | null; shop: Shop; related: readonly CatalogItem[]; go: (to: string) => void; onQuick: (i: CatalogItem) => void
}) {
  const [unit, setUnit] = useState(0)
  const [qty, setQty] = useState(1)
  const [added, setAdded] = useState<string | null>(null)
  useEffect(() => { if (item) shop.sawItem(item.id); setUnit(0); setQty(1); setAdded(null) }, [item?.id])
  useEffect(() => {
    if (!added) return
    const t = setTimeout(() => setAdded(null), 2500)
    return () => clearTimeout(t)
  }, [added])

  const back = <button type="button" className="link-button back" onClick={() => history.length > 1 ? history.back() : go('/')}>← Back to shop</button>
  if (!item) return <>{back}<p className="empty">This item is not in the shop’s online list.</p></>

  const chosen = item.units[unit] ?? item.units[0]!
  const off = saving(chosen)

  async function share() {
    const url = `${location.origin}/#/item/${item!.id}`
    try {
      if (navigator.share) await navigator.share({ title: shownName(item!), url })
      else await navigator.clipboard.writeText(url)
    } catch {
      // Cancelled; nothing to do.
    }
  }

  return (
    <>
      {back}
      {item.photo ? <img src={imageUrl(item.photo)} alt="" className="product-photo" /> : <NoImage className="product-photo" />}
      {item.brand && <p className="brand-tag product-brand">{item.brand}</p>}
      <h1 className="product-name">{item.name}</h1>
      <p className="price-line product-price">
        <span className={chosen.price > 0 ? 'price' : 'price ask'}>{priceText(chosen.price)}</span>
        <span className="per">/ {chosen.unit}</span>
        {off && <s className="mrp">{rupees(chosen.mrp!)}</s>}
        {off && <span className="off">Save {rupees(off.amount)} ({off.percent}%)</span>}
      </p>
      {chosen.mrp !== null && !off && <p className="muted mrp-note">MRP {rupees(chosen.mrp)} · incl. of all taxes</p>}
      <p className={item.available ? 'stock in' : 'stock out'}>
        {item.available ? 'In stock' : 'Out of stock at the moment. You can still ask for it; the shop will confirm.'}
      </p>
      {chosen.tiers && chosen.tiers.length > 0 && (
        <div className="tiers">
          <p className="tiers-title">Buy more, save more</p>
          {[{ minQty: 1, price: chosen.price }, ...chosen.tiers].map((t, i, all) => {
            const on = qty >= t.minQty && (all[i + 1] === undefined || qty < all[i + 1]!.minQty)
            return (
              <button key={t.minQty} type="button" className="tier" aria-pressed={on} onClick={() => setQty(Math.max(t.minQty, 1))}>
                <span>{t.minQty === 1 ? `1 ${chosen.unit}` : `${t.minQty}+ ${chosen.unit}`}</span>
                <strong>{rupees(t.price)} each</strong>
                <span className="tier-save">{t.price < chosen.price ? `save ${rupees(chosen.price - t.price)} each` : ''}</span>
              </button>
            )
          })}
        </div>
      )}
      {item.units.length > 1 && (
        <div className="chips wrap units">
          {item.units.map((u, i) => (
            <button key={u.unit} type="button" aria-pressed={i === unit} onClick={() => setUnit(i)}>
              {u.unit}{u.price > 0 && <> · {rupees(u.price)}</>}
            </button>
          ))}
        </div>
      )}
      <div className="qty-row">
        <span className="stepper big-stepper">
          <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="One fewer">−</button>
          <QtyInput value={qty} min={1} onChange={setQty} />
          <button type="button" onClick={() => setQty(Math.min(999, qty + 1))} aria-label="One more">+</button>
        </span>
        <span className="muted">{item.name}{chosen.price > 0 && <> · <strong>{rupees(priceAt(chosen, qty) * qty)}</strong></>}</span>
      </div>
      <Nudge unit={chosen} qty={qty} onTake={setQty} />
      <button type="button" className="primary wide" onClick={() => {
        shop.setCart(addToCart(shop.cart, { productId: item.id, name: shownName(item), unit: chosen.unit, qty, price: chosen.price }))
        setAdded(`${qty} ${chosen.unit} added to cart`)
        setQty(1)
      }}>Add {qty} {chosen.unit} to cart</button>
      <button type="button" className="link-button" onClick={() => void share()}>Share this item</button>
      {related.length > 0 && (
        <>
          <h2 className="section">You may also need</h2>
          <ul className="row-items">{related.map((i) => <Tile key={i.id} item={i} shop={shop} onOpen={onQuick} />)}</ul>
        </>
      )}
      {added && (
        <div className="toast" role="status">
          <span>{added}</span>
          <button type="button" onClick={() => go('/cart')}>View cart</button>
        </div>
      )}
    </>
  )
}
