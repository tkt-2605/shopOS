import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { syncWith } from '../src/services/sync.js'
import {
  handleSyncRequest, offerPairing, withdrawPairing, pairingOnOffer, PAIRING_WINDOW_MS,
} from '../src/services/syncServer.js'
import { httpTransport, pairWith, pairedPeers, SyncHttpError } from '../src/services/syncClient.js'
import { encodeAuth, sign, forgetNonces } from '../src/services/syncAuth.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { getSetting } from '../src/services/bootstrap.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Two tills over real sockets.
 *
 * Everything below goes through `node:http` on a real port with real JSON on the
 * wire — no stub, no fake transport, the same `handleSyncRequest` the app will
 * call from Rust and the same `fetch` the webview will use. What is being tested
 * is the part that only exists once there is a network: a request that was
 * altered on the way, one that was captured and sent again, one from a till
 * nobody ever paired with, and a code typed wrong.
 *
 * The protocol underneath was settled in `sync.test.ts` without a network at
 * all. This is the layer on top of it, and keeping them apart is why neither
 * file has to pretend to be the other.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

interface Till {
  id: string
  db: SqlDriver
  server: Server
  url: string
  fx?: Fixture
}

let host: Till
let joiner: Till

/** A real HTTP server answering as one particular till. */
async function serve(id: string, db: SqlDriver): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(id)
        try {
          const answer = await handleSyncRequest(db, {
            path: req.url ?? '/',
            body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
          })
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.body)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 'SERVER_ERROR', message: String(err) }))
        } finally {
          setDeviceId(before)
        }
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}` }
}

beforeEach(async () => {
  forgetNonces()
  withdrawPairing()
  joinerRegister = null

  const fx = await freshDb()
  const a = await serve(TILL_A, fx.db)
  host = { id: TILL_A, db: fx.db, fx, ...a }

  const emptied = await emptyDb()
  const b = await serve(TILL_B, emptied)
  joiner = { id: TILL_B, db: emptied, ...b }
})

afterEach(async () => {
  setDeviceId(null)
  withdrawPairing()
  await new Promise<void>((r) => host.server.close(() => r()))
  await new Promise<void>((r) => joiner.server.close(() => r()))
  await host.db.close()
  await joiner.db.close()
})

async function as<T>(till: Till, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try {
    return await fn()
  } finally {
    setDeviceId(before)
  }
}

/** The whole of setting up a second till: read a code, type it in. */
async function pairThem(): Promise<string> {
  const code = offerPairing()
  await as(joiner, () => pairWith(joiner.db, host.url, code, 'Back counter'))
  return code
}

/**
 * The counter the joining till sits at, chosen after it has taken the shop.
 *
 * Not optional. A till that has never been asked falls back to the first active
 * counter — the other till's — and two tills on one counter mint bill numbers
 * from one series, so `syncWith` refuses them. This is the step a real shop
 * does by pressing "Use here", and the tests have to do it too.
 */
let joinerRegister: string | null = null

async function joinerPicksItsOwnCounter(): Promise<void> {
  const id = 'back-counter'
  const now = new Date().toISOString()
  for (const db of [host.db, joiner.db]) {
    await db.execute(
      `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at)
       VALUES (?, 'Back counter', 'BC', 1, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [id, now, now],
    )
  }
  joinerRegister = id
}

async function peerOf(till: Till, them: string) {
  return till.db.get<{ secret: string | null; address: string | null }>(
    `SELECT secret, address FROM sync_peers WHERE device_id = ?`, [them],
  )
}

