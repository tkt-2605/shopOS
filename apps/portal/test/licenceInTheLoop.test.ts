import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import type { SqlDriver } from '@shopos/core'
import {
  entitlement, installToken, entitled, removeToken, storedToken, witnessClock, tillOverage,
} from '../../../packages/core/src/services/licence.js'
import { issueLicence } from '../src/licences.js'
import { serve } from '../src/server.js'
import { DEVICE_HEADER, VERSION_HEADER } from '../src/http.js'
import { testPortal, testTill, testDevice, type TestPortal } from './support.js'
import { freshDb, makeProduct } from '../../../packages/core/test/helpers.js'
import { createBill, submitBill } from '../../../packages/core/src/services/billing.js'
import { getSetting } from '../../../packages/core/src/services/bootstrap.js'
import { rupees } from '../../../packages/core/src/money.js'
import { fromUnits } from '../../../packages/core/src/quantity.js'

/**
 * The portal and a till, with nothing faked in between.
 *
 * Every other licence test could pass with a signer that signs nothing and a
 * verifier that checks nothing, because both halves would be the test's own.
 * Here the portal mints a licence with a real Ed25519 private key, the token
 * crosses a real HTTP socket, and `packages/core` verifies it with the public
 * half exactly as a shop's build would -- so a change that breaks the wire
 * format on either side fails here and only here.
 *
 * This is what "cloud in the loop" means for this phase: not a mock of the
 * portal, the portal.
 */

const ctx = { actorId: 'owner' }

let open: { close: () => Promise<void> }[] = []
let servers: Server[] = []

afterEach(async () => {
  for (const server of servers) await new Promise((r) => server.close(r))
  for (const thing of open) await thing.close()
  servers = []
  open = []
})

async function bothEnds(shopId = 'shop-1'): Promise<{
  portal: TestPortal; till: SqlDriver
}> {
  const portal = await testPortal()
  const till = await testTill(shopId)
  open.push(portal, { close: () => till.close() })
  return { portal, till }
}

