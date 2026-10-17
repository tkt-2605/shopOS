import { describe, it, expect, afterEach } from 'vitest'
import { handle } from '../src/http.js'
import { parseVendors } from '../src/console/vendor.js'
import { releaseHealth, compareVersions } from '../src/health/releases.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * The portal's side of release safety: the switch board it hands every till,
 * and each release's crash figures, which `release.ts target` reads before
 * widening a rollout.
 */

const VENDOR = '+919876543210'
let open: TestPortal[] = []
afterEach(async () => { for (const p of open) await p.close(); open = [] })

async function portal(role = 'admin') {
  const p = await testPortal()
  open.push(p)
  return { ...p, vendors: parseVendors(`${VENDOR}:${role}`) }
}

function call(p: TestPortal, method: string, path: string, body: unknown = null, token?: string): Promise<{ status: number; body: any }> {
  return handle(p, { method, path, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {}, body }) as Promise<{ status: number; body: any }>
}

async function signIn(p: TestPortal): Promise<string> {
  const s = await call(p, 'POST', '/v1/auth/start', { phone: VENDOR })
  return (await call(p, 'POST', '/v1/auth/verify', { challengeId: s.body.challengeId, code: p.channel.last()!.code })).body.token
}

/** Shaped like a board; the portal does not check signatures, the tills do. */
function board(issuedAt: string): string {
  const body = Buffer.from(JSON.stringify({ format: 1, kind: 'switches', kid: 'k', issuedAt, off: [] })).toString('base64url')
  return `${body}.c2ln`
}

function report(deviceId: string, version: string, runs: { started: number; clean: number; panicked: number; unclean: number }) {
  return {
    shopId: 'shop-1', deviceId, appVersion: version,
    faults: { sessions: { [version]: runs }, errors: [] },
  }
}

describe('the switch board', () => {
  it('is there for any till to fetch once an admin has put one out', async () => {
    const p = await portal()
    expect((await call(p, 'GET', '/v1/switches')).status).toBe(404)
    const token = await signIn(p)
    expect((await call(p, 'POST', '/v1/console/switches', { token: board('2026-10-18T10:00:00Z') }, token)).status).toBe(200)
    const got = await call(p, 'GET', '/v1/switches')
    expect(got.body.issuedAt).toBe('2026-10-18T10:00:00Z')
  })

  it('will not go back to an older board', async () => {
    const p = await portal()
    const token = await signIn(p)
    await call(p, 'POST', '/v1/console/switches', { token: board('2026-10-18T10:00:00Z') }, token)
    expect((await call(p, 'POST', '/v1/console/switches', { token: board('2026-10-17T10:00:00Z') }, token)).status).toBe(409)
  })

  it('is put out only by an admin, and refuses what is not a board', async () => {
    const viewer = await portal('view')
    expect((await call(viewer, 'POST', '/v1/console/switches', { token: board('2026-10-18T10:00:00Z') }, await signIn(viewer))).status).toBe(403)
    const p = await portal()
    expect((await call(p, 'POST', '/v1/console/switches', { token: 'not.aboard' }, await signIn(p))).status).toBe(409)
  })
})

describe('release health', () => {
  it('counts each till once per version, and leaves power cuts out of crash-free', async () => {
    const p = await portal()
    const keys: Record<string, string> = {}
    const send = async (deviceId: string, version: string, runs: Parameters<typeof report>[2]) => {
      const r = await call(p, 'POST', '/v1/shops/shop-1/health', report(deviceId, version, runs), keys[deviceId])
      keys[deviceId] ??= r.body.key
    }
    await send('a', '0.2.21', { started: 10, clean: 10, panicked: 0, unclean: 0 })
    await send('a', '0.3.0', { started: 4, clean: 3, panicked: 1, unclean: 0 })
    await send('a', '0.3.0', { started: 6, clean: 4, panicked: 1, unclean: 1 }) // later report, same till
    await send('b', '0.3.0', { started: 5, clean: 1, panicked: 0, unclean: 4 })

    const health = await releaseHealth(p.db)
    expect(health.map((h) => h.version)).toEqual(['0.3.0', '0.2.21'])
    expect(health[0]).toMatchObject({ tills: 2, started: 11, clean: 5, panicked: 1, unclean: 5 })
    expect(health[0]!.crashFree).toBeCloseTo(5 / 6)
    expect(health[1]!.crashFree).toBe(1)

    const seen = await call(p, 'GET', '/v1/console/releases', null, await signIn(p))
    expect(seen.body.releases).toHaveLength(2)
  })

  it('orders versions as numbers, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.21', '0.2.3')).toBeGreaterThan(0)
  })
})

describe('release figures for the release tool', () => {
  it('are given behind the admin token only', async () => {
    const p = await portal()
    expect((await call(p, 'GET', '/v1/releases')).status).toBe(401)
    expect((await call(p, 'GET', '/v1/releases', null, 'admin-secret')).body).toEqual({ releases: [] })
  })
})
