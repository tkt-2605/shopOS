import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, createBill, saveDraft, listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts,
  type SqlDriver, type DraftDetail,
} from '@shopos/core'
import { takeRepeat, onRepeat, type RepeatRequest } from './repeat'
import {
  MAX_TABS, emptyCart, snapshotOf, cartFromDraft, cartFromRepeat,
  type Cart, type CartSnapshot,
} from './billCarts'

export { MAX_TABS }
export type { Cart, CartLine } from './billCarts'

/**
 * Several bills open at once at one counter.
 *
 * A customer goes back to the shelf to check something; the cashier opens
 * another tab, serves the next person, and comes back. Each tab is a draft in
 * the database underneath, which is what makes one survive the power going out —
 * a draft moves no stock, posts no ledger entry and takes no invoice number, so
 * holding six of them costs nothing.
 */

const SAVE_DELAY_MS = 600

/**
 * Which tab each counter was looking at. Module-level because the billing screen
 * unmounts whenever the cashier looks at something else, and the answer has to
 * outlive that. Not persisted — "where I was" ends with the process, while the
 * drafts themselves do not.
 */
const lastActive = new Map<string, string>()

export interface BillTabs {
  tabs: Cart[]
  active: Cart
  ready: boolean
  select: (tabId: string) => void
  open: () => void
  close: (tabId: string) => Promise<void>
  /** Edits the active cart. Autosave follows automatically. */
  patch: (change: (cart: Cart) => Cart) => void
  /** Writes any outstanding edit and returns once it is on disk. */
  flush: () => Promise<void>
  /**
   * The active tab's draft as it stands after a flush, read off the ref rather
   * than a render. Null with a reason when the screen's cart is not what is on
   * disk -- paying then would charge the last cart that saved, not this one.
   */
  savedDraft: () => { billId: string } | { billId: null; reason: string }
  /** The active draft became a real bill; forget it and leave an empty tab. */
  released: () => void
  /**
   * What just happened without anyone on this screen asking for it — a tab
   * opened from an old bill, or the reason one could not be.
   */
  notice: string | null
  dismissNotice: () => void
}