describe('a licence from the portal to a till', () => {
  it('is minted, verified and installed', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 3, kid: portal.kid,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    const installed = await installToken(till, ctx, issued.licence.token, {
      keys: portal.publicKeys,
    })
    expect(installed).toMatchObject({ ok: true })

    const state = await entitlement(till, {
      keys: portal.publicKeys,
      now: new Date('2026-10-01T10:00:00+05:30'),
    })
    expect(state).toMatchObject({
      tier: 'cloud', state: 'active', paidThrough: '2027-03-31', tills: 3, problem: null,
    })
    expect(await entitled(till, 'cloudPeer', { keys: portal.publicKeys, now: new Date('2026-10-01') })).toBe(true)
    // Cloud does not carry branches: the tiers are ranked, not a set of flags.
    expect(await entitled(till, 'branches', { keys: portal.publicKeys, now: new Date('2026-10-01') })).toBe(false)
  })

  it('travels over HTTP the way a till will fetch it', async () => {
    const { portal, till } = await bothEnds()

    await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 2, kid: portal.kid,
    })

    const server = await serve(portal, { port: 0 })
    servers.push(server)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/licence/shop-1`, {
      headers: { [DEVICE_HEADER]: 'till-a', [VERSION_HEADER]: '0.1.0' },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { token: string }

    const installed = await installToken(till, ctx, body.token, { keys: portal.publicKeys })
    expect(installed).toMatchObject({ ok: true })
    expect((await storedToken(till))?.tier).toBe('cloud')

    // The header is how the vendor learns the shop is running two counters.
    const seen = await portal.db.query<{ device_id: string; version: string | null }>(
      'SELECT device_id, version FROM devices WHERE shop_id = ?', ['shop-1'],
    )
    expect(seen).toEqual([{ device_id: 'till-a', version: '0.1.0' }])
  })

  it('is refused by a till belonging to another shop', async () => {
    const { portal, till } = await bothEnds('shop-1')

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'a-different-shop', tier: 'cloud', paidThrough: '2027-03-31', tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')

    const installed = await installToken(till, ctx, issued.licence.token, {
      keys: portal.publicKeys,
    })
    expect(installed).toEqual({ ok: false, code: 'WRONG_SHOP', shopId: 'a-different-shop' })

    // And nothing was stored, so a restored backup cannot smuggle one in.
    expect(await storedToken(till)).toBeNull()
  })

  it('is refused when a byte of it is changed', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'single', paidThrough: null, tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')

    /* The tier upgraded by hand -- the forgery somebody would actually
       attempt, because the payload is base64 and readable. */
    const [payload, signature] = issued.licence.token.split('.')
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    decoded.tier = 'branches'
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`

    const installed = await installToken(till, ctx, forged, { keys: portal.publicKeys })
    expect(installed).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' })
  })

  it('is refused by a build that has never heard of the key that signed it', async () => {
    const { portal, till } = await bothEnds()
    const newer = await testPortal({ kid: 'a-key-from-next-year' })
    open.push(newer)

    const issued = await issueLicence(newer.db, newer.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 1, kid: newer.kid,
    })
    if (!issued.ok) throw new Error('issue failed')

    /* What a key rotation looks like from a till that has not been updated:
       the licence is genuine and this build cannot tell, which needs
       different words from a forgery. */
    const installed = await installToken(till, ctx, issued.licence.token, {
      keys: portal.publicKeys,
    })
    expect(installed).toMatchObject({ ok: false, code: 'UNKNOWN_KEY' })
  })

  it('is refused when the same key name carries a different key', async () => {
    const { portal, till } = await bothEnds()
    const impostor = await testPortal({ kid: portal.kid })
    open.push(impostor)

    const issued = await issueLicence(impostor.db, impostor.signingKey!, {
      shopId: 'shop-1', tier: 'branches', paidThrough: null, tills: 99, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')

    /* Someone who knows the kid and minted their own key. The kid matches, so
       the signature is what has to catch it -- and does. */
    const installed = await installToken(till, ctx, issued.licence.token, {
      keys: portal.publicKeys,
    })
    expect(installed).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' })
  })
})

