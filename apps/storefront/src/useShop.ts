import { useCallback, useEffect, useRef, useState } from 'react'
import {
  checkShop, fetchCatalog, fetchManifest, me, myOrders, ApiError,
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
  const [account, setAccount] = useState<Account | null>(null)
  const [cart, setCartState] = useState<CartLine[]>([])
  const [orders, setOrders] = useState<{ at: string; orders: Order[] } | null>(null)
  /** Items opened lately, newest first, kept on the phone. */
  const [viewed, setViewed] = useState<string[]>([])
  const loaded = useRef(false)

  const check = useCallback(async () => {
    const r = await checkShop()
    setState(r.state)
    if (r.status) { setStatus(r.status); void write('status', r.status) }
    return r.state
  }, [])

  const refreshCatalog = useCallback(async () => {
    try {
      const manifest = await fetchManifest()
      const current = await read<HeldCatalog>('catalog')
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
      if (err instanceof ApiError && err.status === 401) await signOut()
    }
  }, [session])

  const signedIn = useCallback(async (token: string, who: Account) => {
    setSession(token)
    setAccount(who)
    await write('session', token)
    askToKeep()
    await refreshOrders(token)
  }, [refreshOrders])

  async function signOut() {
    setSession(null)
    setAccount(null)
    setOrders(null)
    setCartState([])
    await forget('session', 'cart', 'orders')
  }

  const setCart = useCallback((lines: CartLine[]) => {
    setCartState(lines)
    void write('cart', lines)
  }, [])

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void (async () => {
      const [c, s, k, o, v, st] = await Promise.all([
        read<HeldCatalog>('catalog'), read<string>('session'), read<CartLine[]>('cart'),
        read<{ at: string; orders: Order[] }>('orders'), read<string[]>('viewed'), read<Status>('status'),
      ])
      if (v) setViewed(v)
      if (st) setStatus(st)
      if (c) setHeld(c)
      if (k) setCartState(k)
      if (o) setOrders(o)
      const shop = await check()
      void refreshCatalog()
      if (s) {
        setSession(s)
        if (shop === 'open' || shop === 'closed') {
          try {
            setAccount((await me(s)).account)
            await refreshOrders(s)
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) await signOut()
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
  }, [check, refreshCatalog, refreshOrders])

  const sawItem = useCallback((id: string) => {
    setViewed((was) => {
      const next = [id, ...was.filter((v) => v !== id)].slice(0, 12)
      void write('viewed', next)
      return next
    })
  }, [])

  return {
    held, state, status, session, account, cart, orders, viewed,
    check, refreshCatalog, refreshOrders, signedIn, signOut, setCart, setAccount, sawItem,
  }
}

export type Shop = ReturnType<typeof useShop>