export function useBillTabs(db: SqlDriver, registerId: string, actorId: string): BillTabs {
  const [tabs, setTabs] = useState<Cart[]>(() => [emptyCart()])
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]!.tabId)
  const [ready, setReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Autosave state, per tab. Kept in refs so a save in flight is never affected
  // by a re-render, and chained per tab so two quick edits cannot both decide
  // there is no draft yet and create one each.
  const pending = useRef(new Map<string, CartSnapshot>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const chains = useRef(new Map<string, Promise<void>>())
  const billIds = useRef(new Map<string, string | null>())
  /** Why the last write for a tab did not land, until one does. */
  const failures = useRef(new Map<string, string>())
  const live = useRef(true)
  /** The tabs as they stand, readable outside a render. */
  const open_ = useRef<Cart[]>(tabs)
  open_.current = tabs

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const setBillId = useCallback((tabId: string, billId: string | null) => {
    billIds.current.set(tabId, billId)
    if (live.current) {
      setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, billId } : t)))
    }
  }, [])

  const writeNow = useCallback(async (tabId: string, snap: CartSnapshot) => {
    const current = billIds.current.get(tabId) ?? null

    if (snap.lines.length === 0) {
      if (current) {
        await discardDraft(db, { billId: current, actorId })
        setBillId(tabId, null)
      }
      return
    }

    const input = {
      registerId,
      customerId: snap.customerId,
      lines: snap.lines,
      billDiscount: Money.paise(snap.billDiscount),
      convertedFrom: snap.convertedFrom,
      actorId,
    }

    if (current) {
      const saved = await saveDraft(db, { billId: current, ...input })
      if (saved.ok) { failures.current.delete(tabId); return }
      /* Only a draft that has gone -- submitted elsewhere, or discarded -- is
         let go of. Any other refusal is about this edit: a quantity cleared to
         be retyped, an item archived on the other till. Forgetting the draft
         for those left it open in the database and made a second one on the
         next keystroke, and both came back as tabs after a restart. */
      if (saved.code !== 'NOT_A_DRAFT') { failures.current.set(tabId, saved.code); return }
      setBillId(tabId, null)
    }

    const created = await createBill(db, input)
    if (created.ok) {
      failures.current.delete(tabId)
      setBillId(tabId, created.billId)
    } else {
      failures.current.set(tabId, created.code)
    }
  }, [db, registerId, actorId, setBillId])

  const flushTab = useCallback(async (tabId: string) => {
    const timer = timers.current.get(tabId)
    if (timer) { clearTimeout(timer); timers.current.delete(tabId) }

    const snap = pending.current.get(tabId)
    if (!snap) return
    pending.current.delete(tabId)

    const next = (chains.current.get(tabId) ?? Promise.resolve())
      .then(() => writeNow(tabId, snap))
      .catch((err: unknown) => {
        failures.current.set(tabId, err instanceof Error ? err.message : String(err))
      })
    chains.current.set(tabId, next)
    await next
  }, [writeNow])

  const flushAll = useCallback(async () => {
    await Promise.all([...pending.current.keys()].map((id) => flushTab(id)))
  }, [flushTab])

  const queue = useCallback((cart: Cart) => {
    pending.current.set(cart.tabId, snapshotOf(cart))
    const existing = timers.current.get(cart.tabId)
    if (existing) clearTimeout(existing)
    timers.current.set(cart.tabId, setTimeout(() => { void flushTab(cart.tabId) }, SAVE_DELAY_MS))
  }, [flushTab])

  /** Rebuilds a cart from a saved draft, and remembers which draft it is. */
  const hydrate = useCallback(async (detail: DraftDetail): Promise<Cart> => {
    const cart = await cartFromDraft(db, detail)
    billIds.current.set(cart.tabId, detail.billId)
    return cart
  }, [db])

  const repeat = useCallback(async (request: RepeatRequest) => {
    // Read off the ref rather than a flag set inside a state updater: React does
    // not promise to run an updater before the next line, so a decision made in
    // one and read out here is a decision made on stale news.
    if (open_.current.length >= MAX_TABS) {
      // A full counter is a real answer, not a failure: six bills are open, and
      // which of them to finish first is the cashier's call, not this one's.
      setNotice(`All ${MAX_TABS} bills are open here. Finish or cancel one, then try again.`)
      return
    }

    const { cart, missing } = await cartFromRepeat(db, request)

    if (cart.lines.length === 0) {
      setNotice(`Nothing from ${request.docNo} is still in the catalogue.`)
      return
    }

    setTabs((prev) => (prev.length >= MAX_TABS ? prev : [...prev, cart]))
    setActiveTabId(cart.tabId)

    // Saved as a draft straight away, so the tab survives the power going out
    // exactly as a typed one does.
    queue(cart)
    const dropped = missing === 0
      ? ''
      : ` ${missing} item${missing === 1 ? ' is' : 's are'} no longer in the catalogue and could not be added.`
    setNotice(
      request.order
        ? `Billing ${request.docNo} — what is still outstanding, at the rates it promised.`
          + ` The order is marked off when this bill is paid.${dropped}`
        : `${request.docNo} again — ${cart.lines.length} item${cart.lines.length === 1 ? '' : 's'},`
          + ` at today's prices.${dropped}`,
    )
  }, [db, queue])

  // Someone asked for this from the bills screen while this screen was still
  // mounting; and again, live, for the case where it was already open.
  useEffect(() => {
    if (!ready) return
    const outstanding = takeRepeat()
    if (outstanding) void repeat(outstanding)
    return onRepeat((request) => {
      if (takeRepeat()) void repeat(request)
    })
  }, [ready, repeat])

  // Reopen whatever this counter had open. A shop that loses power finds its
  // bills where they were.
  useEffect(() => {
    if (!registerId) return
    let cancelled = false

    void (async () => {
      await pruneEmptyDrafts(db, registerId)
      const open = await listOpenDrafts(db, registerId)

      const restored: Cart[] = []
      for (const summary of open.slice(0, MAX_TABS)) {
        const detail = await loadDraft(db, summary.billId)
        if (detail) restored.push(await hydrate(detail))
      }
      if (cancelled) return

      if (restored.length > 0) {
        setTabs(restored)
        const remembered = lastActive.get(registerId)
        const stillThere = restored.find((t) => t.billId === remembered)
        setActiveTabId(stillThere?.tabId ?? restored[0]!.tabId)
      }
      setReady(true)
    })()

    return () => { cancelled = true }
  }, [db, registerId, hydrate])

  const active = tabs.find((t) => t.tabId === activeTabId) ?? tabs[0]!

  useEffect(() => {
    if (registerId && active.billId) lastActive.set(registerId, active.billId)
  }, [registerId, active.billId])

  const patch = useCallback((change: (cart: Cart) => Cart) => {
    setTabs((prev) => prev.map((t) => {
      if (t.tabId !== activeTabId) return t
      const next = change(t)
      if (!next.hydrating) queue(next)
      return next
    }))
  }, [activeTabId, queue])

  const select = useCallback((tabId: string) => {
    void flushAll()
    setActiveTabId(tabId)
  }, [flushAll])

  const open = useCallback(() => {
    void flushAll()
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev
      const fresh = emptyCart()
      setActiveTabId(fresh.tabId)
      return [...prev, fresh]
    })
  }, [flushAll])

  const savedDraft = useCallback((): { billId: string } | { billId: null; reason: string } => {
    const failed = failures.current.get(activeTabId)
    if (failed) return { billId: null, reason: failed }
    const billId = billIds.current.get(activeTabId) ?? null
    return billId ? { billId } : { billId: null, reason: 'NO_DRAFT' }
  }, [activeTabId])

  const close = useCallback(async (tabId: string) => {
    const timer = timers.current.get(tabId)
    if (timer) { clearTimeout(timer); timers.current.delete(tabId) }
    pending.current.delete(tabId)
    failures.current.delete(tabId)

    const billId = billIds.current.get(tabId) ?? null
    billIds.current.delete(tabId)
    if (billId) await discardDraft(db, { billId, actorId })

    setTabs((prev) => {
      const remaining = prev.filter((t) => t.tabId !== tabId)
      if (remaining.length === 0) {
        const fresh = emptyCart()
        setActiveTabId(fresh.tabId)
        return [fresh]
      }
      setActiveTabId((current) => (current === tabId ? remaining[remaining.length - 1]!.tabId : current))
      return remaining
    })
  }, [db, actorId])

  const released = useCallback(() => {
    const tabId = activeTabId
    const timer = timers.current.get(tabId)
    if (timer) { clearTimeout(timer); timers.current.delete(tabId) }
    pending.current.delete(tabId)
    failures.current.delete(tabId)
    billIds.current.set(tabId, null)

    setTabs((prev) => prev.map((t) => (
      t.tabId === tabId
        ? { ...emptyCart(), tabId }
        : t
    )))
  }, [activeTabId])

  // Leaving the screen writes whatever is outstanding rather than dropping it.
  useEffect(() => () => { void flushAll() }, [flushAll])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return useMemo(
    () => ({
      tabs, active, ready, select, open, close, patch,
      flush: flushAll, savedDraft, released, notice, dismissNotice,
    }),
    [tabs, active, ready, select, open, close, patch, flushAll, savedDraft, released, notice, dismissNotice],
  )
}