describe('what a licence does and does not do', () => {
  it('lapses into grace, then out of it, and never stops the till', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2026-09-30', tills: 2, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(till, ctx, issued.licence.token, { keys: portal.publicKeys })

    const on = async (day: string) =>
      entitlement(till, { keys: portal.publicKeys, now: new Date(`${day}T12:00:00`) })

    expect((await on('2026-09-30')).state).toBe('active')
    expect((await on('2026-10-01')).state).toBe('grace')
    expect((await on('2026-10-30')).state).toBe('grace')
    expect((await on('2026-10-31')).state).toBe('lapsed')

    // Grace keeps the paid-for things on. That is the whole point of it.
    expect(await entitled(till, 'cloudPeer', {
      keys: portal.publicKeys, now: new Date('2026-10-15T12:00:00'),
    })).toBe(true)
    expect(await entitled(till, 'cloudPeer', {
      keys: portal.publicKeys, now: new Date('2026-11-15T12:00:00'),
    })).toBe(false)

    const lapsed = await on('2027-04-01')
    expect(lapsed.state).toBe('lapsed')
  })

  it('still rings up a bill six months after it lapsed', async () => {
    /* The rule the whole module is built around, asserted by doing it. A
       licence check that quietly grew a refusal would pass every other test
       in this file and fail this one. */
    const portal = await testPortal()
    const fx = await freshDb()
    open.push(portal, { close: () => fx.db.close() })

    const shopId = await getSetting(fx.db, 'shop_id')
    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: shopId!, tier: 'cloud', paidThrough: '2026-01-31', tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(fx.db, ctx, issued.licence.token, { keys: portal.publicKeys })

    const longAfter = new Date('2026-09-22T11:00:00')
    expect((await entitlement(fx.db, { keys: portal.publicKeys, now: longAfter })).state)
      .toBe('lapsed')

    const productId = await makeProduct(fx.db, { name: 'Notebook', baseRate: rupees(1000) })
    const made = await createBill(fx.db, {
      registerId: fx.seed.registerId,
      lines: [{ productId, qty: fromUnits(1) }],
      actorId: fx.adminId,
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const submitted = await submitBill(fx.db, {
      billId: made.billId, actorId: fx.adminId,
      payments: [{ method: 'cash', amount: made.grandTotal }],
    })
    expect(submitted.ok).toBe(true)

    const bill = await fx.db.get<{ docstatus: number; grand_total: number }>(
      'SELECT docstatus, grand_total FROM bills WHERE id = ?', [made.billId],
    )
    expect(bill?.docstatus).toBe(1)
    expect(bill?.grand_total).toBeGreaterThan(0)
  })

  it('counts tills over the limit and refuses none of them', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 2, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(till, ctx, issued.licence.token, { keys: portal.publicKeys })

    expect(await tillOverage(till, 2)).toBe(0)
    expect(await tillOverage(till, 5)).toBe(3)
    // Nothing anywhere turns that number into a refusal.
    expect(await entitled(till, 'cloudPeer', {
      keys: portal.publicKeys, now: new Date('2026-10-01'),
    })).toBe(true)
  })

  it('can be removed, and the till drops to unlicensed rather than broken', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(till, ctx, issued.licence.token, { keys: portal.publicKeys })

    await removeToken(till, ctx)
    const after = await entitlement(till, { keys: portal.publicKeys })
    expect(after).toMatchObject({ tier: 'single', state: 'none', problem: null })
  })

  it('writes an audit row that a support call can read', async () => {
    const { portal, till } = await bothEnds()

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2027-03-31', tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(till, ctx, issued.licence.token, { keys: portal.publicKeys })

    const rows = await till.query<{ entity: string; action: string; actor_id: string }>(
      'SELECT entity, action, actor_id FROM audit_log WHERE entity = ?', ['licence'],
    )
    expect(rows).toEqual([{ entity: 'licence', action: 'create', actor_id: 'owner' }])
  })
})

describe('a clock that has been wound back', () => {
  it('is reported, and changes nothing else', async () => {
    const { portal, till } = await bothEnds()
    const device = testDevice()

    await witnessClock(device, new Date('2026-09-22T09:00:00Z'))

    const issued = await issueLicence(portal.db, portal.signingKey!, {
      shopId: 'shop-1', tier: 'cloud', paidThrough: '2026-09-30', tills: 1, kid: portal.kid,
    })
    if (!issued.ok) throw new Error('issue failed')
    await installToken(till, ctx, issued.licence.token, { keys: portal.publicKeys })

    // A day back is inside the slack: a timezone change, not an attack.
    const nudged = await entitlement(till, {
      keys: portal.publicKeys, device, now: new Date('2026-09-21T20:00:00Z'),
    })
    expect(nudged.clockUnreliable).toBe(false)

    // A year back is the wind-back that would extend a licence for ever.
    const wound = await entitlement(till, {
      keys: portal.publicKeys, device, now: new Date('2025-09-22T09:00:00Z'),
    })
    expect(wound.clockUnreliable).toBe(true)
    // Still says what it says. The screen reports the clock; nothing refuses.
    expect(wound.state).toBe('active')
  })

  it('never moves its high-water mark backwards', async () => {
    const device = testDevice()
    await witnessClock(device, new Date('2026-09-22T09:00:00Z'))
    await witnessClock(device, new Date('2020-01-01T00:00:00Z'))
    expect(device.has('clock_high_water')).toBe('2026-09-22T09:00:00.000Z')
  })
})
