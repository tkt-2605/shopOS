import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createBill, saveDraft, listOpenDrafts, loadDraft, discardDraft, pruneEmptyDrafts,
  Money,
  type SqlDriver, type OpenDraft, type DraftDetail, type BillLineInput,
} from '@shopos/core'

/**
 * Keeps the bill on screen and the draft in the database in step.
 *
 * The counter used to hold the cart in React state alone, so leaving the screen
 * threw it away without a word. A bill in progress is a draft — which moves no
 * stock, takes no invoice number and survives the power going out — so persisting
 * it costs nothing and buys both crash safety and held bills at once.
 */

export interface CartSnapshot {
  customerId: string | null
  billDiscount: number
  lines: BillLineInput[]
}

/**
 * Which bill each counter is in the middle of. Module-level because the billing
 * screen unmounts whenever the cashier looks at something else, and the answer
 * must outlive that; it is deliberately not persisted, because "where I was" ends
 * with the process while the draft itself does not.
 */
const inProgress = new Map<string, string>()

const SAVE_DELAY_MS = 600

export interface DraftBill {
  billId: string | null
  drafts: OpenDraft[]
  /** Queues a save. Safe to call on every keystroke. */
  touch: (snapshot: CartSnapshot) => void
  /** Writes immediately and returns once the draft is on disk. */
  flush: () => Promise<void>
  hold: () => Promise<void>
  resume: (billId: string) => Promise<DraftDetail | null>
  discard: (billId: string) => Promise<void>
  /** The draft became a real bill; stop tracking it. */
  release: () => void
  refresh: () => Promise<void>
}

export function useDraftBill(db: SqlDriver, registerId: string, actorId: string): DraftBill {
  const [billId, setBillId] = useState<string | null>(() => inProgress.get(registerId) ?? null)
  const [drafts, setDrafts] = useState<OpenDraft[]>([])

  const pending = useRef<CartSnapshot | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Saves are chained rather than fired in parallel, so two quick edits cannot
  // both decide there is no draft yet and create one each.
  const chain = useRef<Promise<void>>(Promise.resolve())

  const remember = useCallback((id: string | null) => {
    if (id) inProgress.set(registerId, id)
    else inProgress.delete(registerId)
    setBillId(id)
  }, [registerId])

  const refresh = useCallback(async () => {
    if (!registerId) return
    setDrafts(await listOpenDrafts(db, registerId))
  }, [db, registerId])

  const writeNow = useCallback(async (snapshot: CartSnapshot): Promise<void> => {
    const current = inProgress.get(registerId) ?? null

    if (snapshot.lines.length === 0) {
      if (current) {
        await discardDraft(db, { billId: current, actorId })
        remember(null)
        await refresh()
      }
      return
    }

    if (current) {
      const saved = await saveDraft(db, {
        billId: current,
        registerId,
        customerId: snapshot.customerId,
        lines: snapshot.lines,
        billDiscount: Money.paise(snapshot.billDiscount),
        actorId,
      })
      if (saved.ok) {
        await refresh()
        return
      }
      // The draft went away underneath us — submitted elsewhere, or discarded.
      remember(null)
    }

    const created = await createBill(db, {
      registerId,
      customerId: snapshot.customerId,
      lines: snapshot.lines,
      billDiscount: Money.paise(snapshot.billDiscount),
      actorId,
    })
    if (created.ok) {
      remember(created.billId)
      await refresh()
    }
  }, [db, registerId, actorId, remember, refresh])

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const snapshot = pending.current
    if (!snapshot) return
    pending.current = null

    chain.current = chain.current.then(() => writeNow(snapshot)).catch(() => undefined)
    await chain.current
  }, [writeNow])

  const touch = useCallback((snapshot: CartSnapshot) => {
    pending.current = snapshot
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, SAVE_DELAY_MS)
  }, [flush])

  // Leaving the screen writes whatever is outstanding rather than dropping it.
  // This is the case the whole hook exists for.
  useEffect(() => () => { void flush() }, [flush])

  useEffect(() => {
    void (async () => {
      if (!registerId) return
      await pruneEmptyDrafts(db, registerId)
      await refresh()
    })()
  }, [db, registerId, refresh])

  const hold = useCallback(async () => {
    await flush()
    remember(null)
    await refresh()
  }, [flush, remember, refresh])

  const resume = useCallback(async (id: string): Promise<DraftDetail | null> => {
    await flush()
    const detail = await loadDraft(db, id)
    if (!detail) {
      await refresh()
      return null
    }
    remember(id)
    return detail
  }, [db, flush, remember, refresh])

  const discard = useCallback(async (id: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = null
    await discardDraft(db, { billId: id, actorId })
    if ((inProgress.get(registerId) ?? null) === id) remember(null)
    await refresh()
  }, [db, actorId, registerId, remember, refresh])

  const release = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = null
    remember(null)
    void refresh()
  }, [remember, refresh])

  return { billId, drafts, touch, flush, hold, resume, discard, release, refresh }
}
