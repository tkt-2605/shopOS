import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'
import { toBase64Url, type SigningKey } from '../src/domain/licence.js'
import { verifyBoard, switchedOff, newer, type SwitchBoard } from '../src/domain/switches.js'

/**
 * Switching a broken feature off at a shop, without a release: only the
 * vendor's board is obeyed, only what may be switched can be, nothing that
 * takes money ever, and an old board cannot undo a newer one.
 */

const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair
const KEYS: SigningKey[] = [{ kid: 'repair-test', publicKey: toBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))) }]
const stranger = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair

const NOW = new Date('2026-10-18T10:00:00Z')
const SHOP = '0192f4a1-77aa-7bcd-8000-000000000001'

async function sign(off: unknown[], over: Record<string, unknown> = {}, key = pair.privateKey): Promise<string> {
  const payload = { format: 1, kind: 'switches', kid: 'repair-test', issuedAt: NOW.toISOString(), off, ...over }
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(encoded)))
  return `${encoded}.${toBase64Url(sig)}`
}

async function board(off: unknown[], over: Record<string, unknown> = {}): Promise<SwitchBoard> {
  const read = await verifyBoard(await sign(off, over), KEYS)
  if (!read.ok) throw new Error(read.code)
  return read.board
}

describe('a switch board', () => {
  it('turns a feature off everywhere, and says why', async () => {
    const b = await board([{ feature: 'startup_sync', why: '0.3.0 stalls on slow lines' }])
    expect(switchedOff(b, 'startup_sync', SHOP, NOW)).toEqual({ off: true, why: '0.3.0 stalls on slow lines' })
    expect(switchedOff(b, 'stock_check', SHOP, NOW)).toEqual({ off: false })
  })

  it('turns it off only at the shops it names, by their short id', async () => {
    const b = await board([{ feature: 'stock_check', shops: ['0192f4a1'], why: 'large catalogue' }])
    expect(switchedOff(b, 'stock_check', SHOP, NOW).off).toBe(true)
    expect(switchedOff(b, 'stock_check', 'ffff0000-0000-7000-8000-000000000000', NOW).off).toBe(false)
  })

  it('turns itself back on at its date', async () => {
    const b = await board([{ feature: 'daily_reports', until: '2026-10-19T00:00:00Z', why: 'mail outage' }])
    expect(switchedOff(b, 'daily_reports', SHOP, NOW).off).toBe(true)
    expect(switchedOff(b, 'daily_reports', SHOP, new Date('2026-10-19T00:00:01Z')).off).toBe(false)
  })

  it('cannot switch off anything that takes money: the whole board is refused', async () => {
    for (const feature of ['billing', 'payments', 'cash', 'sync']) {
      expect(await verifyBoard(await sign([{ feature, why: 'x' }]), KEYS)).toMatchObject({ ok: false, code: 'MALFORMED' })
    }
  })

  it('is obeyed only when the vendor signed it', async () => {
    expect(await verifyBoard(await sign([], {}, stranger.privateKey), KEYS)).toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(await verifyBoard(await sign([]), [])).toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('cannot be replaced by an older board', async () => {
    const held = await board([], { issuedAt: '2026-10-18T10:00:00Z' })
    const older = await board([{ feature: 'startup_sync', why: 'old' }], { issuedAt: '2026-10-17T10:00:00Z' })
    const later = await board([], { issuedAt: '2026-10-18T11:00:00Z' })
    expect(newer(older, held)).toBe(false)
    expect(newer(later, held)).toBe(true)
    expect(newer(older, null)).toBe(true)
  })
})
