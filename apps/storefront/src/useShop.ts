import { useCallback, useEffect, useRef, useState } from 'react'
import {
  checkShop, fetchCatalog, fetchManifest, me, myOrders, endsSession,
  type Account, type Catalog, type Order, type ShopState, type Status,
} from './api'
import { askToKeep, forget, read, write } from './keep'
import type { CartLine } from './money'

/*
 * Everything the storefront holds: the catalogue (the phone's copy first,
 * then a newer one if the manifest names one), whether the shop can take an
 * order right now, who is signed in, the cart, and the last copy of their
 * orders.
 */

interface HeldCatalog { hash: string; since: string; catalog: Catalog }

const CHECK_EVERY_MS = 60_000

export function useShop() {
  const [held, setHeld] = useState<HeldCatalog | null>(null)
  const [state, setState] = useState<ShopState>('checking')
  const [status, setStatus] = useState<Status | null>(null)
  const [session, setSession] = useState<string | null>(null)
  const [account, setAccountState] = useState<Account | null>(null)
  const [cart, setCartState] = useState<CartLine[]>([])
  const [orders, setOrders] = useState<{ at: string; orders: Order[] } | null>(null)
  /** Items opened lately, newest first, kept on the phone. */
  const [viewed, setViewed] = useState<string[]>([])
  /** Grid with photos, or a text-only list that is quicker on a slow line. */
  const [layout, setLayoutState] = useState<Layout>('grid')
  const loaded = useRef(false)
  /** False until what the phone kept has been read, so a signed-in customer never sees the sign-in page flash. */
  const [ready, setReady] = useState(false)

  const check = useCallback(async () => {
    const r = await checkShop()
    setState(r.state)
    if (r.status) { setStatus(r.status); void write('status', r.status) }
    return r.state
  }, [])

  const refreshCatalog = useCallback(async (fresh = false) => {
    try {
      const current = await read<HeldCatalog>('catalog')
      const manifest = await fetchManifest(fresh || current === null)
      if (current?.hash === manifest.hash) return
      const catalog = await fetchCatalog(manifest.hash)
      const next = { hash: manifest.hash, since: manifest.since, catalog }
      await write('catalog', next)
      setHeld(next)
    } catch {
      // The copy on the phone stays, and says how old it is.
    }
  }, [])

  const refreshOrders = useCallback(async (token: string | null = session) => {
    if (!token) return
    try {
      const { orders: list } = await myOrders(token)
      const next = { at: new Date().toISOString(), orders: list }
      setOrders(next)
      await write('orders', next)
    } catch (err) {
      if (endsSession(err)) await signOut()
    }
  }, [session])

  /* Kept on the phone so the name and number show while the shop is closed. */
  const setAccount = useCallback((who: Account | null) => {
    setAccountState(who)
    if (who) void write('account', who)
  }, [])

  const signedIn = useCallback(async (token: string, who: Account) => {
    setSession(token)
    setAccount(who)
    await write('session', token)
    askToKeep()
    await refreshOrders(token)
  }, [refreshOrders, setAccount])

  async function signOut() {
    setSession(null)
    setAccountState(null)
    setOrders(null)
    setCartState([])
    await forget('session', 'account', 'cart', 'orders')
  }

  const setCart = useCallback((lines: CartLine[]) => {
    setCartState(lines)
    void write('cart', lines)
  }, [])

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void (async () => {
      const [c, s, k, o, v, st, l, a] = await Promise.all([
        read<HeldCatalog>('catalog'), read<string>('session'), read<CartLine[]>('cart'),
        read<{ at: string; orders: Order[] }>('orders'), read<string[]>('viewed'), read<Status>('status'),
        read<Layout>('layout'), read<Account>('account'),
      ])
      if (v) setViewed(v)
      if (l) setLayoutState(l)
      if (st) setStatus(st)
      if (c) setHeld(c)
      if (k) setCartState(k)
      if (o) setOrders(o)
      if (s) { setSession(s); if (a) setAccountState(a) }
      setReady(true)
      const shop = await check()
      void refreshCatalog()
      if (s) {
        if (shop === 'open' || shop === 'closed') {
          try {
            setAccount((await me(s)).account)
            await refreshOrders(s)
          } catch (err) {
            if (endsSession(err)) await signOut()
          }
        }
      }
    })()
    /* A new photo or price reaches an open page within a couple of minutes, with no reload. */
    const timer = setInterval(() => { void check(); void refreshCatalog() }, CHECK_EVERY_MS)
    const online = () => { void check(); void refreshCatalog() }
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
    }
  }, [check, refreshCatalog, refreshOrders, setAccount])

  const sawItem = useCallback((id: string) => {
    setViewed((was) => {
      const next = [id, ...was.filter((v) => v !== id)].slice(0, 12)
      void write('viewed', next)
      return next
    })
  }, [])

  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next)
    void write('layout', next)
  }, [])

  return {
    ready, held, state, status, session, account, cart, orders, viewed, layout,
    check, refreshCatalog, refreshOrders, signedIn, signOut, setCart, setAccount, sawItem, setLayout,
  }
}

export type Layout = 'grid' | 'list'

export type Shop = ReturnType<typeof useShop>
