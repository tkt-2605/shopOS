import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  LICENCE_KEYS, PORTAL_BASE_URL, UPDATE_FEED_URL, licensingConfigured,
} from '../src/config/licensing.js'
import { verifyToken, stateOf, allows, GATED, encodePayload, type LicenceToken } from '../src/domain/licence.js'
import { entitlement, entitled, installToken } from '../src/services/licence.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * A half-configured licensing system must fail loudly, not quietly pass.
 *
 * This build ships with no signing keys, no portal and no update feed, which
 * is correct: none of the three has been decided yet. The danger in that
 * state is not that licences fail -- it is that something, somewhere, treats
 * "cannot check" as "fine" and hands out the cloud tier to anybody. So the
 * placeholder state is pinned here from both directions: nothing verifies,
 * and nothing is entitled.
 *
 * **When the real key is dropped into `config/licensing.ts`, the first three
 * tests here start failing.** That is intended. Change them to assert the
 * shape of the configured build; do not delete them.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('the placeholders as shipped', () => {
  it('has no signing key, no portal and no update feed', () => {
    expect(LICENCE_KEYS).toEqual([])
    expect(PORTAL_BASE_URL).toBeNull()
    expect(UPDATE_FEED_URL).toBeNull()
    expect(licensingConfigured()).toBe(false)
  })

  it('refuses every token with NOT_CONFIGURED rather than BAD_SIGNATURE', async () => {
    const token: LicenceToken = {
      shopId: 'shop-1', tier: 'branches', paidThrough: null,
      tills: 99, issuedAt: new Date().toISOString(), kid: 'whatever',
    }
    const looksReal = `${encodePayload(token)}.${'A'.repeat(86)}`

    const verified = await verifyToken(looksReal, LICENCE_KEYS)
    /* The distinction matters at three in the morning: BAD_SIGNATURE sends
       somebody looking for an attacker, NOT_CONFIGURED sends them to the one
       file they have to edit. */
    expect(verified).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('entitles a shop to nothing beyond a working till', async () => {
    const state = await entitlement(fx.db)
    expect(state).toMatchObject({ tier: 'single', state: 'none' })

    for (const feature of GATED) {
      expect(await entitled(fx.db, feature), feature).toBe(false)
    }
  })

  it('will not install a token it cannot check', async () => {
    const token: LicenceToken = {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2099-01-01',
      tills: 9, issuedAt: new Date().toISOString(), kid: 'made-up',
    }
    const installed = await installToken(
      fx.db, { actorId: 'someone' }, `${encodePayload(token)}.${'A'.repeat(86)}`,
    )
    expect(installed).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })

    const stored = await fx.db.get('SELECT value FROM settings WHERE key = ?', ['licence_token'])
    expect(stored).toBeUndefined()
  })
})

describe('tokens that are not tokens', () => {
  it('refuses rubbish without throwing', async () => {
    const keys = [{ kid: 'k', publicKey: 'A'.repeat(43) }]
    for (const rubbish of [
      '', '.', 'a.', '.b', 'not-a-token', 'one.two.three',
      'AAAA.BBBB', '!!!.???', 'a'.repeat(5000),
    ]) {
      const result = await verifyToken(rubbish, keys)
      expect(result.ok, rubbish.slice(0, 20)).toBe(false)
    }
  })

  it('refuses a payload that is JSON but not a licence', async () => {
    const keys = [{ kid: 'k', publicKey: 'A'.repeat(43) }]
    const encode = (value: unknown) =>
      `${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'A'.repeat(86)}`

    for (const wrong of [
      {},
      { shopId: 'x' },
      { shopId: 'x', tier: 'unlimited', paidThrough: null, tills: 1, issuedAt: 'now', kid: 'k' },
      { shopId: 'x', tier: 'cloud', paidThrough: '31-03-2027', tills: 1, issuedAt: 'now', kid: 'k' },
      { shopId: 'x', tier: 'cloud', paidThrough: null, tills: 0, issuedAt: 'now', kid: 'k' },
      { shopId: 'x', tier: 'cloud', paidThrough: null, tills: 1.5, issuedAt: 'now', kid: 'k' },
      { shopId: '', tier: 'cloud', paidThrough: null, tills: 1, issuedAt: 'now', kid: 'k' },
      [1, 2, 3],
      'a string',
      null,
    ]) {
      expect((await verifyToken(encode(wrong), keys)).ok, JSON.stringify(wrong)).toBe(false)
    }
  })
})

describe('the rules that do not need a key', () => {
  const token = (paidThrough: string | null): LicenceToken => ({
    shopId: 's', tier: 'cloud', paidThrough, tills: 1, issuedAt: '2026-01-01T00:00:00Z', kid: 'k',
  })

  it('treats the last paid-for day as a whole day', () => {
    // Not an instant. A licence paid through the 31st is good all of the 31st.
    expect(stateOf(token('2026-09-30'), '2026-09-30').state).toBe('active')
    expect(stateOf(token('2026-09-30'), '2026-10-01').state).toBe('grace')
  })

  it('never expires a perpetual licence', () => {
    expect(stateOf(token(null), '2099-12-31')).toEqual({ state: 'active', graceUntil: null })
  })

  it('ranks the tiers rather than treating them as a set of flags', () => {
    expect(allows({ tier: 'branches', state: 'active' }, 'cloudPeer')).toBe(true)
    expect(allows({ tier: 'cloud', state: 'active' }, 'branches')).toBe(false)
    expect(allows({ tier: 'single', state: 'active' }, 'cloudPeer')).toBe(false)
  })

  it('keeps everything on through grace and nothing on after it', () => {
    for (const feature of GATED) {
      expect(allows({ tier: 'branches', state: 'grace' }, feature), feature).toBe(true)
      expect(allows({ tier: 'branches', state: 'lapsed' }, feature), feature).toBe(false)
      expect(allows({ tier: 'branches', state: 'none' }, feature), feature).toBe(false)
    }
  })

  it('gates nothing a till does on its own', () => {
    /* The list is the guarantee. Anything a shop needs to take money -- a
       bill, a receipt, a print, a backup, the LAN -- must never appear here,
       and this test is what an addition has to get past. */
    expect([...GATED].sort()).toEqual(
      ['branches', 'cloudPeer', 'diagnosticsUpload', 'phoneView'],
    )
  })
})
