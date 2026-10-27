import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CatalogItem } from './api'
import { useShop } from './useShop'
import { StateBar, ItemSheet } from './items'
import { Home, ShopList } from './browse'
import { Cart } from './cart'
import { Orders, OrderView } from './orders'
import { groupAndBelow } from './shelf'
import './styles.css'

/*
 * The storefront: home, the full list, an item, the cart, my orders. Routed
 * by the hash so a static host serves one page and the back button works.
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

function App() {
  const shop = useShop()
  const [route, go] = useRoute()
  const [open, setOpen] = useState<CatalogItem | null>(null)
  const shopName = shop.held?.catalog.shop || shop.status?.shop || 'TRT'
  useEffect(() => { document.title = `StoreFront by ${shopName}` }, [shopName])

  const [path, query = ''] = route.split('?') as [string, string?]
  const params = useMemo(() => new URLSearchParams(query), [query])
  const order = /^\/orders\/([\w-]+)$/.exec(path)
  const shared = /^\/item\/([\w-]+)$/.exec(path)
  const count = shop.cart.reduce((n, l) => n + l.qty, 0)
  const catalog = shop.held?.catalog

  /* A shared link to an item opens it over the home page. */
  useEffect(() => {
    if (!shared || !catalog) return
    const item = catalog.items.find((i) => i.id === shared[1])
    if (item) setOpen(item)
    go('/')
  }, [shared?.[1], catalog])

  const related = useMemo(() => {
    if (!open || !catalog || open.categoryId === null) return []
    const near = groupAndBelow(catalog, open.categoryId)
    return catalog.items
      .filter((i) => i.id !== open.id && i.categoryId !== null && near.has(i.categoryId))
      .sort((a, b) => Number(b.brand === open.brand) - Number(a.brand === open.brand))
      .slice(0, 8)
  }, [open, catalog])

  const tab = path === '/' ? 'home' : path.startsWith('/shop') ? 'shop' : path.startsWith('/orders') ? 'orders' : path === '/cart' ? 'cart' : ''

  return (
    <>
      <header>
        <button type="button" className="brand" onClick={() => go('/')}>
          <span className="mark" aria-hidden>S</span>
          <span className="words"><strong>StoreFront</strong><small>by {shopName}</small></span>
        </button>
        <nav className="top-nav">
          <button type="button" aria-current={tab === 'shop'} onClick={() => go('/shop')}>Shop</button>
          <button type="button" aria-current={tab === 'orders'} onClick={() => go('/orders')}>My orders</button>
          <button type="button" aria-current={tab === 'cart'} onClick={() => go('/cart')}>
            Cart{count > 0 && <span className="count">{count}</span>}
          </button>
        </nav>
      </header>
      <StateBar state={shop.state} onRetry={() => { void shop.check(); void shop.refreshCatalog() }} />
      <main>
        {path === '/cart' ? <Cart shop={shop} go={go} onPlaced={(o) => go(`/orders/${o.id}`)} />
          : path === '/orders' ? <Orders shop={shop} onOpen={(id) => go(`/orders/${id}`)} />
          : order ? <OrderView shop={shop} id={order[1]!} go={go} />
          : path === '/shop' ? <ShopList key={route} shop={shop} params={params} go={go} open={setOpen} />
          : <Home shop={shop} go={go} open={setOpen} />}
      </main>
      {count > 0 && tab !== 'cart' && (
        <button type="button" className="cart-float" onClick={() => go('/cart')}>
          {count} item{count === 1 ? '' : 's'} · View cart →
        </button>
      )}
      <nav className="tabs">
        <button type="button" aria-current={tab === 'home'} onClick={() => go('/')}>Home</button>
        <button type="button" aria-current={tab === 'shop'} onClick={() => go('/shop')}>Shop</button>
        <button type="button" aria-current={tab === 'orders'} onClick={() => go('/orders')}>Orders</button>
        <button type="button" aria-current={tab === 'cart'} onClick={() => go('/cart')}>Cart{count > 0 ? ` (${count})` : ''}</button>
      </nav>
      {open && <ItemSheet item={open} shop={shop} related={related} onOpen={setOpen} onClose={() => setOpen(null)} />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
