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
    needsPairing: false,
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

/**
 * The dialog the app draws, rather than the one the browser used to.
 *
 * These tests stubbed `window.confirm` and passed, while the real app was not
 * asking at all: Tauri replaces `window.confirm` in the webview with an async
 * shim, every guard here was written `if (!window.confirm(...)) return`, and a
 * promise is always truthy. `useConfirm` exists for exactly that reason and
 * these two screens had not adopted it.
 *
 * So the question is now found and answered the way a person would, which is
 * also the only version of this test that could have failed.
 */
async function answer(yes: boolean) {
  const dialog = await screen.findByRole('dialog')
  const button = Array.from(dialog.querySelectorAll('button'))
    .find((b) => b.textContent === (yes ? 'Yes, go ahead' : 'No, leave it'))
  if (!button) throw new Error('the confirmation had no button to press')
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

/** Whether a question is on screen at all. */
function asking(): boolean {
  return screen.queryByRole('dialog') !== null
}


beforeEach(() => {
  peers = [peer()]
  forgotten = null
})

afterEach(() => cleanup())

describe('a till that is gone', () => {
  it('can be forgotten from the card that lists it', async () => {
    await show()
    expect(screen.getByText('This till is gone')).toBeTruthy()
  })

  it('asks first, and does nothing if the answer is no', async () => {
    /* The counter that till was billing on is released with it. That is the
       point of the action and the reason it must not be a stray click. */
    await show()

    await act(async () => {
      fireEvent.click(screen.getByText('This till is gone'))
      await Promise.resolve()
    })

    expect(asking(), 'a question, before anything happens').toBe(true)
    expect(forgotten, 'and nothing has happened yet').toBeNull()

    await answer(false)
    expect(forgotten, 'nor after saying no').toBeNull()
  })

  it('forgets the till the button belongs to', async () => {
    peers = [peer(), peer({ deviceId: 'the-other-one', label: 'Store room' })]
    await show()

    const buttons = screen.getAllByText('This till is gone')
    await act(async () => {
      fireEvent.click(buttons[1]!)
      await Promise.resolve()
    })
    await answer(true)

    expect(forgotten, 'the second row, not the first').toBe('the-other-one')
  })

  it('says it happened, rather than the row merely vanishing', async () => {
    await show()
    await act(async () => {
      fireEvent.click(screen.getByText('This till is gone'))
      await Promise.resolve()
    })
    await answer(true)

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
