import { describe, it, expect, vi } from 'vitest'
import type { AvailableUpdate, SqlDriver } from '@shopos/core'

/**
 * A release made for some shops only: the till asks the feed as always, and
 * a release that is not for its shop looks exactly like no release at all.
 */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const logEvent = vi.fn()
vi.mock('../src/core/log', () => ({ logEvent: (...a: unknown[]) => logEvent(...a), describe: String }))

const { createUpdater } = await import('../src/core/updater')

const TRT = '01a1256f-3b1b-4f79-b255-4d86f4a64e3c'

function updaterFor(found: AvailableUpdate, shopId: string | null) {
  return createUpdater({
    db: {} as SqlDriver,
    interval: false,
    shopId: async () => shopId,
    source: {
      check: async () => found,
      download: async () => {},
      install: async () => {},
    },
  })
}

const release = (shops?: unknown): AvailableUpdate => ({
  version: '0.3.0', notes: '', publishedAt: null, ...(shops === undefined ? {} : { shops }),
})

describe('a release for some shops', () => {
  it('is offered to a shop it names', async () => {
    const stage = await updaterFor(release({ only: ['01a1256f'] }), TRT).poll(true)
    expect(stage.stage).toBe('available')
  })

  it('is not offered to a shop it leaves out, and says why only in the log', async () => {
    const stage = await updaterFor(release({ only: ['51c78eec'] }), TRT).poll(true)
    expect(stage.stage).toBe('idle')
    expect(logEvent).toHaveBeenCalledWith('info', 'updater', expect.stringContaining('not-listed'))
  })

  it('is held back from a shop on the hold list', async () => {
    const stage = await updaterFor(release({ hold: ['01a1256f'] }), TRT).poll(true)
    expect(stage.stage).toBe('idle')
  })

  it('is offered to everybody when the release names no shops, as before', async () => {
    expect((await updaterFor(release(), TRT).poll(true)).stage).toBe('available')
    expect((await updaterFor(release(), null).poll(true)).stage).toBe('available')
  })

  it('is offered when the shops field is nonsense, rather than stranding the till', async () => {
    expect((await updaterFor(release('everyone please'), TRT).poll(true)).stage).toBe('available')
  })

  it('is halted for every shop at 0%', async () => {
    expect((await updaterFor(release({ percent: 0 }), TRT).poll(true)).stage).toBe('idle')
  })
})
