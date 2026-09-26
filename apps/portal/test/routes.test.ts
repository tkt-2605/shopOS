import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { serve } from '../src/server.js'
import { DEVICE_HEADER } from '../src/http.js'
import { testPortal, type TestPortal } from './support.js'

/**
 * The routes, over a real socket.
 *
 * `handle` could be called directly and would be faster, but half of what
 * can go wrong with an HTTP service is not in the router: a body that never
 * arrives, a header case that does not match, a status that carries no body,
 * a response that is not JSON. A real `node:http` server on a real ephemeral
 * port catches those and costs a few milliseconds.
 */

let servers: Server[] = []
let portals: TestPortal[] = []

afterEach(async () => {
  for (const server of servers) await new Promise((r) => server.close(r))
  for (const portal of portals) await portal.close()
  servers = []
  portals = []
})

interface Client {
  portal: TestPortal
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  raw(path: string, init?: RequestInit): Promise<Response>
}

async function client(opts: Parameters<typeof testPortal>[0] = {}): Promise<Client> {
  const portal = await testPortal(opts)
  portals.push(portal)

  const server = await serve(portal, { port: 0 })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}`

  const read = async (response: Response) => ({
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null),
  })

  return {
    portal,
    raw: (path, init) => fetch(`${base}${path}`, init),
    get: (path, headers) => fetch(`${base}${path}`, headers === undefined ? {} : { headers }).then(read),
    post: (path, body, headers) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(read),
  }
}

/** Signs in over HTTP and returns the bearer token. */
async function signIn(c: Client, phone = '+919876543210'): Promise<string> {
  const started = await c.post('/v1/auth/start', { phone })
  expect(started.status).toBe(200)
  const code = c.portal.channel.last()?.code
  const verified = await c.post('/v1/auth/verify', {
    challengeId: started.body.challengeId, code,
  })
  expect(verified.status).toBe(200)
  return verified.body.token as string
}

describe('health', () => {
  it('says which half of the deployment is real', async () => {
    const c = await client()
    const { status, body } = await c.get('/v1/health')
    expect(status).toBe(200)
    expect(body.licensing).toContain('signing as')
    expect(body.otpChannel).toBe('memory')
    expect(body.issuing).toBe('enabled')
  })

  it('says so when nothing is configured', async () => {
    const c = await client({ adminToken: null })
    const { body } = await c.get('/v1/health')
    expect(body.issuing).toBe('disabled')
  })
})

describe('signing in over HTTP', () => {
  it('goes start → verify → me', async () => {
    const c = await client()
    const token = await signIn(c)

    const me = await c.get('/v1/me', { Authorization: `Bearer ${token}` })
    expect(me.status).toBe(200)
    expect(me.body.account.phone).toBe('+919876543210')
  })

  it('never puts the code in the response', async () => {
    const c = await client()
    const started = await c.post('/v1/auth/start', { phone: '+919876543210' })
    const code = c.portal.channel.last()!.code

    expect(JSON.stringify(started.body)).not.toContain(code)
    expect(started.body.devCode).toBeUndefined()
  })

  it('refuses /v1/me without a token, and with a made-up one', async () => {
    const c = await client()
    expect((await c.get('/v1/me')).status).toBe(401)
    expect((await c.get('/v1/me', { Authorization: 'Bearer nonsense' })).status).toBe(401)
  })

  it('answers 429 with Retry-After when a resend is too soon', async () => {
    const c = await client()
    await c.post('/v1/auth/start', { phone: '+919876543210' })
    const again = await c.raw('/v1/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919876543210' }),
    })

    expect(again.status).toBe(429)
    expect(Number(again.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('signs out, and the token stops working', async () => {
    const c = await client()
    const token = await signIn(c)

    const out = await c.post('/v1/auth/sign-out', {}, { Authorization: `Bearer ${token}` })
    expect(out.status).toBe(204)
    expect((await c.get('/v1/me', { Authorization: `Bearer ${token}` })).status).toBe(401)
  })

  it('answers sign-out the same way for a token that was never real', async () => {
    const c = await client()
    const out = await c.post('/v1/auth/sign-out', {}, { Authorization: 'Bearer nonsense' })
    expect(out.status).toBe(204)
  })

  it('does not fall over on a body that is not JSON', async () => {
    const c = await client()
    const response = await c.raw('/v1/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    })
    expect(response.status).toBe(400)
  })
})

describe('the licence routes', () => {
  it('issues with the admin token and refuses without it', async () => {
    const c = await client()

    const noToken = await c.post('/v1/licences', { shopId: 's1', tier: 'cloud' })
    expect(noToken.status).toBe(401)

    const wrong = await c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud' },
      { Authorization: 'Bearer not-the-secret' },
    )
    expect(wrong.status).toBe(401)

    const issued = await c.post(
      '/v1/licences',
      { shopId: 's1', tier: 'cloud', paidThrough: '2027-03-31', tills: 2 },
      { Authorization: 'Bearer admin-secret' },
    )
    expect(issued.status).toBe(201)
    expect(issued.body.token).toContain('.')
  })

  it('hides the issuing route entirely when no admin token is set', async () => {
    const c = await client({ adminToken: null })
    const issued = await c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud' },
      { Authorization: 'Bearer anything' },
    )
    // 404 rather than 401: a route that cannot be used should not advertise
    // that a secret would open it.
    expect(issued.status).toBe(404)
  })

  it('refuses a tier it has never heard of', async () => {
    const c = await client()
    const issued = await c.post(
      '/v1/licences', { shopId: 's1', tier: 'unlimited-everything' },
      { Authorization: 'Bearer admin-secret' },
    )
    expect(issued.status).toBe(400)
  })

  it('serves a shop its licence, and 404s a shop with none', async () => {
    const c = await client()
    expect((await c.get('/v1/licence/never-heard-of')).status).toBe(404)
    // A stray percent is a bad request, not a crash inside the portal.
    expect((await c.get('/v1/licence/%E0%A4')).status).toBe(400)

    await c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud', paidThrough: '2027-03-31', tills: 1 },
      { Authorization: 'Bearer admin-secret' },
    )

    const served = await c.get('/v1/licence/s1')
    expect(served.status).toBe(200)
    expect(served.body).toMatchObject({ tier: 'cloud', paidThrough: '2027-03-31', tills: 1 })
  })

  it('serves the most recent licence when a shop renews', async () => {
    const c = await client()
    const issue = (paidThrough: string) => c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud', paidThrough, tills: 1 },
      { Authorization: 'Bearer admin-secret' },
    )

    await issue('2026-09-30')
    await issue('2027-09-30')

    expect((await c.get('/v1/licence/s1')).body.paidThrough).toBe('2027-09-30')
    // And the old one is still on file, because a billing question asks for it.
    const all = await c.portal.db.query('SELECT id FROM licences WHERE shop_id = ?', ['s1'])
    expect(all).toHaveLength(2)
  })

  it('records the till that asked, and serves one that does not say', async () => {
    const c = await client()
    await c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud', paidThrough: '2027-03-31', tills: 1 },
      { Authorization: 'Bearer admin-secret' },
    )

    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-a' })
    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-b' })
    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-a' })

    const devices = await c.portal.db.query<{ device_id: string }>(
      'SELECT device_id FROM devices WHERE shop_id = ? ORDER BY device_id', ['s1'],
    )
    expect(devices.map((d) => d.device_id)).toEqual(['till-a', 'till-b'])

    // A till that sends no header is served identically. It is a count, not a gate.
    expect((await c.get('/v1/licence/s1')).status).toBe(200)
  })
})

describe('shops', () => {
  it('reports the tills a shop has been seen running, to its owner only', async () => {
    const c = await client()
    const token = await signIn(c)
    const me = await c.get('/v1/me', { Authorization: `Bearer ${token}` })

    await c.portal.db.execute(
      'INSERT INTO shops (id, name, account_id, created_at) VALUES (?, ?, ?, ?)',
      ['s1', 'Test Shop', me.body.account.id, new Date().toISOString()],
    )
    await c.post(
      '/v1/licences', { shopId: 's1', tier: 'cloud', paidThrough: '2027-03-31', tills: 2 },
      { Authorization: 'Bearer admin-secret' },
    )
    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-a' })
    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-b' })
    await c.get('/v1/licence/s1', { [DEVICE_HEADER]: 'till-c' })

    const tills = await c.get('/v1/shops/s1/tills', { Authorization: `Bearer ${token}` })
    expect(tills.body).toEqual({ shopId: 's1', tillsSeen: 3 })

    // Somebody else's shop is not found, rather than forbidden.
    const stranger = await signIn(c, '+919000000009')
    expect((await c.get('/v1/shops/s1/tills', { Authorization: `Bearer ${stranger}` })).status)
      .toBe(404)
  })
})

describe('the shape of the service', () => {
  it('404s an unknown route without leaking anything', async () => {
    const c = await client()
    const { status, body } = await c.get('/v1/definitely-not-a-route')
    expect(status).toBe(404)
    expect(body.error).toBe('NO_ROUTE')
  })

  it('sends no CORS header, so no other origin may read it', async () => {
    const c = await client()
    const response = await c.raw('/v1/health')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a body larger than it will ever need', async () => {
    const c = await client()
    const response = await c.raw('/v1/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: 'x'.repeat(200_000) }),
    })
    expect(response.status).toBe(413)
  })
})
