import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleSyncRequest, offerPairing, withdrawPairing } from '../src/services/syncServer.js'
import { pairingOnOffer } from '../src/services/syncServer/pairing.js'
import { pairWith } from '../src/services/syncClient.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { pairingKey } from '../src/services/syncAuth.js'
import { freshDb, emptyDb, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Pairing with a code read off the other till's screen.
 *
 * The code used to cross the wire as typed, beside the joining till's key, so a
 * machine in the middle could read it and relay the request with a key of its
 * own. Now it never crosses: each side proves it knows the code, over the keys,
 * with a key made slowly from it.
 */

const SHOP = '11111111-1111-4111-8111-111111111111'
const JOINER = '22222222-2222-4222-8222-222222222222'

let fx: Fixture
let server: Server
let url: string
let joiner: SqlDriver

beforeEach(async () => {
  withdrawPairing()
  fx = await freshDb()
  await licenseTill(fx.db)
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += String(c) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(SHOP)
        try {
          const answer = await handleSyncRequest(fx.db, { path: req.url ?? '/', body, auth: null }, undefined, { keys: TEST_KEYS })
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.body)
        } finally { setDeviceId(before) }
      })()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  joiner = await emptyDb()
  setDeviceId(JOINER)
})

afterEach(async () => {
  setDeviceId(null)
  withdrawPairing()
  await new Promise<void>((r) => server.close(() => r()))
  await fx.db.close()
  await joiner.close()
})

/** A fetch that can look at and alter what crosses. */
function between(edit: {
  out?: (body: Record<string, unknown>) => Record<string, unknown>
  back?: (body: Record<string, unknown>) => Record<string, unknown>
  seen?: string[]
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    edit.seen?.push(String(init?.body))
    const response = await fetch(input, { ...init, body: JSON.stringify(edit.out ? edit.out(sent) : sent) })
    const text = await response.text()
    const answer = response.ok && edit.back ? JSON.stringify(edit.back(JSON.parse(text))) : text
    return new Response(answer, { status: response.status })
  }) as typeof fetch
}

describe('a typed pairing code', () => {
  it('never crosses the wire, and the pairing still works', async () => {
    const code = offerPairing()
    const seen: string[] = []
    await pairWith(joiner, url, code, 'Back counter', between({ seen }))

    expect(seen.join('\n')).not.toContain(code)
    expect(await fx.db.get(`SELECT 1 FROM sync_peers WHERE device_id = ?`, [JOINER])).toBeDefined()
  })

  it('cannot be relayed with a key swapped in on the way to the shop', async () => {
    const theirs = await pairingKey()
    const code = offerPairing()
    await expect(pairWith(joiner, url, code, null, between({ out: (b) => ({ ...b, publicKey: theirs.publicKey }) })))
      .rejects.toMatchObject({ code: 'WRONG_CODE' })
    expect(await fx.db.get(`SELECT 1 FROM sync_peers WHERE device_id = ?`, [JOINER])).toBeUndefined()
  })

  it('is not fooled by a key swapped in on the way back', async () => {
    const theirs = await pairingKey()
    const code = offerPairing()
    await expect(pairWith(joiner, url, code, null, between({ back: (b) => ({ ...b, publicKey: theirs.publicKey }) })))
      .rejects.toMatchObject({ code: 'NOT_THE_SHOP' })
    expect(await joiner.get(`SELECT 1 FROM sync_peers`), 'nothing remembered').toBeUndefined()
  })

  it('refuses a code sent as typed, and spends it', async () => {
    const code = offerPairing()
    const response = await fetch(`${url}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceId: JOINER, publicKey: (await pairingKey()).publicKey }),
    })
    expect(response.status).toBe(400)
    expect(pairingOnOffer()).toBeNull()
  })
})
