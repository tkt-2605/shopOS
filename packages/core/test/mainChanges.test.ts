import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { syncWith } from '../src/services/sync.js'
import { handleSyncRequest, offerPairing, withdrawPairing } from '../src/services/syncServer.js'
import { httpTransport, pairWith, pairedPeers, joinByCopy } from '../src/services/syncClient.js'
import { seedFeedWithEverything } from '../src/services/changefeed.js'
import {
  handTheMainTo, keepTillsEqual, listens, mainTill, makeThisTheMain, tillRole,
} from '../src/services/sync/layout.js'
import { billsToEmail, noteBillEmail } from '../src/services/billEmails.js'
import { createCustomer } from '../src/services/customers.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { rupees, type Money } from '../src/money.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import { TEST_KEYS, licenseTill } from './licenceHelper.js'
import type { SqlDriver } from '../src/db/driver.js'

/**
 * Changing the main, over real connections, with each till's door as the app
 * keeps it: a till that `listens` says should not answer does not -- the
 * connection is refused, as the closed port at a shop refuses it. The other
 * tests of the main answer on every till, which is how the deadlock a shop
 * found on 21 October (`077`) went unseen: both tills of a shop paired as
 * equals thought the other was the main, and neither answered.
 */

/** Real HTTP between three tills: well past the default 5 s on a busy machine (as the bench). */
const SLOW = 30_000

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

/** `door` is whether the till is answering, re-decided after every round as `keepTheDoorRight` does. */
interface Till { id: string; db: SqlDriver; server: Server; url: string; on: boolean; door: boolean }

