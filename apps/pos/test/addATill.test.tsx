import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

/**
 * The first till, at the moment it lets a second one in.
 *
 * A till that has never been asked which counter it is bills on the shop's
 * first one, and stops guessing as soon as it knows another till exists --
 * which is right, and meant the shop's main counter stopped billing the moment
 * a second till joined, with "Which counter is this?" where the bill should
 * be. Found on a real pair of tills. It is answered now, while there is still
 * only one till to answer for.
 */

let chosen: string | null = null
const taken: string[] = []
const reloadRegister = vi.fn(async () => undefined)

vi.mock('@shopos/core', async (real) => ({
  ...(await real<Record<string, unknown>>()),
  listPeers: async () => [],
  recentConflicts: async () => [],
  quarantinedRecords: async () => [],
  getSetting: async () => null,
  entitled: async () => true,
  /* Which till is the main, asked by the card on mount. This one is: it is
     the till letting others in. Unmocked, it was asked of the fake `db` and
     threw after every test, outside it, as an unhandled error. */
  tillRole: async () => 'main',
  mainTill: async () => ({ device: 'this-till', epoch: 1 }),
  offerPairing: () => 'CODE1234',
  withdrawPairing: () => {},
}))
vi.mock('../src/core/syncLoop', () => ({ runOnce: async () => [], onSyncRound: () => () => {} }))
vi.mock('../src/core/syncHost', () => ({
  startServing: async () => ({ port: 7801 }),
  stopServing: async () => {},
  servingOn: async () => null,
}))
vi.mock('../src/core/device', () => ({ chosenRegister: () => chosen }))
vi.mock('../src/core/counters', () => ({
  takeCounter: async (_db: unknown, id: string) => { taken.push(id); chosen = id; return { ok: true as const } },
}))

const core = { db: {}, shop: { name: 'Test Shop' }, shopName: 'Test Shop', registerId: 'main-counter', reloadRegister }
vi.mock('../src/core/CoreProvider', () => ({ useCore: () => core }))

const { SyncCard } = await import('../src/ui/SyncCard')

beforeEach(() => { chosen = null; taken.length = 0; reloadRegister.mockClear() })
afterEach(cleanup)

async function addATill() {
  render(<SyncCard />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await act(async () => { fireEvent.click(screen.getByText('Add a till')) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('letting a second till in', () => {
  it('writes down the counter this till was already billing on, before anybody joins', async () => {
    await addATill()
    expect(taken).toEqual(['main-counter'])
    expect(reloadRegister).toHaveBeenCalled()
    expect(screen.getByText('CODE1234')).toBeTruthy()
  })

  it('leaves a counter somebody already chose alone', async () => {
    chosen = 'front-counter'
    await addATill()
    expect(taken).toEqual([])
  })
})
