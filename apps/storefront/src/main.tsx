import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CatalogItem } from './api'
import { useShop } from './useShop'
import { StateBar } from './items'
import { ProductPage, QuickView } from './product'
import { ShopPage } from './browse'
import { Cart } from './cart'
import { Orders, OrderView } from './orders'
import { Account } from './account'
import { groupAndBelow } from './shelf'
import { inApp } from './native'
import { WHATSAPP_ICON, whatsappChat } from './contact'
import { waLink } from './money'
import './styles.css'

/*
 * StoreFront by TRT: Shop, Cart, Orders, Account, and an item's sheet over
 * them. Routed by the hash so a static host serves one page and the back
 * button works. The same build is the website, the installed PWA and the
 * Android app (mobile/storefront).
 */

function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => { setRoute(location.hash.slice(1) || '/'); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [route, (to) => { location.hash = to }]
}

const ICONS = {
  shop: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  cart: 'M6 7h12l-1 14H7zM9 7a3 3 0 0 1 6 0',
  orders: 'M4 6h16M4 12h16M4 18h16',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
}

function Tab({ id, label, current, go, to, badge }: {
  id: keyof typeof ICONS; label: string; current: string; go: (to: string) => void; to: string; badge?: number
}) {
  return (
    <button type="button" aria-current={current === id} onClick={() => go(to)}>
      <span className="icon">
        <svg viewBox="0 0 24 24" aria-hidden><path d={ICONS[id]} /></svg>
        {badge ? <span className="badge-count">{badge}</span> : null}
      </span>
      {label}
    </button>
  )
}

function App() {
  const shop = useShop()
  const [route, go] = useRoute()
  const [open, setOpen] = useState<CatalogItem | null>(null)
  const shopName = shop.held?.catalog.shop || shop.status?.shop || 'TRT'
  useEffect(() => { document.title = 'StoreFront' }, [])

  const [path, query = ''] = route.split('?') as [string, string?]
  const params = useMemo(() => new URLSearchParams(query), [query])
  const order = /^\/orders\/([\w-]+)$/.exec(path)
  const itemId = /^\/item\/([\w-]+)$/.exec(path)?.[1] ?? null
  const count = shop.cart.reduce((n, l) => n + l.qty, 0)
  const catalog = shop.held?.catalog
  const item = itemId ? catalog?.items.find((i) => i.id === itemId) ?? null : null
  useEffect(() => setOpen(null), [route])
  /* The quick view takes a step in history, so back (or the phone's swipe)
     closes it instead of leaving the page under it. */
  useEffect(() => {
    if (!open) return
    history.pushState({ quick: true }, '')
    const closed = () => setOpen(null)
    window.addEventListener('popstate', closed)
    return () => window.removeEventListener('popstate', closed)
  }, [open !== null])
  const closeQuick = () => { if ((history.state as { quick?: boolean } | null)?.quick) history.back(); else setOpen(null) }

  const related = useMemo(() => {
    if (!item || !catalog || item.categoryId === null) return []
    const near = groupAndBelow(catalog, item.categoryId)
    return catalog.items
      .filter((i) => i.id !== item.id && i.categoryId !== null && near.has(i.categoryId))
      .sort((a, b) => Number(b.brand === item.brand) - Number(a.brand === item.brand))
      .slice(0, 8)
  }, [item, catalog])

  const tab = path.startsWith('/orders') ? 'orders' : path === '/cart' ? 'cart' : path === '/account' ? 'account' : 'shop'
  const [busy, setBusy] = useState(false)
  const chatTo = whatsappChat(shop.status)
  const refresh = () => {
    setBusy(true)
    void Promise.all([shop.check(), shop.refreshCatalog(true), shop.refreshOrders()]).finally(() => setBusy(false))
  }

  return (
    <>
      <header className="appbar">
        <button type="button" className="brand" onClick={() => go('/')}>
          <img src="/icon-192.png" alt="" width={30} height={30} />
          <span><strong>StoreFront</strong><small>by {shopName}</small></span>
        </button>
        <span className="status" data-state={shop.state}>
          <span className="dot" />{shop.state === 'open' ? 'Open' : shop.state === 'checking' ? '…' : shop.state === 'closed' || shop.state === 'asleep' ? 'Closed' : shop.state === 'offline' ? 'Offline' : 'Unreachable'}
        </span>
        {chatTo && (
          <a className="icon-btn wa" aria-label="WhatsApp the shop" href={waLink(chatTo, `Hello ${shopName}, `)} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden className="fill"><path d={WHATSAPP_ICON} /></svg>
          </a>
        )}
        <button type="button" className="icon-btn" aria-label="Refresh" data-busy={busy} onClick={refresh}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
        </button>
      </header>
      <StateBar state={shop.state} since={shop.held?.since} hours={shop.status?.about?.hours}
        onRetry={() => Promise.all([shop.check(), shop.refreshCatalog(true), new Promise((r) => setTimeout(r, 600))])} />
      <main>
        {!shop.ready ? null : path === '/cart' ? <Cart shop={shop} go={go} onPlaced={(o) => go(`/orders/${o.id}`)} />
          : path === '/orders' ? <Orders shop={shop} onOpen={(id) => go(`/orders/${id}`)} />
          : order ? <OrderView shop={shop} id={order[1]!} go={go} />
          : path === '/account' ? <Account shop={shop} />
          : itemId ? (catalog || shop.state !== 'checking'
            ? <ProductPage item={item} shop={shop} related={related} go={go} onQuick={setOpen} />
            : <p className="empty">Loading…</p>)
          : <ShopPage key={route} shop={shop} params={params} go={go} open={setOpen} />}
      </main>
      {count > 0 && tab === 'shop' && !itemId && (
        <button type="button" className="cart-float" onClick={() => go('/cart')}>
          {count} item{count === 1 ? '' : 's'} in cart · View cart →
        </button>
      )}
      <nav className="tabs">
        <Tab id="shop" label="Shop" current={tab} go={go} to="/" />
        <Tab id="cart" label="Cart" current={tab} go={go} to="/cart" badge={count} />
        <Tab id="orders" label="Orders" current={tab} go={go} to="/orders" />
        <Tab id="account" label="Account" current={tab} go={go} to="/account" />
      </nav>
      {open && <QuickView item={open} onClose={closeQuick} onOpen={() => { const id = open.id; setOpen(null); history.replaceState(null, ''); go(`/item/${id}`) }} />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD && !inApp()) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
