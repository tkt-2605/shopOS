import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { LoopReport } from '../src/core/syncLoop'
import { useShopChanged } from '../src/core/useShopChanged'

/**
 * A screen re-reading when the other till sends something.
 *
 * The complaint this answers: sync worked, and you still had to walk to another
 * page and back to see the bill your colleague had just taken. The rows were
 * already in the database — nothing was asking for them again.
 *
 * The loop is stubbed down to its subscription, which is the whole of what the
 * hook touches. That `onSyncRound` reaches more than one watcher at a time is a
 * fact about the loop and is asserted there.
 */

let watchers: ((reports: LoopReport[]) => void)[] = []

vi.mock('../src/core/syncLoop', () => ({
  onSyncRound: (fn: (reports: LoopReport[]) => void) => {
    watchers.push(fn)
    return () => { watchers = watchers.filter((w) => w !== fn) }
  },
}))

function Screen({ onChange }: { onChange: () => void }) {
  useShopChanged(onChange)
  return null
}

function report(over: Partial<LoopReport> = {}): LoopReport {
  return { peer: 'the-other-till', ok: true, received: 0, sent: 0, contested: 0, quarantined: 0, ...over }
}

/** A round landing, the way the loop announces one. */
function landed(...reports: LoopReport[]) {
  act(() => { for (const w of [...watchers]) w(reports) })
}

beforeEach(() => { watchers = [] })
afterEach(cleanup)

describe('a screen that follows the other till', () => {
  it('re-reads when a round brought something in', () => {
    const refresh = vi.fn()
    render(<Screen onChange={refresh} />)

    landed(report({ received: 4 }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not re-read when the round only sent our own changes', () => {
    /* Every bill this till takes ends in a round. Re-querying every list on
       screen each time we push one is work with nothing to show for it — we
       already have our own rows. */
    const refresh = vi.fn()
    render(<Screen onChange={refresh} />)

    landed(report({ sent: 9 }))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not re-read on a refusal', () => {
    // Nothing moved, so there is nothing new to show.
    const refresh = vi.fn()
    render(<Screen onChange={refresh} />)

    landed(report({ ok: false, received: 0, error: 'SAME_REGISTER' }))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('re-reads when any one till in a mesh sent something', () => {
    const refresh = vi.fn()
    render(<Screen onChange={refresh} />)

    landed(report({ sent: 2 }), report({ peer: 'the-third-till', received: 1 }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops listening once the screen is gone', () => {
    const refresh = vi.fn()
    render(<Screen onChange={refresh} />).unmount()

    landed(report({ received: 1 }))
    expect(refresh).not.toHaveBeenCalled()
    expect(watchers).toHaveLength(0)
  })

  it('calls the newest closure, not the one from the first render', () => {
    /* Every page's `refresh` closes over its filters, so it is a fresh function
       on every render. Holding the first would re-read last week's date range
       for as long as the screen stayed open — and resubscribing on each render
       instead would churn the watcher set on every keystroke. */
    const first = vi.fn()
    const second = vi.fn()
    const view = render(<Screen onChange={first} />)
    view.rerender(<Screen onChange={second} />)

    landed(report({ received: 1 }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(watchers).toHaveLength(1)
  })
})
