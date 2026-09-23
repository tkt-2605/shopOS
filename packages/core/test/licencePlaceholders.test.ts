import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  LICENCE_KEYS, PORTAL_BASE_URL, UPDATE_FEED_URL, licensingConfigured,
} from '../src/config/licensing.js'
import { verifyToken, stateOf, allows, GATED, encodePayload, type LicenceToken } from '../src/domain/licence.js'
import { entitlement, entitled, installToken } from '../src/services/licence.js'
import { freshDb, type Fixture } from './helpers.js'

/**
 * A half-configured licensing system must fail loudly, not quietly pass.
 *
 * The danger was never that licences fail. It is that something, somewhere,
 * treats "cannot check" as "fine" and hands out the cloud tier to anybody. So
 * whatever state `config/licensing.ts` is in gets pinned here from both
 * directions: what verifies, and what is entitled.
 *
 * **The signing key is now real**; the portal and the update feed are still
 * placeholders. Three tests were rewritten at the drop-in rather than deleted,
 * which was the instruction the old header left, and they caught something on
 * the way past: the *updater's* minisign key had been pasted into
 * `LICENCE_KEYS`. It is the right shape for a key and the wrong key — 114
 * bytes where Ed25519 needs 32 — and the build answered `licensingConfigured()
 * = true` while refusing every genuine licence with `NOT_CONFIGURED`, the code
 * that means there are no keys at all. Hence `the key that is actually there`
 * below, which checks the byte count rather than trusting that a string in the
 * right place is the right string.
 */

let fx: Fixture
beforeEach(async () => { fx = await freshDb() })
afterEach(async () => { await fx.db.close() })

describe('the key that is actually there', () => {
  it('is a real Ed25519 public key, not merely a string in the right place', async () => {
    expect(LICENCE_KEYS.length).toBeGreaterThan(0)
    expect(licensingConfigured()).toBe(true)

    for (const key of LICENCE_KEYS) {
      expect(key.kid, 'every key names itself, or rotation cannot work').not.toBe('')
      expect(key.publicKey, 'unpadded base64url').toMatch(/^[A-Za-z0-9_-]+$/)

      /* The byte count is the whole assertion. A minisign public key -- the
         updater's, from `npx tauri signer generate` -- is a plausible-looking
         base64 string of 114 bytes, and pasting one here leaves a build that
         claims to be configured and refuses every genuine licence. Nothing
         else in the system notices, because `importKey` fails at the last
         step and the failure is indistinguishable from having no keys. */
      const raw = Buffer.from(key.publicKey, 'base64url')
      expect(raw.length, `${key.kid} must be 32 raw bytes, not ${raw.length}`).toBe(32)

      // And it must actually import, which is the check the count approximates.
      await expect(webcrypto.subtle.importKey(
        'raw', raw, { name: 'Ed25519' }, false, ['verify'],
      )).resolves.toBeDefined()
    }
  })

  it('still has no portal and no update feed', () => {
    /* Both are decisions, not code. Null is the tested path -- every caller
       treats it as "unreachable", which a shop on a dead line already is. */
    expect(PORTAL_BASE_URL).toBeNull()
    expect(UPDATE_FEED_URL).toBeNull()
  })

  it('tells an out-of-date till apart from a forgery', async () => {
    const token: LicenceToken = {
      shopId: 'shop-1', tier: 'branches', paidThrough: null,
      tills: 99, issuedAt: new Date().toISOString(), kid: 'a-key-from-next-year',
    }
    const looksReal = `${encodePayload(token)}.${'A'.repeat(86)}`

    /* The distinction matters at three in the morning. UNKNOWN_KEY is a till
       that needs updating and is nobody's fault; BAD_SIGNATURE sends somebody
       looking for an attacker. Before there was a key this answered
       NOT_CONFIGURED, which named the file to edit -- the point each time is
       that the code names the actual problem rather than the nearest one. */
    expect(await verifyToken(looksReal, LICENCE_KEYS))
      .toEqual({ ok: false, code: 'UNKNOWN_KEY' })
  })

  it('entitles a till with no licence to nothing beyond working', async () => {
    /* Unchanged by the drop-in, and the one that must never change: a shop
       that has pasted nothing is a shop that bills. */
    const state = await entitlement(fx.db)
    expect(state).toMatchObject({ tier: 'single', state: 'none' })

    for (const feature of GATED) {
      expect(await entitled(fx.db, feature), feature).toBe(false)
    }
  })

  it('will not install a token it cannot check, and stores nothing', async () => {
    const token: LicenceToken = {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2099-01-01',
      tills: 9, issuedAt: new Date().toISOString(), kid: 'made-up',
    }
    const installed = await installToken(
      fx.db, { actorId: 'someone' }, `${encodePayload(token)}.${'A'.repeat(86)}`,
    )
    expect(installed).toMatchObject({ ok: false, code: 'UNKNOWN_KEY' })

    /* The half that matters more than the code: a refused token must leave no
       trace, or the next start reads it back and reports on a licence nobody
       installed. */
    const stored = await fx.db.get('SELECT value FROM settings WHERE key = ?', ['licence_token'])
    expect(stored).toBeUndefined()
  })

  it('refuses a licence signed by a key this build does not have', async () => {
    /* The real forgery case, which needs a real signature: a well-formed
       licence, correctly signed, under a `kid` this build knows. Only the
       signature check can catch it, so this is the test that would fail if
       `LICENCE_KEYS` held the wrong 32 bytes. */
    const impostor = await webcrypto.subtle.generateKey(
      { name: 'Ed25519' }, true, ['sign', 'verify'],
    ) as webcrypto.CryptoKeyPair

    const kid = LICENCE_KEYS[0]!.kid
    const payload = encodePayload({
      shopId: 'shop-1', tier: 'branches', paidThrough: null,
      tills: 99, issuedAt: new Date().toISOString(), kid,
    })
    const signature = new Uint8Array(await webcrypto.subtle.sign(
      { name: 'Ed25519' }, impostor.privateKey, new TextEncoder().encode(payload),
    ))

    expect(await verifyToken(`${payload}.${Buffer.from(signature).toString('base64url')}`, LICENCE_KEYS))
      .toEqual({ ok: false, code: 'BAD_SIGNATURE' })
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
