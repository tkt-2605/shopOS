import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { SqlDriver } from '@shopos/core'

/**
 * A till restored from its own backup holds billing until it has caught up.
 *
 * The bills it rang up between the backup and the restore are on the other
 * tills and not here, so its number series is behind numbers already printed.
 */

const settings = new Map<string, string>()
const adoptRestoredIdentity = vi.fn(async () => ({ counters: 1, peersForgotten: 1 }))
let replaced: string | null = null

vi.mock('@shopos/core', () => ({
  adoptRestoredIdentity: (...a: unknown[]) => adoptRestoredIdentity(...(a as [])),
  setReplacedDevice: (id: string | null) => { replaced = id },
}))
vi.mock('../src/core/device', () => ({
  deviceSetting: (k: string) => settings.get(k) ?? null,
  setDeviceSetting: async (k: string, v: string | null) => {
    if (v === null) settings.delete(k)
    else settings.set(k, v)
    return true
  },
}))

const {
  settleRestore, restoreHold, caughtUpAfterRestore, RESTORE_SETTING,
} = await import('../src/core/restoreHold')
const { RestoreHoldBanner } = await import('../src/ui/RestoreHoldBanner')

const db = {} as SqlDriver
const OLD = '22222222-2222-4222-8222-222222222222'
const restored = () => settings.set(RESTORE_SETTING, JSON.stringify({ replaces: OLD, at: '2026-09-26T10:00:00.000Z' }))

beforeEach(() => {
  settings.clear()
  replaced = null
  adoptRestoredIdentity.mockClear()
  adoptRestoredIdentity.mockResolvedValue({ counters: 1, peersForgotten: 1 })
})
afterEach(() => cleanup())

describe('a till restored from its own backup', () => {
  it('holds billing, adopts once, and names the till it replaces for the next pairing', async () => {
    restored()
    await settleRestore(db)
    await settleRestore(db)

    expect(adoptRestoredIdentity).toHaveBeenCalledTimes(1)
    expect(replaced).toBe(OLD)
    expect(restoreHold()?.since).toBe('2026-09-26T10:00:00.000Z')
  })

  it('is not held in a shop with no other till to catch up with', async () => {
    adoptRestoredIdentity.mockResolvedValue({ counters: 1, peersForgotten: 0 })
    restored()
    await settleRestore(db)

    expect(restoreHold()).toBeNull()
    expect(settings.has(RESTORE_SETTING)).toBe(false)
    expect(replaced).toBeNull()
  })

  it('lets go once a sync has caught up', async () => {
    restored()
    await settleRestore(db)
    await caughtUpAfterRestore()

    expect(restoreHold()).toBeNull()
    expect(replaced).toBeNull()
  })

  it('goes on billing when a person says so, still naming the old till for pairing', async () => {
    restored()
    await settleRestore(db)
    render(<RestoreHoldBanner />)
    expect(screen.getByText(/Billing is held on this till/)).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByText('Bill anyway')) })

    expect(restoreHold()).toBeNull()
    expect(screen.queryByText(/Billing is held on this till/)).toBeNull()
    expect(JSON.parse(settings.get(RESTORE_SETTING)!).replaces).toBe(OLD)
  })
})