async function serve(till: Omit<Till, 'server' | 'url' | 'door'>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      void (async () => {
        const before = deviceId()
        setDeviceId(till.id)
        try {
          // Switched off, or a door this till keeps shut: nobody answers. Pairing is
          // a person at this till with the port open for them (`expectingAJoin`).
          const pairing = (req.url ?? '') === '/pair'
          if (!till.on || (!pairing && !(till as Till).door)) { req.socket.destroy(); return }
          const port = req.headers['x-shopos-port'] as string | undefined
          const answer = await handleSyncRequest(till.db, {
            path: req.url ?? '/', body,
            auth: (req.headers['x-shopos-auth'] as string | undefined) ?? null,
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
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

let fx: Fixture
let tills: Till[] = []

async function till(id: string, db: SqlDriver): Promise<Till> {
  const t = { id, db, on: true, door: true } as Till
  Object.assign(t, await serve(t))
  tills.push(t)
  return t
}

beforeEach(() => { withdrawPairing(); tills = [] })
afterEach(async () => {
  setDeviceId(null)
  withdrawPairing()
  keepTillsEqual(false)
  joinByCopy(true)
  for (const t of tills) {
    await new Promise<void>((r) => t.server.close(() => r()))
    await t.db.close()
  }
})

async function as<T>(t: { id: string }, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(t.id)
  try { return await fn() } finally { setDeviceId(before) }
}

async function join(t: Till, host: Till): Promise<void> {
  const code = await as(host, async () => offerPairing())
  await as(t, () => pairWith(t.db, host.url, code, t.id.slice(0, 4)))
}

const port = (t: Till) => Number(new URL(t.url).port)

/** Opens or shuts a till's door to match what it now is, as the app does after every round. */
async function keepDoor(t: Till): Promise<void> {
  t.door = await as(t, () => listens(t.db))
}

/**
 * As the sync loop does: dial every peer this till holds an address for,
 * saying the port it answers on only while its door is open -- which is what
 * tells the far side to keep or forget its address. Whether each got through.
 */
async function catchUp(t: Till): Promise<boolean[]> {
  const out: boolean[] = []
  for (const peer of await pairedPeers(t.db)) {
    const self = t.door ? { listenPort: port(t) } : {}
    const round = await as(t, () => syncWith(t.db, httpTransport(peer, fetch, self), null)).catch(() => ({ ok: false }))
    out.push(round.ok)
  }
  await keepDoor(t)
  for (const other of tills) if (other !== t && other.on) await keepDoor(other)
  return out
}

/** Several rounds everywhere, as a few minutes of the loop would be. */
async function settle(...ts: Till[]): Promise<void> {
  for (let i = 0; i < 4; i += 1) for (const t of ts) if (t.on) await catchUp(t)
}

const has = async (t: Till, name: string) =>
  (await t.db.get('SELECT 1 AS x FROM products WHERE name = ?', [name])) !== undefined
const roleOf = (t: Till) => as(t, () => tillRole(t.db))
const mainOf = (t: Till) => as(t, () => mainTill(t.db))

describe('swapping the main in a shop paired as equals, as TRT General Store was', () => {
  async function equals(): Promise<[Till, Till]> {
    fx = await freshDb()
    const a = await till(A, fx.db)
    const b = await till(B, await emptyDb())
    await licenseTill(a.db, 'multi')
    keepTillsEqual(true)
    await join(b, a)
    keepTillsEqual(false)
    // Paired before there was a main: each holds the other's address, and dials it.
    await a.db.execute(`UPDATE sync_peers SET address = ? WHERE device_id = ?`, [b.url, B])
    await b.db.execute(`UPDATE sync_peers SET address = ? WHERE device_id = ?`, [a.url, A])
    await settle(a, b)
    expect((await pairedPeers(a.db)).map((p) => p.deviceId), 'A dials B').toEqual([B])
    expect((await pairedPeers(b.db)).map((p) => p.deviceId), 'B dials A').toEqual([A])
    expect([await roleOf(a), await roleOf(b)]).toEqual(['equals', 'equals'])
    return [a, b]
  }

  it('makes one the main, and the other follows by itself', async () => {
    const [a, b] = await equals()
    await as(a, () => makeThisTheMain(a.db, fx.adminId))
    await keepDoor(a)
    await settle(a, b)
    expect([await roleOf(a), await roleOf(b)]).toEqual(['main', 'till'])
  }, SLOW)

  it('hands the main to the other, which takes over, and the shop goes on syncing both ways', async () => {
    const [a, b] = await equals()
    await as(a, () => makeThisTheMain(a.db, fx.adminId))
    await keepDoor(a)
    await settle(a, b)

    await as(a, () => handTheMainTo(a.db, B, fx.adminId))
    await keepDoor(a)
    expect(await as(a, () => listens(a.db)), 'the old main keeps its door open until the new one has heard').toBe(true)
    await as(a, () => makeProduct(a.db, { name: 'Sold at A during the swap' }))
    await as(b, () => makeProduct(b.db, { name: 'Sold at B during the swap' }))
    await settle(b, a)

    expect([await roleOf(a), await roleOf(b)]).toEqual(['till', 'main'])
    expect(await mainOf(a)).toEqual(await mainOf(b))
    expect(await as(b, () => listens(b.db)), 'the new main answers').toBe(true)
    expect(await as(a, () => listens(a.db)), 'and the old one, now a till, closes its door').toBe(false)
    for (const t of [a, b]) {
      expect(await has(t, 'Sold at A during the swap')).toBe(true)
      expect(await has(t, 'Sold at B during the swap')).toBe(true)
    }
    // And after the swap, still both ways.
    await as(a, () => makeProduct(a.db, { name: 'Sold at A after' }))
    await settle(a, b)
    expect(await has(b, 'Sold at A after')).toBe(true)
  }, SLOW)

  /* What happened at TRT: one till made the main, and the main handed on to
     the other within the minute -- after the other had heard it was a till,
     before it had dialled back to say it no longer answers. So each still
     held the other's address, each believed the other the main, and each
     door was shut. */
  it('hands over within the minute of making the main, before the other has dialled back', async () => {
    const [a, b] = await equals()
    await as(a, () => makeThisTheMain(a.db, fx.adminId))
    await keepDoor(a)
    expect(await catchUp(a), 'A tells B it is the main').toEqual([true])
    expect(await roleOf(b)).toBe('till')
    expect(b.door, 'B, a till now, has shut its door').toBe(false)

    await as(a, () => handTheMainTo(a.db, B, fx.adminId))
    await keepDoor(a)
    expect(await mainOf(a)).toMatchObject({ device: B })
    expect(await mainOf(b), 'B has not heard yet').toMatchObject({ device: A })

    await as(b, () => makeProduct(b.db, { name: 'Sold at B while it had not heard' }))
    await settle(b, a)
    expect([await roleOf(a), await roleOf(b)], 'B heard, and took over').toEqual(['till', 'main'])
    expect(await has(a, 'Sold at B while it had not heard')).toBe(true)
    await as(a, () => makeProduct(a.db, { name: 'Sold at A after' }))
    await settle(a, b)
    expect(await has(b, 'Sold at A after'), 'and the shop syncs both ways').toBe(true)
  }, SLOW)

  it('swaps back again just as well', async () => {
    const [a, b] = await equals()
    await as(a, () => makeThisTheMain(a.db, fx.adminId))
    await keepDoor(a)
    await settle(a, b)
    await as(a, () => handTheMainTo(a.db, B, fx.adminId))
    await keepDoor(a)
    await settle(b, a)
    await as(b, () => handTheMainTo(b.db, A, fx.adminId))
    await keepDoor(b)
    await settle(a, b)
    expect([await roleOf(a), await roleOf(b)]).toEqual(['main', 'till'])
    await as(b, () => makeProduct(b.db, { name: 'Sold at B after two swaps' }))
    await settle(a, b)
    expect(await has(a, 'Sold at B after two swaps')).toBe(true)
  }, SLOW)
})

describe('the main is off, two people make two tills the main, and the old main comes back', () => {
  it('ends with one main that all three agree on, every sale kept, and no bill emailed twice', async () => {
    fx = await freshDb()
    const old = await till(A, fx.db)
    const b = await till(B, await emptyDb())
    const c = await till(C, await emptyDb())
    await licenseTill(old.db, 'multi')
    await join(b, old)
    await join(c, old)

    // A customer whose bills are emailed, and a bill the old main mailed before it went off.
    const ravi = await as(old, () => createCustomer(old.db, { actorId: fx.adminId }, {
      name: 'Ravi', email: 'ravi@example.com', emailBills: true,
    }))
    if (!ravi.ok) throw new Error(ravi.code)
    await new Promise((r) => setTimeout(r, 5))
    const pen = await as(old, () => makeProduct(old.db, { name: 'Ball pen', baseRate: rupees(10), taxRateBp: 0 }))
    const sell = async (t: Till): Promise<string> => as(t, async () => {
      const register = (await t.db.get<{ id: string }>(`SELECT id FROM registers LIMIT 1`))!.id
      const draft = await createBill(t.db, {
        registerId: register, customerId: ravi.customerId, lines: [{ productId: pen, qty: fromUnits(1) }], actorId: fx.adminId,
      })
      if (!draft.ok) throw new Error(draft.code)
      const done = await submitBill(t.db, {
        billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal as Money }], actorId: fx.adminId,
      })
      if (!done.ok) throw new Error(done.code)
      return draft.billId
    })
    const mailedByOld = await sell(old)
    await as(old, () => noteBillEmail(old.db, { billId: mailedByOld, to: 'ravi@example.com' }))
    await settle(b, c)

    // The main goes off. Two people, each not knowing, make B and C the main.
    old.on = false
    await as(b, () => makeThisTheMain(b.db, fx.adminId))
    await keepDoor(b)
    await as(c, () => makeThisTheMain(c.db, fx.adminId))
    await keepDoor(c)
    expect([await roleOf(b), await roleOf(c)]).toEqual(['main', 'main'])
    await as(b, () => makeProduct(b.db, { name: 'Sold at B as a main' }))
    await as(c, () => makeProduct(c.db, { name: 'Sold at C as a main' }))
    // B rings a bill for Ravi while it thinks it is the main, and mails it.
    const mailedByB = await sell(b)
    await as(b, () => noteBillEmail(b.db, { billId: mailedByB, to: 'ravi@example.com' }))

    // They meet: C pairs with B.
    joinByCopy(false)
    await join(c, b)
    await as(c, () => seedFeedWithEverything(c.db))
    await as(b, () => seedFeedWithEverything(b.db))
    await settle(c, b)
    const settled = await mainOf(b)
    expect(await mainOf(c)).toEqual(settled)
    expect(settled.device).toBe([B, C].sort()[0])

    // The old main is repaired and switched on, still believing it is the main, and takes a sale.
    old.on = true
    expect(await roleOf(old)).toBe('main')
    await as(old, () => makeProduct(old.db, { name: 'Sold on the old main after its repair' }))
    await settle(b, c, old)

    // One main, the same on all three; the old one has stepped down.
    expect(await mainOf(old)).toEqual(settled)
    expect(await roleOf(old)).toBe('till')
    for (const t of [old, b, c]) {
      for (const name of ['Sold at B as a main', 'Sold at C as a main', 'Sold on the old main after its repair']) {
        expect(await has(t, name), `${name} on ${t.id.slice(0, 1)}`).toBe(true)
      }
      // The bill the old main mailed is not due again anywhere, the new main included.
      const due = await as(t, async () => (await billsToEmail(t.db)).map((x) => x.billId))
      expect(due, `nothing B or the old main mailed is due on ${t.id.slice(0, 1)}`).not.toContain(mailedByOld)
      expect(due).not.toContain(mailedByB)
    }
  }, SLOW)
})
