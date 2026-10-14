import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { syncWith } from '../src/services/sync.js'
import { handleSyncRequest, offerPairing, withdrawPairing } from '../src/services/syncServer.js'
import { httpTransport, pairWith, pairedPeers, askToJoin, joinByCopy, requestClaim } from '../src/services/syncClient.js'
import { feedHead, pruneFeed, seedFeedWithEverything } from '../src/services/changefeed.js'
import {
  handTheMainTo, hearMain, joinedMain, listens, mainTill, makeThisTheMain, tillRole,
} from '../src/services/sync/layout.js'
import { PermissionError } from '../src/integrity/permissions.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * One main till per shop (`docs/specs/one-main-till.md`).
 *
 * Over real sockets, through `handleSyncRequest`, because the rules here are
 * about who may say what to whom -- which is the part a test that called the
 * merge directly would skip. The harness records no address for a till that
 * asks, which is exactly a till that does not listen: the main can never dial
 * one, and that is the shape every test below relies on.
 */

const MAIN = '11111111-1111-4111-8111-111111111111'
const T1 = '22222222-2222-4222-8222-222222222222'
const T2 = '33333333-3333-4333-8333-333333333333'

interface Till { id: string; db: SqlDriver; server: Server; url: string }

async function serve(id: string, db: SqlDriver): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(id)
        try {
          const port = req.headers['x-shopos-port'] as string | undefined
          const answer = await handleSyncRequest(db, {
            path: req.url ?? '/',
            body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
            // As the app's listener reports them: where it came from, and the
            // port it says it answers on -- none, for a till that dials.
            remoteAddress: req.socket.remoteAddress ?? null,
            listenPort: port === undefined ? null : Number(port),
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

let main: Till & { fx: Fixture }
let t1: Till
let t2: Till

beforeEach(async () => {
  withdrawPairing()
  const fx = await freshDb()
  main = { id: MAIN, db: fx.db, fx, ...(await serve(MAIN, fx.db)) }
  const a = await emptyDb()
  t1 = { id: T1, db: a, ...(await serve(T1, a)) }
  const b = await emptyDb()
  t2 = { id: T2, db: b, ...(await serve(T2, b)) }
  await licenseTill(main.db, 'multi')
  const now = new Date().toISOString()
  // Each till its own counter, so no round is refused as two tills on one.
  for (const [id, prefix] of [['c-t1', 'TA'], ['c-t2', 'TB']] as const) {
    await main.db.execute(
      `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
      [id, id, prefix, now, now],
    )
  }
})

afterEach(async () => {
  setDeviceId(null)
  withdrawPairing()
  for (const till of [main, t1, t2]) {
    await new Promise<void>((r) => till.server.close(() => r()))
    await till.db.close()
  }
})

async function as<T>(till: { id: string }, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try { return await fn() } finally { setDeviceId(before) }
}

async function join(till: Till, host: Till): Promise<void> {
  const code = await as(host, async () => offerPairing())
  await as(till, () => pairWith(till.db, host.url, code, till.id.slice(0, 4)))
}

const COUNTER: Record<string, string> = { [T1]: 'c-t1', [T2]: 'c-t2' }

/** One till syncs with the first peer it can dial, as the loop does. */
async function catchUp(till: Till): Promise<void> {
  for (const peer of await pairedPeers(till.db)) {
    const round = await as(till, () => syncWith(till.db, httpTransport(peer), COUNTER[till.id] ?? null))
    expect(round.ok, JSON.stringify(round)).toBe(true)
  }
}

const has = async (db: SqlDriver, name: string) =>
  (await db.get('SELECT 1 AS x FROM products WHERE name = ?', [name])) !== undefined

describe('the first till let in', () => {
  it('makes the till that let it in the main, and the joiner knows it', async () => {
    expect(await as(main, () => tillRole(main.db))).toBe('alone')
    await join(t1, main)

    expect(await as(main, () => mainTill(main.db))).toEqual({ device: MAIN, epoch: 1 })
    expect(await as(t1, () => mainTill(t1.db))).toEqual({ device: MAIN, epoch: 1 })
    expect(await as(main, () => tillRole(main.db))).toBe('main')
    expect(await as(t1, () => tillRole(t1.db))).toBe('till')
  })

  it('leaves the main listening and the till dialling', async () => {
    await join(t1, main)
    expect(await as(main, () => listens(main.db)), 'the main answers').toBe(true)
    expect(await as(t1, () => listens(t1.db)), 'a till does not').toBe(false)
    expect(await pairedPeers(main.db), 'the main has nobody to dial').toEqual([])
    expect((await pairedPeers(t1.db)).map((p) => p.deviceId)).toEqual([MAIN])
  })
})

describe('a till that is not the main', () => {
  it('refuses to let another in, at the first knock', async () => {
    await join(t1, main)
    await expect(as(t2, () => askToJoin(t1.url, 'Third'))).rejects.toMatchObject({ code: 'NOT_THE_MAIN' })
  })

  it('refuses a typed code too, and writes nothing', async () => {
    await join(t1, main)
    const code = await as(t1, async () => offerPairing())
    await expect(as(t2, () => pairWith(t2.db, t1.url, code, 'Third'))).rejects.toMatchObject({ code: 'NOT_THE_MAIN' })
    const rows = await t1.db.query('SELECT device_id FROM sync_peers')
    expect(rows.map((r) => r['device_id'])).toEqual([MAIN])
  })
})

describe('three tills through one main', () => {
  it('converge, with every till writing while apart', async () => {
    await join(t1, main)
    await join(t2, main)

    await as(main, () => makeProduct(main.db, { name: 'Written at the main' }))
    await catchUp(t1)
    await catchUp(t2)
    await as(t1, () => makeProduct(t1.db, { name: 'Written at T1' }))
    await as(t2, () => makeProduct(t2.db, { name: 'Written at T2' }))

    await catchUp(t1)
    await catchUp(t2)
    await catchUp(t1)

    for (const till of [main, t1, t2]) {
      for (const name of ['Written at the main', 'Written at T1', 'Written at T2']) {
        expect(await has(till.db, name), `${name} on ${till.id.slice(0, 4)}`).toBe(true)
      }
    }
  })
})

describe('changing the main', () => {
  it('is refused to somebody without the right to change settings', async () => {
    await join(t1, main)
    await expect(as(t1, () => makeThisTheMain(t1.db, null))).rejects.toBeInstanceOf(PermissionError)
    await expect(as(main, () => handTheMainTo(main.db, T1, 'nobody'))).rejects.toBeInstanceOf(PermissionError)
  })

  it('hands over: the named till takes over at its next catch-up, and the old main relays', async () => {
    await join(t1, main)
    await join(t2, main)
    await catchUp(t1)

    await as(main, () => handTheMainTo(main.db, T1, main.fx.adminId))
    expect(await as(main, () => tillRole(main.db)), 'the old main steps aside at once').toBe('till')
    expect(await as(main, () => listens(main.db)), 'but goes on answering the tills that dial it').toBe(true)

    await catchUp(t1)
    expect(await as(t1, () => mainTill(t1.db))).toEqual({ device: T1, epoch: 2 })
    expect(await as(t1, () => listens(t1.db)), 'the new main opens its door').toBe(true)

    /* T2 has not paired with T1 and does not need to yet: the old main passes
       its bills on, and nothing waits on the order things happen in. */
    await as(t2, () => makeProduct(t2.db, { name: 'Sold at T2 during the move' }))
    await catchUp(t2)
    await catchUp(t1)
    expect(await has(t1.db, 'Sold at T2 during the move')).toBe(true)
    expect(await as(t2, () => mainTill(t2.db)), 'T2 has heard who the main is').toEqual({ device: T1, epoch: 2 })
  })

  it('a main that comes back after another was made main steps down at first contact', async () => {
    await join(t1, main)
    await catchUp(t1)

    /* The main is unreachable; somebody makes T1 the main. The old one is
       repaired and switched on, still believing it is the main, and takes a
       sale before anybody has spoken to it. */
    await as(t1, () => makeThisTheMain(t1.db, main.fx.adminId))
    expect(await as(t1, () => mainTill(t1.db))).toEqual({ device: T1, epoch: 2 })
    expect(await as(main, () => tillRole(main.db))).toBe('main')
    await as(main, () => makeProduct(main.db, { name: 'Sold on the old main after its repair' }))

    // T1 still holds the old main's address, and asks it something.
    await catchUp(t1)
    expect(await as(main, () => mainTill(main.db)), 'it heard the higher epoch').toEqual({ device: T1, epoch: 2 })
    expect(await as(main, () => tillRole(main.db))).toBe('till')
    expect(await has(t1.db, 'Sold on the old main after its repair'), 'and nothing it held is lost').toBe(true)
  })
})

describe('a till that stops listening', () => {
  it('is forgotten as an address, so the main stops knocking where nobody answers', async () => {
    /* Till 2 of the first three-till run: briefly the main, it opened a port,
       was written down at it, stepped down and closed it -- and the main went
       on dialling the dead port every round, "refused" on its screen. */
    await join(t1, main)
    await main.db.execute(
      `UPDATE sync_peers SET address = 'http://127.0.0.1:65337', last_error = 'refused' WHERE device_id = ?`, [T1],
    )
    expect((await pairedPeers(main.db)).map((p) => p.deviceId)).toEqual([T1])

    await catchUp(t1)

    const row = await main.db.get<{ address: string | null; last_error: string | null }>(
      'SELECT address, last_error FROM sync_peers WHERE device_id = ?', [T1],
    )
    expect(row).toEqual({ address: null, last_error: null })
    expect(await pairedPeers(main.db), 'the main dials nobody again').toEqual([])
  })
})

describe('what one till says about the main', () => {
  it('is followed when the epoch is higher, and ignored when it is lower or silent', async () => {
    const db = await emptyDb()
    expect(await hearMain(db, { device: 'b', epoch: 3 })).toBe(true)
    expect(await hearMain(db, { device: 'c', epoch: 2 }), 'a lower epoch').toBe(false)
    expect(await hearMain(db, undefined), 'silence from an older build').toBe(false)
    expect(await hearMain(db, { device: null, epoch: 9 }), 'a number with no main').toBe(false)
    expect(await mainTill(db)).toEqual({ device: 'b', epoch: 3 })
    await db.close()
  })

  it('settles two mains at one epoch by the lower device id, the same way on both sides', async () => {
    const one = await emptyDb()
    const two = await emptyDb()
    await hearMain(one, { device: 'aaa', epoch: 4 })
    await hearMain(two, { device: 'bbb', epoch: 4 })
    // Each hears the other's claim.
    expect(await hearMain(one, { device: 'bbb', epoch: 4 })).toBe(false)
    expect(await hearMain(two, { device: 'aaa', epoch: 4 })).toBe(true)
    expect(await mainTill(one)).toEqual(await mainTill(two))
    await one.close()
    await two.close()
  })

  it('is taken whole when a till with nobody else joins, whatever it carried before', async () => {
    const db = await emptyDb()
    await hearMain(db, { device: 'an-old-life', epoch: 7 })
    await db.execute(
      `INSERT INTO sync_peers (device_id, secret, created_at) VALUES ('the-shop', 's', ?)`,
      [new Date().toISOString()],
    )
    await joinedMain(db, 'the-shop', { device: 'the-shop', epoch: 1 })
    expect(await mainTill(db)).toEqual({ device: 'the-shop', epoch: 1 })
    await db.close()
  })
})

describe('a shop paired before there was a main', () => {
  it('stays as it was: every till equal, listening, until somebody chooses', async () => {
    const db = await emptyDb()
    await db.execute(
      `INSERT INTO sync_peers (device_id, secret, address, created_at) VALUES ('other', 's', 'http://10.0.0.2:7801', ?)`,
      [new Date().toISOString()],
    )
    expect(await tillRole(db)).toBe('equals')
    expect(await listens(db)).toBe(true)
    await db.close()
  })
})

describe('the main dies, and another till is made the main', () => {
  it('gets back a bill that only the dead main had received, once a till pairs with the new one', async () => {
    await join(t1, main)
    await join(t2, main)
    await catchUp(t1)
    await catchUp(t2)

    /* T2 sells; the main receives it; T2's feed lets go of it, because the
       only till it talks to has it. Then the main dies before T1 asks. */
    await as(t2, () => makeProduct(t2.db, { name: 'Sold at T2, received only by the main' }))
    await catchUp(t2)
    await as(t2, async () => pruneFeed(t2.db, await feedHead(t2.db)))
    await new Promise<void>((r) => main.server.close(() => r()))
    main.server = createServer().listen(0)

    await as(t1, () => makeThisTheMain(t1.db, main.fx.adminId))
    expect(await has(t1.db, 'Sold at T2, received only by the main')).toBe(false)

    /* T2 pairs with T1 as an existing till does: no copy, and its own shop put
       back in its feed for the new main (`theShopHasArrived` in the app). */
    joinByCopy(false)
    await join(t2, t1)
    expect(await as(t2, () => mainTill(t2.db)), 'T2 follows the new main').toEqual({ device: T1, epoch: 2 })

    /* The feed no longer names the sale, but T1 asks from below where T2's feed
       was pruned, so T2 puts the shop back in it (`catchUpFromBelowTheFloor`);
       the app also does so itself on rejoining. Either way nothing is lost. */
    await as(t2, () => seedFeedWithEverything(t2.db))
    const toT1 = (await pairedPeers(t2.db)).find((p) => p.deviceId === T1)!
    const round = await as(t2, () => syncWith(t2.db, httpTransport(toT1), COUNTER[T2] ?? null))
    expect(round.ok, JSON.stringify(round)).toBe(true)
    expect(await has(t1.db, 'Sold at T2, received only by the main')).toBe(true)
    expect(await has(t2.db, 'Sold at T2, received only by the main'), 'and T2 still has it').toBe(true)
  })
})

describe('handing the main on, when things go wrong around it', () => {
  it('the main hands over and dies before the till it named has heard; made main by hand, nothing is lost', async () => {
    await join(t1, main)
    await join(t2, main)
    await catchUp(t1)
    await catchUp(t2)

    // Handed on -- and the old main dies before T1 has asked it anything.
    await as(main, () => handTheMainTo(main.db, T1, main.fx.adminId))
    await as(t2, () => makeProduct(t2.db, { name: 'Sold at T2 as the main went' }))
    await catchUp(t2) // the old main takes it, still answering as a till
    await new Promise<void>((r) => main.server.close(() => r()))
    main.server = createServer().listen(0)
    expect(await as(t1, () => mainTill(t1.db)), 'T1 never heard').toEqual({ device: MAIN, epoch: 1 })

    // Somebody makes T1 the main by hand: the same answer the dead main gave.
    await as(t1, () => makeThisTheMain(t1.db, main.fx.adminId))
    expect(await as(t1, () => mainTill(t1.db))).toEqual({ device: T1, epoch: 2 })

    // T2 rejoins at the new main, putting its own shop back in its feed.
    joinByCopy(false)
    await join(t2, t1)
    await as(t2, () => seedFeedWithEverything(t2.db))
    const toT1 = (await pairedPeers(t2.db)).find((p) => p.deviceId === T1)!
    const round = await as(t2, () => syncWith(t2.db, httpTransport(toT1), COUNTER[T2] ?? null))
    expect(round.ok, JSON.stringify(round)).toBe(true)
    expect(await has(t1.db, 'Sold at T2 as the main went')).toBe(true)
    expect(await as(t2, () => mainTill(t2.db))).toEqual({ device: T1, epoch: 2 })
  })

  it('two people make two different tills the main while apart; when they meet, one main and everything kept', async () => {
    await join(t1, main)
    await join(t2, main)
    await catchUp(t1)
    await catchUp(t2)
    await new Promise<void>((r) => main.server.close(() => r()))
    main.server = createServer().listen(0)

    // The main is dead. One person makes T1 the main, another T2, neither knowing.
    await as(t1, () => makeThisTheMain(t1.db, main.fx.adminId))
    await as(t2, () => makeThisTheMain(t2.db, main.fx.adminId))
    await as(t1, () => makeProduct(t1.db, { name: 'Sold at T1 as a main' }))
    await as(t2, () => makeProduct(t2.db, { name: 'Sold at T2 as a main' }))

    // They meet: T2 pairs with T1.
    joinByCopy(false)
    await join(t2, t1)
    await as(t2, () => seedFeedWithEverything(t2.db))
    await as(t1, () => seedFeedWithEverything(t1.db))
    for (let i = 0; i < 3; i += 1) {
      const toT1 = (await pairedPeers(t2.db)).find((p) => p.deviceId === T1)!
      const round = await as(t2, () => syncWith(t2.db, httpTransport(toT1), COUNTER[T2] ?? null))
      expect(round.ok, JSON.stringify(round)).toBe(true)
    }

    // One main, the same on both, settled the same way on both sides; both sales on both.
    const onT1 = await as(t1, () => mainTill(t1.db))
    const onT2 = await as(t2, () => mainTill(t2.db))
    expect(onT1).toEqual(onT2)
    expect(onT1.device).toBe([T1, T2].sort()[0])
    for (const t of [t1, t2]) {
      expect(await has(t.db, 'Sold at T1 as a main')).toBe(true)
      expect(await has(t.db, 'Sold at T2 as a main')).toBe(true)
    }
  })

  it('claims go with the main: the new main grants counters, and the old one no longer does', async () => {
    const now = new Date().toISOString()
    await main.db.execute(
      `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at) VALUES ('spare', 'Spare', 'SP', 1, ?, ?)`,
      [now, now],
    )
    await join(t1, main)
    await join(t2, main)
    await catchUp(t1)
    await catchUp(t2)
    const ask = (from: Till, to: Till, registerId: string) => as(from, async () => {
      const peer = (await pairedPeers(from.db)).find((p) => p.deviceId === to.id)!
      return requestClaim(peer, { registerId, take: false }, fetch, {})
    })

    // T2 takes its counter from the main as it stands.
    expect(await ask(t2, main, 'c-t2')).toEqual({ ok: true })
    await catchUp(t2)

    await as(main, () => handTheMainTo(main.db, T1, main.fx.adminId))
    await catchUp(t1)
    expect(await as(t1, () => tillRole(t1.db))).toBe('main')

    // The old main says it is not the one to ask.
    await expect(ask(t2, main, 'spare')).rejects.toMatchObject({ code: 'NOT_THE_MAIN' })

    // The new main has T2's claim, refuses T2's counter to anyone else, and grants the spare.
    await join(t2, t1)
    expect(await as(t1, () => claimedBy(t1.db, 'c-t2'))).toBe(T2)
    expect(await ask(t2, t1, 'spare')).toEqual({ ok: true })
    expect(await as(t1, () => claimedBy(t1.db, 'spare'))).toBe(T2)
    expect(await as(t1, () => claimedBy(t1.db, 'c-t2')), 'and the counter T2 left is free again').toBeNull()
  })
})

async function claimedBy(db: SqlDriver, registerId: string): Promise<string | null> {
  const row = await db.get<{ claimed_by: string | null }>(`SELECT claimed_by FROM registers WHERE id = ?`, [registerId])
  return row?.claimed_by ?? null
}
