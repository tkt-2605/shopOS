import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { syncWith } from '../src/services/sync.js'
import {
  handleSyncRequest, offerPairing, withdrawPairing,
} from '../src/services/syncServer.js'
import { httpTransport, pairWith, pairedPeers, SyncHttpError } from '../src/services/syncClient.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { setSetting } from '../src/services/bootstrap.js'
import { allows, GATED } from '../src/domain/licence.js'
import { mayTakeMoney } from '../src/services/extraCounters.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * The multi-till plan, and the one thing it must never do.
 *
 * `multiTill` gates **adding** a till. It must not gate **syncing** with one
 * already added, and the distinction is not a nicety — it is the difference
 * between a shop that cannot buy a second counter and a shop whose books
 * quietly go wrong.
 *
 * Billing never stops when a licence lapses; that is the first rule and it is
 * not negotiable. So a lapse that also stopped sync would leave a shop taking
 * money on two counters that never merged. Neither screen would say anything,
 * because from each till's point of view it is simply a peer that has gone
 * quiet — which is Tuesday. Weeks later the stock is wrong on both machines,
 * the credit book is wrong on both, and every report ever run in between was
 * wrong. Nobody would connect that to a renewal date.
 *
 * `keeps a shop that has lapsed running` below is the test that says so, and
 * it is the most important one in this file.
 */

const TILL_A = '11111111-1111-4111-8111-111111111111'
const TILL_B = '22222222-2222-4222-8222-222222222222'

interface Till { id: string; db: SqlDriver; server: Server; url: string }

let host: Till & { fx: Fixture }
let joiner: Till

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
          }, undefined, { keys: TEST_KEYS })
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
  withdrawPairing()
  const fx = await freshDb()
  host = { id: TILL_A, db: fx.db, fx, ...(await serve(TILL_A, fx.db)) }
  const emptied = await emptyDb()
  joiner = { id: TILL_B, db: emptied, ...(await serve(TILL_B, emptied)) }
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
  try { return await fn() } finally { setDeviceId(before) }
}

async function tryToPair(): Promise<void> {
  const code = offerPairing()
  await as(joiner, () => pairWith(joiner.db, host.url, code, 'Back counter'))
}

/** The counter the joining till sits at; two tills on one counter cannot sync. */
const BACK_COUNTER = 'back-counter'

async function joinerPicksItsOwnCounter(): Promise<void> {
  const now = new Date().toISOString()
  for (const db of [host.db, joiner.db]) {
    await db.execute(
      `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at)
       VALUES ('back-counter', 'Back counter', 'BC', 1, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [now, now],
    )
  }
}

describe('adding a till', () => {
  it('is refused on a shop with no licence at all', async () => {
    /* The free tier is the absence of a code, not a code that says `single`.
       So this is what every unlicensed shop in the field does. */
    await expect(tryToPair()).rejects.toMatchObject({ code: 'NEEDS_MULTI_TILL' })
    const peer = await host.db.get('SELECT device_id FROM sync_peers')
    expect(peer, 'nothing may be written on a refusal').toBeUndefined()
  })

  it('is refused on the single-counter plan', async () => {
    await licenseTill(host.db, 'single')
    await expect(tryToPair()).rejects.toThrow(SyncHttpError)
  })

  it('is allowed on the multi-counter plan', async () => {
    await licenseTill(host.db, 'multi')
    await tryToPair()

    const onHost = await host.db.get<{ secret: string }>(
      'SELECT secret FROM sync_peers WHERE device_id = ?', [TILL_B],
    )
    expect(onHost?.secret).toBeTruthy()
  })

  it('is allowed on the cloud plan, which sits above it', async () => {
    /* The ladder, asserted through the door rather than through `allows`. A
       shop paying for off-site backup certainly has a second counter, and
       charging twice would read as sharp practice. */
    await licenseTill(host.db, 'cloud')
    await tryToPair()
    expect(await host.db.get('SELECT secret FROM sync_peers WHERE device_id = ?', [TILL_B]))
      .toBeTruthy()
  })

  it('is refused once the plan has lapsed', async () => {
    await licenseTill(host.db, 'multi', '2020-01-01')
    await expect(tryToPair()).rejects.toMatchObject({ code: 'NEEDS_MULTI_TILL' })
  })
})

describe('a shop that already has two tills', () => {
  it('keeps a shop that has lapsed running', async () => {
    /* **The test this file exists for.**

       Pair while paid, lapse, then move a row. If this ever fails, a shop that
       forgot to renew is taking money on two counters that no longer merge —
       and neither screen says so, because a quiet peer looks like a quiet
       peer. That is a worse outcome than never having sold them the plan. */
    await licenseTill(host.db, 'multi')
    await tryToPair()
    await joinerPicksItsOwnCounter()

    /* The renewal date passes. Only the host is re-licensed: the gate is on
       the answering side, and in a real shop the token replicates anyway. */
    await licenseTill(host.db, 'multi', '2020-01-01')

    await as(host, () => makeProduct(host.db, { name: 'Sold after it lapsed' }))
    const peers = await pairedPeers(joiner.db)
    const round = await as(joiner, () =>
      syncWith(joiner.db, httpTransport(peers[0]!), BACK_COUNTER))
    expect(round.ok, 'the round itself must succeed').toBe(true)

    const landed = await joiner.db.get<{ name: string }>(
      'SELECT name FROM products WHERE name = ?', ['Sold after it lapsed'],
    )
    expect(landed?.name, 'a lapsed shop must go on merging').toBe('Sold after it lapsed')

    /* The rule of 27 September, built: once the plan is past grace the extra
       till stops *starting* money documents, and the main -- the till it
       joined -- goes on billing with the whole shop's books. Sync carries on
       either way, so nothing either till holds is stranded. The licence that
       says so travelled here with the round above, as every setting does. */
    expect(await as(joiner, () => mayTakeMoney(joiner.db, { keys: TEST_KEYS })), 'the extra till').toBe(false)
    expect(await as(host, () => mayTakeMoney(host.db, { keys: TEST_KEYS })), 'the main').toBe(true)
  })

  it('keeps a shop whose licence was removed entirely running', async () => {
    /* Removing the code is a button on the licence card, and somebody will
       press it to see what happens. What happens is nothing. */
    await licenseTill(host.db, 'multi')
    await tryToPair()
    await joinerPicksItsOwnCounter()

    await setSetting(host.db, 'licence_token', '', new Date().toISOString())

    await as(host, () => makeProduct(host.db, { name: 'After the code went' }))
    const peers = await pairedPeers(joiner.db)
    await as(joiner, () => syncWith(joiner.db, httpTransport(peers[0]!), BACK_COUNTER))

    expect(await joiner.db.get('SELECT name FROM products WHERE name = ?', ['After the code went']))
      .toBeTruthy()
  })
})

describe('the shape of the list', () => {
  it('ranks multi below cloud and above single', () => {
    expect(allows({ tier: 'single', state: 'active' }, 'multiTill')).toBe(false)
    expect(allows({ tier: 'multi', state: 'active' }, 'multiTill')).toBe(true)
    expect(allows({ tier: 'cloud', state: 'active' }, 'multiTill')).toBe(true)
    expect(allows({ tier: 'branches', state: 'active' }, 'multiTill')).toBe(true)
    // And multi does not reach up.
    expect(allows({ tier: 'multi', state: 'active' }, 'cloudPeer')).toBe(false)
  })

  it('keeps every till working through grace', () => {
    for (const feature of GATED) {
      expect(allows({ tier: 'branches', state: 'grace' }, feature), feature).toBe(true)
    }
  })
})
