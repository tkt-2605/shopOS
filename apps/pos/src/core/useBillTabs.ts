import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Money, Quantity, Pricing, Totals,
  createBill, saveDraft, listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts,
  productsByIds, saleUnitsFor, searchCustomers,
  pricingContextFor, resolveLinePrice,
  type SqlDriver, type DraftDetail, type BillLineInput,
  type ProductListItem, type CustomerListItem, type SaleUnitOption,
} from '@shopos/core'
import { takeRepeat, onRepeat, type RepeatRequest } from './repeat'

/**
 * Several bills open at once at one counter.
 *
 * A customer goes back to the shelf to check something; the cashier opens
 * another tab, serves the next person, and comes back. Each tab is a draft in
 * the database underneath, which is what makes one survive the power going out —
 * a draft moves no stock, posts no ledger entry and takes no invoice number, so
 * holding six of them costs nothing.
 */

export interface CartLine {
  key: string
  product: ProductListItem
  saleUnit: string
  units: SaleUnitOption[]
  /** Display units, not scaled. */
  qty: number
  rate: number
  source: Pricing.PriceSource
  sourceId: string | null
  manual: boolean
}

export interface Cart {
  tabId: string
  /** The draft row. Null until the tab has its first line. */
  billId: string | null
  lines: CartLine[]
  customer: CustomerListItem | null
  discount: string
  error: string | null
  /** True while being rebuilt from a draft; autosave must not run. */
  hydrating: boolean
}

export const MAX_TABS = 6

const SAVE_DELAY_MS = 600

/**
 * Which tab each counter was looking at. Module-level because the billing screen
 * unmounts whenever the cashier looks at something else, and the answer has to
 * outlive that. Not persisted — "where I was" ends with the process, while the
 * drafts themselves do not.
 */
const lastActive = new Map<string, string>()

let seq = 0
const nextTabId = () => `tab-${++seq}`

function emptyCart(): Cart {
  return {
    tabId: nextTabId(),
    billId: null,
    lines: [],
    customer: null,
    discount: '',
    error: null,
    hydrating: false,
  }
}

