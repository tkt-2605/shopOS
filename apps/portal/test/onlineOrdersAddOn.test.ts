import { describe, it, expect, afterEach } from 'vitest'
import { installToken, entitlement } from '../../../packages/core/src/services/licence.js'
import { whyNotServing, WEB_SETTINGS } from '../../../packages/core/src/services/web/gate.js'
import { encodePayload, readTokenUnverified, toBase64Url } from '../../../packages/core/src/domain/licence.js'
import { getSetting, setSetting } from '../../../packages/core/src/services/bootstrap.js'
import { freshDb, type Fixture } from '../../../packages/core/test/helpers.js'
import { issueLicence } from '../src/licences.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * Online orders granted by a licence code rather than by a list in the code.
 *
 * The portal mints with a real key and the till verifies with the public
 * half, as `licenceInTheLoop` does, so what is proved is the add-on surviving
 * the wire and the signature -- not a fake that agrees with itself. The shop
 * here is a fresh one, never on `ONLINE_ORDER_SHOPS`, so only the code can
 * open the gate.
 */

const ctx = { actorId: 'owner' }
let portal: TestPortal
let fx: Fixture
let open: { close: () => Promise<void> }[] = []

afterEach(async () => {
  for (const thing of open) await thing.close()
  open = []
})

async function bothEnds(): Promise<void> {
  portal = await testPortal()
  fx = await freshDb()
  const db = fx.db
  open.push(portal, { close: () => db.close() })
}

async function shopAskingForTheWeb(): Promise<string> {
  await bothEnds()
  await setSetting(fx.db, WEB_SETTINGS.enabled, 'on')
  return (await getSetting(fx.db, 'shop_id'))!
}

async function issue(shopId: string, features: string[], paidThrough: string | null = null) {
  const issued = await issueLicence(portal.db, portal.signingKey!, {
    shopId, tier: 'multi', paidThrough, tills: 2, features, kid: portal.kid,
  })
  if (!issued.ok) throw new Error(`issue failed: ${issued.detail}`)
  return issued.licence
}

const on = (day: string) => ({ keys: portal.publicKeys, now: new Date(`${day}T12:00:00`) })

describe('online orders as a licence add-on', () => {
  it('opens the gate for a shop whose code carries it, and only then', async () => {
    const shopId = await shopAskingForTheWeb()
    expect(await whyNotServing(fx.db, on('2026-11-10'))).toBe('NOT_THIS_SHOP')

    const plain = await issue(shopId, [])
    await installToken(fx.db, ctx, plain.token, { keys: portal.publicKeys })
    expect(await whyNotServing(fx.db, on('2026-11-10'))).toBe('NOT_THIS_SHOP')

    const granted = await issue(shopId, ['onlineOrders'])
    expect(granted.features).toEqual(['onlineOrders'])
    await installToken(fx.db, ctx, granted.token, { keys: portal.publicKeys })
    expect(await whyNotServing(fx.db, on('2026-11-10'))).toBeNull()

    // The renewal replaced the plain code of the same tier rather than sitting beside it.
    const held = await entitlement(fx.db, on('2026-11-10'))
    expect(held.grants.map((g) => g.features)).toEqual([['onlineOrders']])
  })

  it('lapses with the code it was signed into, after the same grace', async () => {
    const shopId = await shopAskingForTheWeb()
    const granted = await issue(shopId, ['onlineOrders'], '2026-09-30')
    await installToken(fx.db, ctx, granted.token, { keys: portal.publicKeys })

    expect(await whyNotServing(fx.db, on('2026-10-15'))).toBeNull()
    expect(await whyNotServing(fx.db, on('2026-11-15'))).toBe('NOT_THIS_SHOP')
  })

  it('is not opened by another shop\'s code, or by one with the add-on written in by hand', async () => {
    const shopId = await shopAskingForTheWeb()

    // Copied from another shop: stored straight into settings, as a restored backup would carry it.
    const theirs = await issue('another-shop', ['onlineOrders'])
    await setSetting(fx.db, 'licence_token', theirs.token)
    expect(await whyNotServing(fx.db, on('2026-11-10'))).toBe('NOT_THIS_SHOP')

    // This shop's own plain code, with the add-on edited into its readable payload.
    const plain = await issue(shopId, [])
    const [payload, signature] = plain.token.split('.')
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    decoded.features = ['onlineOrders']
    await setSetting(fx.db, 'licence_token', `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`)
    expect(await whyNotServing(fx.db, on('2026-11-10'))).toBe('NOT_THIS_SHOP')
  })

  it('is refused by the portal when the name is not an add-on', async () => {
    await bothEnds()
    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'multi', paidThrough: null, tills: 1, features: ['onlineOrder'], kid: portal.kid,
    })
    expect(issued).toMatchObject({ ok: false, code: 'BAD_FEATURE' })
  })
})

describe('the code without add-ons', () => {
  it('is the same bytes it was before add-ons existed', () => {
    const token = { shopId: 's', tier: 'multi' as const, paidThrough: null, tills: 1, issuedAt: 'i', kid: 'k' }
    const before = toBase64Url(new TextEncoder().encode(JSON.stringify(token)))
    expect(encodePayload(token)).toBe(before)
    expect(encodePayload({ ...token, features: [] })).toBe(before)
  })

  it('reads an add-on it has never heard of as absent, and keeps the rest of the code', () => {
    const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({
      shopId: 's', tier: 'multi', paidThrough: null, tills: 1, issuedAt: 'i', kid: 'k',
      features: ['onlineOrders', 'somethingFromNextYear'],
    })))
    expect(readTokenUnverified(`${payload}.sig`)).toMatchObject({ tier: 'multi', features: ['onlineOrders'] })
  })
})
