import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { PeerHealth } from '@shopos/core'
import type { LoopReport } from '../src/core/syncLoop'

/**
 * The line itself, on a screen.
 *
 * `completeness.test.ts` decides what the sentence says; this decides whether
 * anybody ever sees it. The two are worth separating because the ways they fail
 * are unrelated: a wrong sentence is a wrong sentence, and a right sentence in a
 * component nobody renders is a report that goes on quietly printing a figure
 * short by the back counter's takings.
 */

let peers: PeerHealth[] = []
let watchers: ((reports: LoopReport[]) => void)[] = []

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  listPeers: async () => peers,
}))

vi.mock('../src/core/syncLoop', () => ({
  onSyncRound: (fn: (reports: LoopReport[]) => void) => {
    watchers.push(fn)
    return () => { watchers = watchers.filter((w) => w !== fn) }
  },
}))

/* One object, not a fresh one per render. The component's effect depends on
   `db`, so a `useCore` that hands back a new literal every time re-runs the
   effect, sets state, re-renders, and never stops — which is worth knowing
   about the component as well as about this mock. */
const core = { db: {} }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { Completeness } = await import('../src/ui/Completeness')

function peer(over: Partial<PeerHealth> = {}): PeerHealth {
  return {
    deviceId: '1111aaaa-2222-4333-8444-555566667777',
    label: 'Back Counter',
    lastAgreedAt: new Date().toISOString(),
    lastTriedAt: new Date().toISOString(),
    lastError: null,
    waiting: 0,
    behind: 0,
    reach: 'lan',
    clockSkewMs: 0,
    ...over,
  }
}

/** Renders and lets the effect's read settle, which is one microtask. */
async function show() {
  render(<Completeness />)
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { peers = []; watchers = [] })
afterEach(cleanup)

describe('the completeness line', () => {
  it('says nothing at all in a one-till shop', async () => {
    await show()
    expect(document.body.textContent).toBe('')
  })

  it('says a total is short, and by how much', async () => {
    peers = [peer({ behind: 95 })]
    await show()

    expect(screen.getByRole('status').textContent)
      .toContain('Short by 95 changes from Back Counter')
  })

  it('marks a short total so it does not read as a footnote', async () => {
    /* The sentence is the same either way; what differs is whether the figure
       above it can be acted on. A shop reading a total that is wrong needs the
       line to catch the eye, and one reading a total that is right needs it not
       to. */
    peers = [peer({ behind: 95 })]
    await show()
    expect(screen.getByRole('status').className).toContain('short')
  })

  it('does not mark a complete one', async () => {
    peers = [peer()]
    await show()
    const said = screen.getByRole('status')
    expect(said.textContent).toContain('Everything from every till')
    expect(said.className).not.toContain('short')
  })

  it('is announced, so it is not only for people looking at it', async () => {
    peers = [peer({ behind: 3 })]
    await show()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('re-reads when a round lands, because a round is what changes it', async () => {
    peers = [peer({ behind: 95 })]
    await show()
    expect(screen.getByRole('status').textContent).toContain('Short by 95')

    // The back counter's bills arrive.
    peers = [peer()]
    await act(async () => {
      for (const w of [...watchers]) w([])
      await Promise.resolve()
    })

    expect(screen.getByRole('status').textContent).toContain('Everything from every till')
  })

  it('stops listening once the screen is gone', async () => {
    await show()
    expect(watchers).toHaveLength(1)
    cleanup()
    expect(watchers, 'a report screen left open all day must not leak one per visit')
      .toHaveLength(0)
  })
})
