import { describe, it, expect, vi, beforeEach } from 'vitest'
import { webcrypto } from 'node:crypto'
import { migrate, bootstrap, getSetting, type SqlDriver } from '@shopos/core'
import { openMemoryDatabase } from '../../../packages/core/src/db/node-driver'
import { MIGRATIONS } from '../../../packages/core/src/db/migrations'
import { toBase64Url } from '../../../packages/core/src/domain/licence'

/**
 * The vendor's switch board on a till: fetched by Rust, checked here, kept on
 * the machine so it holds through a restart with the line down, and replaced
 * only by a newer board the vendor signed.
 */

const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair
const KEYS = [{ kid: 'repair-test', publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))) }]

const machine = new Map<string, string>()
vi.mock('../src/core/device', () => ({
  deviceSetting: (k: string) => machine.get(k) ?? null,
  setDeviceSetting: async (k: string, v: string | null) => { if (v === null) machine.delete(k); else machine.set(k, v); return true },
}))
const portal: { token: string | null } = { token: null }
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => (command === 'switches_fetch' ? portal.token : null),
}))
const { isOff, loadSwitches, takeBoard, forgetSwitches } = await import('../src/core/switches')

async function sign(off: unknown[], issuedAt: string): Promise<string> {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify({ format: 1, kind: 'switches', kid: 'repair-test', issuedAt, off })))
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(encoded)))
  return `${encoded}.${toBase64Url(sig)}`
}

let db: SqlDriver
beforeEach(async () => {
  db = openMemoryDatabase()
  await migrate(db, MIGRATIONS)
  await bootstrap(db, { shopName: 'Test Shop' })
  machine.clear()
  portal.token = null
  forgetSwitches()
})

describe('the switch board on a till', () => {
  it('leaves everything on until a board arrives', async () => {
    await loadSwitches(db, KEYS)
    expect(isOff('startup_sync')).toBe(false)
  })

  it('obeys the portal board, and keeps it for the next start with the line down', async () => {
    portal.token = await sign([{ feature: 'startup_sync', why: 'stalls' }], '2026-10-18T10:00:00Z')
    await loadSwitches(db, KEYS)
    expect(isOff('startup_sync')).toBe(true)

    forgetSwitches()
    portal.token = null
    await loadSwitches(db, KEYS)
    expect(isOff('startup_sync')).toBe(true)
  })

  it('switches off only at the shops a board names', async () => {
    const mine = (await getSetting(db, 'shop_id'))!.slice(0, 8)
    portal.token = await sign([{ feature: 'stock_check', shops: ['ffff0000'], why: 'not you' }, { feature: 'daily_reports', shops: [mine], why: 'you' }], '2026-10-18T10:00:00Z')
    await loadSwitches(db, KEYS)
    expect(isOff('stock_check')).toBe(false)
    expect(isOff('daily_reports')).toBe(true)
  })

  it('will not go back to an older board, so an old "off" cannot undo a newer "on"', async () => {
    portal.token = await sign([], '2026-10-18T12:00:00Z')
    await loadSwitches(db, KEYS)
    expect(await takeBoard(await sign([{ feature: 'startup_sync', why: 'old' }], '2026-10-17T12:00:00Z'), KEYS)).toBe('older')
    expect(isOff('startup_sync')).toBe(false)
  })

  it('ignores a board the vendor did not sign', async () => {
    const forged = await sign([{ feature: 'startup_sync', why: 'x' }], '2026-10-18T10:00:00Z')
    expect(await takeBoard(forged, [])).toBe('NOT_CONFIGURED')
    expect(isOff('startup_sync')).toBe(false)
  })
})