function snapshotOf(cart: Cart): { customerId: string | null; billDiscount: number; lines: BillLineInput[] } {
  const lines = cart.lines.map((line): BillLineInput => ({
    productId: line.product.id,
    saleUnit: line.saleUnit,
    qty: Quantity.fromUnits(line.qty),
    // A typed rate is the cashier's; anything else is passed back as already
    // resolved so a held bill is not re-priced behind the customer.
    ...(line.manual
      ? { rateOverride: line.rate as never }
      : { resolved: { rate: line.rate as never, source: line.source, sourceId: line.sourceId } }),
  }))

  // The clamped figure, not the typed one. The service rejects a discount larger
  // than the part of the bill that may carry it, and a rejected autosave is
  // invisible — the cashier would go on billing against a draft that stopped
  // saving. The screen shows the clamp; this sends what the screen shows.
  const totals = Totals.computeTotals(
    cart.lines.map((l) => ({
      qty: Quantity.fromUnits(l.qty),
      rate: l.rate as never,
      taxRateBp: l.product.taxRateBp,
      discountBlocked: l.product.discountBlocked,
    })),
    (Money.parseMoney(cart.discount) ?? 0) as never,
  )

  return {
    customerId: cart.customer?.id ?? null,
    billDiscount: totals.discount,
    lines,
  }
}

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
  const pending = useRef(new Map<string, ReturnType<typeof snapshotOf>>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const chains = useRef(new Map<string, Promise<void>>())
  const billIds = useRef(new Map<string, string | null>())
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

  const writeNow = useCallback(async (tabId: string, snap: ReturnType<typeof snapshotOf>) => {
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
      actorId,
    }

    if (current) {
      const saved = await saveDraft(db, { billId: current, ...input })
      if (saved.ok) return
      // The draft went away underneath us — submitted elsewhere, or discarded.
      setBillId(tabId, null)
    }

    const created = await createBill(db, input)
    if (created.ok) setBillId(tabId, created.billId)
  }, [db, registerId, actorId, setBillId])

  const flushTab = useCallback(async (tabId: string) => {
    const timer = timers.current.get(tabId)
    if (timer) { clearTimeout(timer); timers.current.delete(tabId) }

    const snap = pending.current.get(tabId)
    if (!snap) return
    pending.current.delete(tabId)

    const next = (chains.current.get(tabId) ?? Promise.resolve())
      .then(() => writeNow(tabId, snap))
      .catch(() => undefined)
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

  /** Rebuilds a cart from a saved draft. */
  const hydrate = useCallback(async (detail: DraftDetail): Promise<Cart> => {
    const products = await productsByIds(db, detail.lines.map((l) => l.productId))
    const byId = new Map(products.map((p) => [p.id, p]))

    const lines: CartLine[] = []
    for (const [i, saved] of detail.lines.entries()) {
      const product = byId.get(saved.productId)
      if (!product) continue
      lines.push({
        key: `${saved.productId}-${i}-${Date.now()}`,
        product,
        saleUnit: saved.saleUnit,
        units: await saleUnitsFor(db, saved.productId),
        qty: Quantity.toUnits(saved.qty),
        rate: saved.rate,
        source: saved.priceSource,
        sourceId: saved.priceSourceId,
        manual: saved.priceSource === 'manual_override',
      })
    }

    let customer: CustomerListItem | null = null
    if (detail.customerId) {
      const found = await searchCustomers(db, detail.customerName ?? '')
      customer = found.find((c) => c.id === detail.customerId) ?? null
    }

    const cart: Cart = {
      tabId: nextTabId(),
      billId: detail.billId,
      lines,
      customer,
      discount: detail.billDiscount > 0 ? Money.format(detail.billDiscount) : '',
      error: null,
      hydrating: false,
    }
    billIds.current.set(cart.tabId, detail.billId)
    return cart
  }, [db])

  /**
   * Builds a tab from an old bill.
   *
   * Priced today, not as it was priced then. What the customer bought is a fact
   * about the past; what it costs is a fact about now, and a March rate quietly
   * reappearing on a September bill is the kind of thing nobody notices until
   * the month's margin is short.
   *
   * An item that has since been removed from the catalogue is dropped and said
   * out loud, rather than making a tab that is silently short a line.
   */
  const buildRepeat = useCallback(async (request: RepeatRequest): Promise<{ cart: Cart; missing: number }> => {
    const products = await productsByIds(db, request.lines.map((l) => l.productId))
    const byId = new Map(products.map((p) => [p.id, p]))

    let customer: CustomerListItem | null = null
    if (request.customerId) {
      const found = await searchCustomers(db)
      customer = found.find((c) => c.id === request.customerId) ?? null
    }

    const pricing = await pricingContextFor(db, customer?.id ?? null)
    const lines: CartLine[] = []
    let missing = 0

    for (const [i, wanted] of request.lines.entries()) {
      const product = byId.get(wanted.productId)
      if (!product) { missing += 1; continue }

      const units = await saleUnitsFor(db, product.id)
      // The unit it was sold in, if the shop still sells in it.
      const unit = units.find((u) => u.saleUnit === wanted.saleUnit)?.saleUnit
        ?? units.find((u) => u.isDefault)?.saleUnit
        ?? product.baseUnit

      const resolved = await resolveLinePrice(db, pricing, {
        productId: product.id,
        saleUnit: unit,
        qty: Quantity.fromUnits(wanted.qty),
      })

      lines.push({
        key: `${product.id}-repeat-${i}-${Date.now()}`,
        product,
        saleUnit: unit,
        units,
        qty: wanted.qty,
        rate: resolved.rate,
        source: resolved.source,
        sourceId: resolved.sourceId,
        manual: false,
      })
    }

    return {
      cart: { ...emptyCart(), lines, customer },
      missing,
    }
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

    const { cart, missing } = await buildRepeat(request)

    if (cart.lines.length === 0) {
      setNotice(`Nothing from ${request.docNo} is still in the catalogue.`)
      return
    }

    setTabs((prev) => (prev.length >= MAX_TABS ? prev : [...prev, cart]))
    setActiveTabId(cart.tabId)

    // Saved as a draft straight away, so the tab survives the power going out
    // exactly as a typed one does.
    queue(cart)
    setNotice(
      missing === 0
        ? `${request.docNo} again — ${cart.lines.length} item${cart.lines.length === 1 ? '' : 's'}, at today's prices.`
        : `${request.docNo} again, at today's prices. ${missing} item${missing === 1 ? ' is' : 's are'} no longer in the catalogue and could not be added.`,
    )
  }, [buildRepeat, queue])

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

  const close = useCallback(async (tabId: string) => {
    const timer = timers.current.get(tabId)
    if (timer) { clearTimeout(timer); timers.current.delete(tabId) }
    pending.current.delete(tabId)

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
      flush: flushAll, released, notice, dismissNotice,
    }),
    [tabs, active, ready, select, open, close, patch, flushAll, released, notice, dismissNotice],
  )
}
