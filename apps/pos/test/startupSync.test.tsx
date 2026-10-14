import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import type { PeerHealth } from '@shopos/core'
import { StartupSync } from '../src/ui/StartupSync'

/**
 * A till just switched on catches up with the shop before anybody uses it.
 *
 * Seen in a three-till shop: the main came back, and its screens were the
 * shop as it was when it went off until the counters -- backed off -- called
 * again. This screen covers the till until the shop has caught up, and never
 * holds it: an unreachable till is named and may be left behind.
 */

let peers: PeerHealth[] = []
let role: 'main' | 'till' | 'alone' = 'till'
const ran = vi.fn(async () => ({ peers: 1, skipped: false, reports: [] }))

// Only what the screen uses: the whole of core is a slow thing to load for two functions.
vi.mock('@shopos/core', () => ({
  listPeers: async () => peers,
  tillRole: async () => role,
}))
vi.mock('../src/core/syncLoop', () => ({ onSyncRound: () => () => {}, runOnce: (...a: unknown[]) => ran(...(a as [])) }))
/* One core per test, and the same object on every render, as the app's is. */
let core = { db: {}, status: { phase: 'ready' } }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

function peer(over: Partial<PeerHealth> = {}): PeerHealth {
  return {
    deviceId: 'the-main-0000', label: 'Main Register', lastAgreedAt: hoursAgo(2), lastTriedAt: null,
    lastError: null, waiting: 0, behind: 0, reach: 'lan', clockSkewMs: 0, needsPairing: false,
    ...over,
  } as PeerHealth
}

async function show() {
  render(<StartupSync />)
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { peers = []; role = 'till'; ran.mockClear(); core = { db: {}, status: { phase: 'ready' } } })
afterEach(() => cleanup())

describe('a till that has just been switched on', () => {
  it('shows nothing in a shop with no other till to catch up with', async () => {
    role = 'alone'
    await show()
    expect(screen.queryByText('Catching up with the shop')).toBeNull()
  })

  it('covers the till while a counter catches up with the main, asks it at once, and goes when it has', async () => {
    peers = [peer()]
    await show()
    expect(screen.getByText('Catching up with the shop')).toBeTruthy()
    expect(ran).toHaveBeenCalledWith(expect.anything(), true)

    peers = [peer({ lastAgreedAt: new Date(Date.now() + 1000).toISOString() })]
    await waitFor(() => expect(screen.queryByText('Catching up with the shop')).toBeNull(), { timeout: 3000 })
  })

  it('names a main it cannot reach and lets the till start without it, at once', async () => {
    peers = [peer({ lastTriedAt: new Date(Date.now() + 1000).toISOString(), lastError: 'fetch failed' })]
    await show()
    await waitFor(() => expect(document.body.textContent).toContain('Main Register cannot be reached'), { timeout: 3000 })
    expect(screen.getByText('Start without it')).toBeTruthy()
  })

  it('does not wait for a till not heard from in days', async () => {
    peers = [peer({ lastAgreedAt: hoursAgo(24 * 5) })]
    await show()
    await waitFor(() => expect(screen.queryByText('Catching up with the shop')).toBeNull())
  })
})
