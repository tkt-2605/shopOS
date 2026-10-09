import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { SqlDriver, TillAhead } from '@shopos/core'

/**
 * A till too old for the rest of the shop.
 *
 * The owner's rule: it keeps billing, it says on every screen that it is out
 * of sync until it is updated, and it stops asking the newer till -- only an
 * update here changes the answer. The newer till says which one is out of date
 * rather than "update them both".
 */

const VERSION = 60
let heard: ((a: TillAhead) => void) | null = null
const settings = new Map<string, string>()

const pairedPeers = vi.fn(async () => [{ deviceId: 'newer-till' }] as unknown[])
const syncUntilDone = vi.fn()
const recordAttempt = vi.fn(async () => undefined)

vi.mock('@shopos/core', () => ({
  EXPECTED_SCHEMA_VERSION: 60,
  onTillAhead: (fn: (a: TillAhead) => void) => { heard = fn; return () => { heard = null } },
  pairedPeers: (...a: unknown[]) => pairedPeers(...(a as [])),
  syncUntilDone: (...a: unknown[]) => syncUntilDone(...(a as [])),
  recordAttempt: (...a: unknown[]) => recordAttempt(...(a as [])),
  rememberAddress: vi.fn(async () => undefined),
  SyncHttpError: class extends Error {},
  httpTransport: vi.fn(),
  pruneAcknowledged: vi.fn(async () => undefined),
  serveAs: vi.fn(),
  nextBackoff: (n: number) => (n === 0 ? 1000 : n * 2),
}))
vi.mock('../src/core/device', () => ({
  chosenRegister: () => 'a-counter',
  deviceSetting: (k: string) => settings.get(k) ?? null,
  setDeviceSetting: async (k: string, v: string | null) => {
    if (v === null) settings.delete(k)
    else settings.set(k, v)
    return true
  },
}))
vi.mock('../src/core/syncHost', () => ({
  servingOn: async () => null, lookAround: async () => [], keepTheDoorRight: async () => undefined,
}))
vi.mock('../src/core/log', () => ({ logEvent: vi.fn(), describe: String }))
vi.mock('../src/core/syncFetch', () => ({ syncFetch: vi.fn() }))

const { watchForTillsAhead, outOfDate, caughtUpWith, AHEAD_SETTING } = await import('../src/core/outOfDate')
const { runOnce } = await import('../src/core/syncLoop')
const { OutOfDateBanner } = await import('../src/ui/OutOfDateBanner')
const { explainRefusal } = await import('../src/core/syncWords')

const db = {} as SqlDriver
const ahead: TillAhead = { peer: 'newer-till', theirs: 64, theirFloor: 62, mine: VERSION }
const mismatch = (behind: 'mine' | 'theirs') =>
  ({ ok: false, code: 'SCHEMA_MISMATCH', behind, mine: VERSION, theirs: 64 })

let stop: () => void = () => {}
beforeEach(() => {
  settings.clear()
  syncUntilDone.mockReset()
  recordAttempt.mockClear()
  stop = watchForTillsAhead()
})
afterEach(() => { stop(); cleanup() })

async function hear(a: TillAhead) {
  heard!(a)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('what this till remembers', () => {
  it('keeps the gap on the machine, so it is known before the other till is heard again', async () => {
    await hear(ahead)
    expect(JSON.parse(settings.get(AHEAD_SETTING)!)).toMatchObject({ peer: 'newer-till', theirs: 64 })
    expect(outOfDate()?.theirFloor).toBe(62)
  })

  it('keeps the first "since" when the same gap is heard again', async () => {
    await hear(ahead)
    const first = outOfDate()!.since
    await hear({ ...ahead, theirs: 65 })
    expect(outOfDate()!.since).toBe(first)
  })

  it('reads a record from an older build as nothing, so an update clears it by itself', () => {
    settings.set(AHEAD_SETTING, JSON.stringify({ ...ahead, mine: 58, since: '2026-09-01T00:00:00Z' }))
    expect(outOfDate()).toBeNull()
  })

  it('forgets it once a round with that till works, and not for another till', async () => {
    await hear(ahead)
    await caughtUpWith('some-other-till')
    expect(outOfDate()).not.toBeNull()
    await caughtUpWith('newer-till')
    expect(outOfDate()).toBeNull()
  })
})

describe('the round with a newer till', () => {
  it('stops asking once this till is the one behind', async () => {
    syncUntilDone.mockResolvedValue(mismatch('mine'))
    await runOnce(db)
    await runOnce(db)
    expect(syncUntilDone).toHaveBeenCalledTimes(1)
    expect(recordAttempt).toHaveBeenCalledWith(db, 'newer-till', 'THIS_TILL_OUTDATED')
  })

  it('keeps asking a till that is behind this one, and names that till as the one to update', async () => {
    pairedPeers.mockResolvedValue([{ deviceId: 'older-till' }])
    syncUntilDone.mockResolvedValue(mismatch('theirs'))
    await runOnce(db)
    await runOnce(db)
    expect(syncUntilDone).toHaveBeenCalledTimes(2)
    expect(recordAttempt).toHaveBeenCalledWith(db, 'older-till', 'PEER_OUTDATED')
    expect(explainRefusal('PEER_OUTDATED')).toContain('That till is on an older ShopOS')
  })
})

describe('the banner', () => {
  it('is not there while nothing is out of date', () => {
    render(<OutOfDateBanner />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says the till is out of sync until updated, and that billing goes on', async () => {
    render(<OutOfDateBanner />)
    await hear(ahead)
    const said = screen.getByRole('alert').textContent!
    expect(said).toContain('out of sync with the shop until it is updated')
    expect(said).toContain('You can go on billing')
    expect(said).toContain('version 60')
    expect(said).toContain('version 64')
  })
})