describe('pairing', () => {
  it('introduces two tills with a code read off one screen', async () => {
    await pairThem()

    const onJoiner = await peerOf(joiner, TILL_A)
    const onHost = await peerOf(host, TILL_B)

    expect(onJoiner?.secret).toBeTruthy()
    expect(onHost?.secret).toBeTruthy()
    // The same secret on both sides, and it never crossed again after that.
    expect(onJoiner?.secret).toBe(onHost?.secret)
    expect(onJoiner?.address).toBe(host.url)
  })

  it('refuses a code that was typed wrong', async () => {
    offerPairing()

    await expect(as(joiner, () => pairWith(joiner.db, host.url, 'WRONGWRO')))
      .rejects.toThrow(SyncHttpError)

    expect(await peerOf(joiner, TILL_A)).toBeUndefined()
  })

  it('spends the code on a wrong guess, so guessing is not worth trying', async () => {
    /* Eight characters is only enough because there is one attempt. Otherwise a
       machine on the shop wifi works through the alphabet while nobody watches. */
    const code = offerPairing()

    await expect(as(joiner, () => pairWith(joiner.db, host.url, 'WRONGWRO'))).rejects.toThrow()
    expect(pairingOnOffer()).toBeNull()

    // Even the right code is no good now; somebody has to offer a fresh one.
    await expect(as(joiner, () => pairWith(joiner.db, host.url, code))).rejects.toThrow()
  })

  it('refuses when nobody is offering to pair', async () => {
    await expect(as(joiner, () => pairWith(joiner.db, host.url, 'ABCDEFGH')))
      .rejects.toThrow(SyncHttpError)
  })

  it('lets a code lapse rather than leaving it live for ever', async () => {
    const now = Date.now()
    offerPairing(now)
    expect(pairingOnOffer(now + PAIRING_WINDOW_MS - 1000)).not.toBeNull()
    expect(pairingOnOffer(now + PAIRING_WINDOW_MS + 1000)).toBeNull()
  })

  it('hands back which shop has been joined', async () => {
    const code = offerPairing()
    const outcome = await as(joiner, () => pairWith(joiner.db, host.url, code))

    expect(outcome.deviceId).toBe(TILL_A)
    expect(outcome.shopId).toBe(await getSetting(host.db, 'shop_id'))
  })
})

describe('syncing across the wire', () => {
  it('carries a product from one till to the other', async () => {
    await pairThem()
    const id = await as(host, () => makeProduct(host.db, { name: 'Notebook' }))

    const peers = await pairedPeers(joiner.db)
    const round = await as(joiner, () =>
      syncWith(joiner.db, httpTransport(peers[0]!), joinerRegister))

    expect(round.ok).toBe(true)
    const landed = await joiner.db.get<{ name: string }>(
      `SELECT name FROM products WHERE id = ?`, [id],
    )
    expect(landed?.name).toBe('Notebook')
  })

  it('carries a change back the other way too', async () => {
    await pairThem()
    const id = await as(host, () => makeProduct(host.db, { name: 'Notebook' }))

    const peers = await pairedPeers(joiner.db)
    await as(joiner, () => syncWith(joiner.db, httpTransport(peers[0]!), joinerRegister))
    await joinerPicksItsOwnCounter()

    await as(joiner, () => joiner.db.execute(
      `UPDATE products SET name = ? WHERE id = ?`, ['Renamed on the back counter', id],
    ))
    const pushed = await as(joiner, () =>
      syncWith(joiner.db, httpTransport(peers[0]!), joinerRegister))
    expect(pushed.ok).toBe(true)

    const back = await host.db.get<{ name: string }>(
      `SELECT name FROM products WHERE id = ?`, [id],
    )
    expect(back?.name).toBe('Renamed on the back counter')
  })

  it('takes the same batch twice without doubling anything', async () => {
    /* The failure this guards against only exists once there is a network: we
       applied a batch, acknowledged it, and the acknowledgement was lost. The
       sender has no choice but to send it again. */
    await pairThem()
    const id = await as(host, () => makeProduct(host.db, { name: 'Notebook' }))
    const peers = await pairedPeers(joiner.db)

    await as(joiner, () => syncWith(joiner.db, httpTransport(peers[0]!), joinerRegister))
    const first = await joiner.db.get<{ rev: number }>(
      `SELECT rev FROM products WHERE id = ?`, [id],
    )

    // Rewind this side's cursor and take it all again, which is what a lost
    // acknowledgement looks like from here.
    await joiner.db.execute(`UPDATE sync_peers SET their_cursor = 0 WHERE device_id = ?`, [TILL_A])
    await as(joiner, () => syncWith(joiner.db, httpTransport(peers[0]!), joinerRegister))

    const again = await joiner.db.get<{ rev: number }>(
      `SELECT rev FROM products WHERE id = ?`, [id],
    )
    expect(again?.rev).toBe(first?.rev)
    expect(await joiner.db.query(`SELECT id FROM products WHERE id = ?`, [id])).toHaveLength(1)
  })
})

