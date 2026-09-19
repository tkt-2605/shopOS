import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { PeerHealth } from '@shopos/core'

/**
 * Forgetting a till that is not coming back.
 *
 * There was no way to do this anywhere in the product, and what it cost was not
 * tidiness. `pruneAcknowledged` holds the change feed at the lowest cursor of
 * every peer, so one machine that was sold, stolen or dropped pins the feed of
 * every remaining till for the life of the shop: it grows, every round reads
 * further into it, and nothing anywhere says why.
 *
 * The core of it is proved in `aTillThatIsGone.test.ts` against a real
 * database. This is the button, and the two things the button has to get right
 * are asking first — the counter that till was billing on is released with it —
 * and actually calling the thing.
 */

let peers: PeerHealth[] = []
let forgotten: string | null = null
let asked = 0

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  listPeers: async () => peers,
  recentConflicts: async () => [],
  quarantinedRecords: async () => [],
  getSetting: async () => null,
  offerPairing: () => 'CODE1234',
  withdrawPairing: () => {},
  forgetPeer: async (_db: unknown, id: string) => { forgotten = id },
}))

vi.mock('../src/core/syncLoop', () => ({
  runOnce: async () => [],
  onSyncRound: () => () => {},
}))

vi.mock('../src/core/syncHost', () => ({
  startServing: async () => ({ port: 7801 }),
  stopServing: async () => {},
  servingOn: async () => ({ port: 7801 }),
}))

const core = { db: {}, shopName: 'Test Shop' }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { SyncCard } = await import('../src/ui/SyncCard')

function peer(over: Partial<PeerHealth> = {}): PeerHealth {
  return {
    deviceId: '2222bbbb-2222-4222-8222-222222222222',
    label: 'Back counter',
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

async function show() {
  render(<SyncCard />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  peers = [peer()]
  forgotten = null
  asked = 0
  vi.stubGlobal('confirm', () => { asked += 1; return true })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a till that is gone', () => {
  it('can be forgotten from the card that lists it', async () => {
    await show()
    expect(screen.getByText('This till is gone')).toBeTruthy()
  })

  it('asks first, and does nothing if the answer is no', async () => {
    /* The counter that till was billing on is released with it. That is the
       point of the action and the reason it must not be a stray click. */
    vi.stubGlobal('confirm', () => { asked += 1; return false })
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('This till is gone'))
      await Promise.resolve()
    })

    expect(asked).toBe(1)
    expect(forgotten).toBeNull()
  })

  it('forgets the till the button belongs to', async () => {
    peers = [peer(), peer({ deviceId: 'the-other-one', label: 'Store room' })]
    await show()

    const buttons = screen.getAllByText('This till is gone')
    await act(async () => {
      fireEvent.click(buttons[1]!)
      await Promise.resolve()
    })

    expect(forgotten, 'the second row, not the first').toBe('the-other-one')
  })

  it('says it happened, rather than the row merely vanishing', async () => {
    await show()
    await act(async () => {
      fireEvent.click(screen.getByText('This till is gone'))
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Back counter has been forgotten')
  })
})

describe('what the card shows about a peer', () => {
  it('shows how far behind this till is, which nothing could say before 044', async () => {
    peers = [peer({ behind: 95 })]
    await show()

    const row = screen.getByText('Back counter').closest('tr')
    expect(row?.textContent).toContain('95')
  })

  it('tells a peer that has never said from one that is level', async () => {
    /* Null and zero are different answers. Zero is level as of the last
       handshake; null is a till on a build too old to say, and printing a dash
       for both would claim a completeness nothing has checked. */
    peers = [peer({ behind: null })]
    await show()
    expect(screen.getByText('Back counter').closest('tr')?.textContent).toContain('?')
  })
})
