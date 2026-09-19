import { useEffect, useRef } from 'react'
import { onSyncRound } from './syncLoop'

/**
 * Re-reads a screen when the other till changes something.
 *
 * A till is a window onto a database another machine can write to. Rows arrive
 * on their own — a sale rung up at the front counter, a price corrected in the
 * back — and a screen that read its list once is showing yesterday from the
 * moment they land. What that felt like was a till where you had to walk to
 * another page and back to see the bill your colleague had just taken, which
 * reads as "the sync is broken" even though the rows were already there.
 *
 * Only when a round actually **received** something. A round that sent our own
 * changes and pulled nothing has told this screen nothing it does not know, and
 * re-querying every list in the shop every time we push a bill is work for no
 * one. A refusal is not news either: nothing moved.
 *
 * The callback is held in a ref so a page can pass a fresh closure on every
 * render — which every page does, since `refresh` closes over its filters —
 * without resubscribing each time.
 */
export function useShopChanged(refresh: () => void | Promise<void>): void {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => onSyncRound((reports) => {
    if (reports.some((r) => r.ok && r.received > 0)) void latest.current()
  }), [])
}