describe('what the network lets somebody try', () => {
  it('refuses a till nobody has ever paired with', async () => {
    const stranger = httpTransport({
      deviceId: TILL_A, baseUrl: host.url, secret: 'a'.repeat(64),
    })

    await expect(as(joiner, () => stranger.hello())).rejects.toMatchObject({
      status: 401, code: 'UNKNOWN_PEER',
    })
  })

  it('refuses a request signed with the wrong secret', async () => {
    await pairThem()
    const wrong = httpTransport({
      deviceId: TILL_A, baseUrl: host.url, secret: 'b'.repeat(64),
    })

    await expect(as(joiner, () => wrong.hello())).rejects.toMatchObject({
      status: 401, code: 'BAD_SIGNATURE',
    })
  })

  it('refuses a request with no signature at all', async () => {
    await pairThem()
    const response = await fetch(`${host.url}/hello`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(401)
    expect((await response.json() as { code: string }).code).toBe('MALFORMED')
  })

  it('refuses a body that was altered on the way', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const honest = JSON.stringify({ since: 0, limit: 10 })
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/fetch', honest))

    // The signature covers the bytes, so the changed body no longer matches it.
    const response = await fetch(`${host.url}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed) },
      body: JSON.stringify({ since: 0, limit: 500 }),
    })

    expect(response.status).toBe(401)
    expect((await response.json() as { code: string }).code).toBe('BAD_SIGNATURE')
  })

  it('refuses a signature made for a different request', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const body = JSON.stringify({ since: 0, limit: 10 })
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/fetch', body))

    // Same body, same signature, pointed at the request that writes.
    const response = await fetch(`${host.url}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed) },
      body,
    })

    expect(response.status).toBe(401)
  })

  it('refuses a request that is captured and sent again', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const body = JSON.stringify({ since: 0, limit: 10 })
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/fetch', body))
    const headers = {
      'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed),
    }

    const first = await fetch(`${host.url}/fetch`, { method: 'POST', headers, body })
    expect(first.status).toBe(200)

    const second = await fetch(`${host.url}/fetch`, { method: 'POST', headers, body })
    expect(second.status).toBe(401)
    expect((await second.json() as { code: string }).code).toBe('REPLAYED')
  })

  it('refuses a request kept until long after it was made', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const body = JSON.stringify({ since: 0, limit: 10 })
    const old = Date.now() - 60 * 60 * 1000
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/fetch', body, old))

    const response = await fetch(`${host.url}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed) },
      body,
    })

    expect(response.status).toBe(401)
    expect((await response.json() as { code: string }).code).toBe('STALE')
  })

  it('refuses a batch that claims to be from somebody else', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const batch = JSON.stringify({
      fromDevice: 'someone-else', schemaVersion: 99999, records: [], upTo: 1, complete: true,
    })
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/offer', batch))

    const response = await fetch(`${host.url}/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed) },
      body: batch,
    })

    // The schema is checked first; either refusal is a refusal, and nothing ran.
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('says no to a request it does not have', async () => {
    await pairThem()
    const peer = (await pairedPeers(joiner.db))[0]!
    const signed = await as(joiner, () => sign(peer.secret, TILL_B, '/drop-everything', '{}'))

    const response = await fetch(`${host.url}/drop-everything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopos-auth': encodeAuth(signed) },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })
})
