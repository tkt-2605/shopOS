import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useShop } from './useShop'
import { Browse, Cart, Orders, OrderView, StateBar } from './screens'
import './styles.css'

/*
 * The storefront: browse, cart, my orders. Routed by the hash so a static
 * host serves one page and the back button still works.
 */

function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [route, (to) => { location.hash = to }]
}

function App() {
  const shop = useShop()
  const [route, go] = useRoute()
  const name = shop.held?.catalog.shop || shop.status?.shop || 'Shop'
  useEffect(() => { document.title = name }, [name])

  const order = /^\/orders\/([\w-]+)$/.exec(route)
  const count = shop.cart.reduce((n, l) => n + l.qty, 0)

  return (
    <>
      <header>
        <button type="button" className="title" onClick={() => go('/')}>{name}</button>
        <nav>
          <button type="button" aria-current={route === '/orders' || !!order} onClick={() => go('/orders')}>My orders</button>
          <button type="button" aria-current={route === '/cart'} onClick={() => go('/cart')}>Cart{count > 0 ? ` (${count})` : ''}</button>
        </nav>
      </header>
      <StateBar state={shop.state} onRetry={() => { void shop.check(); void shop.refreshCatalog() }} />
      <main>
        {route === '/cart' ? <Cart shop={shop} onPlaced={(o) => go(`/orders/${o.id}`)} />
          : route === '/orders' ? <Orders shop={shop} onOpen={(id) => go(`/orders/${id}`)} />
          : order ? <OrderView shop={shop} id={order[1]!} />
          : <Browse shop={shop} />}
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
