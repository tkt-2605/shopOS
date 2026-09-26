import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  syncWith, syncUntilDone, collectChanges, applyBatch, changedHere, listPeers, pruneAcknowledged,
  recentConflicts, acknowledgeConflicts, unreadConflictCount, recordAttempt,
  type SyncTransport, type PeerHello,
} from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { MIN_PEER_SCHEMA_VERSION } from '../src/db/migrationKinds.js'
import { changesSince, feedHead, pruneFeed, seedFeedWithEverything } from '../src/services/changefeed.js'
import { setSetting, getSetting } from '../src/services/bootstrap.js'
import { createBill, submitBill } from '../src/services/billing.js'
import { postMovement } from '../src/services/stock.js'
import { createReturn, submitReturn } from '../src/services/returns.js'
import { createRegister, claimRegister } from '../src/services/registers.js'
import { rupees } from '../src/money.js'
import { newId } from '../src/ids.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, emptyDb, makeProduct, makeCustomer, type Fixture } from './helpers.js'
import type { Row, SqlDriver } from '../src/db/driver.js'

/**
 * Two tills agreeing, with two real databases and no network.
 *
 * Everything that can go wrong about replication is in here rather than in the
 * transport: a row applied on one till and not the other, a cursor moved before
 * the batch arrived, an edit overwritten in silence, a merge that resolves one
 * way here and the other way there. None of those needs a socket to happen, so
 * none of them needs one to be caught.
 *
 * `till()` is the whole harness — a database plus the device id that database
 * believes it is. The device id is process-global (one app, one machine), so
 * these tests set it around each call, which is exactly what a real till does
 * once at startup and never again.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'
/** Not a till in these scenarios -- a name for "some other machine". */
const TILL_C = '3333cccc-3333-4333-8333-333333333333'

interface Till {
  id: string
  db: SqlDriver
  fx?: Fixture
}

let a: Till
let b: Till

beforeEach(async () => {
  /* A is the shop: installed, set up, already selling. B is the second till,
     which is installed and *not* set up — migrated and empty. That is what a
     second till in a shop is, and getting it wrong is what migration 024 exists
     for: two databases each bootstrapped separately are two shops, each with its
     own Admin role and its own counter under the same names, and no merge rule
     reconciles them. */
  const fxa = await freshDb()
  a = { id: TILL_A, db: fxa.db, fx: fxa }
  b = { id: TILL_B, db: await emptyDb() }
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

/**
 * Runs something as a particular till, the way that till's process would.
 *
 * Restores the previous id rather than clearing it, because these calls nest:
 * the far side of the wire answers `hello` as itself, in the middle of this side
 * running as itself. A real till never has this problem — one machine, one
 * identity, set once at startup — and the nesting is the price of putting both
 * ends in one process, which is a good trade for being able to test them at all.
 */
async function as<T>(till: Till, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try {
    return await fn()
  } finally {
    setDeviceId(before)
  }
}

/**
 * The other till, in process. Every method does exactly what an HTTP handler on
 * the far side would do, so what these tests exercise is the protocol and not
 * a mock of it.
 */
function wireTo(peer: Till, me: Till, over: Partial<PeerHello> = {}): SyncTransport {
  return {
    async hello() {
      const cursor = await as(peer, async () => {
        const row = await peer.db.get<{ my_cursor: number }>(
          `SELECT their_cursor AS my_cursor FROM sync_peers WHERE device_id = ?`, [me.id],
        )
        return row?.my_cursor ?? 0
      })
      return {
        deviceId: peer.id,
        label: peer.id.slice(0, 4),
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        shopId: await getSetting(peer.db, 'shop_id'),
        yourCursorWithThem: cursor,
        ...over,
      }
    },
    async fetch(since, limit) {
      /* The asking till is passed on, as `handleFetch` passes it: a batch
         leaves out what that till sent us, so nothing goes back where it came
         from. A fake wire that dropped this would make the relay untestable
         here and green anyway. */
      return as(peer, () => collectChanges(peer.db, since, limit, me.id))
    },
    async offer(batch) {
      return as(peer, async () => {
        // The far side records how far it has read of ours before answering,
        // so the cursor it hands back is one it has actually committed to.
        const both = await changedHere(peer.db, 0, batch.records)
        await applyBatch(peer.db, batch, both)
        await peer.db.execute(
          `INSERT INTO sync_peers (device_id, their_cursor, created_at) VALUES (?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET their_cursor = excluded.their_cursor`,
          [batch.fromDevice, batch.upTo, new Date().toISOString()],
        )
        return { upTo: batch.upTo }
      })
    },
  }
}

/** One round in each direction, which is what a real sync loop does. */
async function bothWays() {
  const first = await as(a, () => syncWith(a.db, wireTo(b, a)))
  const second = await as(b, () => syncWith(b.db, wireTo(a, b)))
  return { first, second }
}

async function nameOf(till: Till, productId: string): Promise<string | undefined> {
  const row = await till.db.get<{ name: string }>(
    `SELECT name FROM products WHERE id = ?`, [productId],
  )
  return row?.name
}

describe('a change made on one till reaches the other', () => {
  it('carries a new product across', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    await bothWays()

    expect(await nameOf(b, id)).toBe('Notebook')
  })

  it('carries an edit to a product that is already on both', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Ledger', id]))
    await bothWays()

    expect(await nameOf(b, id)).toBe('Ledger')
  })

  it('carries a setting, which is the shop rather than the machine', async () => {
    await as(a, () => setSetting(a.db, 'shop_name', 'TRT Stationery'))

    await bothWays()

    expect(await getSetting(b.db, 'shop_name')).toBe('TRT Stationery')
  })

  it('sends nothing at all the second time, having nothing new to say', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    const again = await bothWays()
    expect(again.first.ok && again.first.sent).toBe(0)
    expect(again.first.ok && again.first.received).toBe(0)
  })
})

describe('a bill travels whole', () => {
  it('arrives with its lines, not as an empty bill', async () => {
    const productId = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    const billId = await raiseBill(a, productId)

    /* Once. This used to be twice, with a comment saying the register and the
       user "have to land first" — which was a foreign-key ordering bug being
       accommodated by the test rather than caught by it. One round must carry a
       bill whole, or something is wrong. */
    await bothWays()

    const bill = await b.db.get<{ id: string }>(`SELECT id FROM bills WHERE id = ?`, [billId])
    const lines = await b.db.query<{ id: string }>(
      `SELECT id FROM bill_items WHERE bill_id = ?`, [billId],
    )
    expect(bill?.id).toBe(billId)
    expect(lines).toHaveLength(1)
  })

  it('replaces the lines rather than merging them into a bill nobody raised', async () => {
    const productId = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    const billId = await raiseBill(a, productId)
    await bothWays()

    // A second line on A only. B must end with two, not three.
    await as(a, async () => {
      const line = await a.db.get<Row>(`SELECT * FROM bill_items WHERE bill_id = ?`, [billId])
      const top = await a.db.get<{ n: number }>(
        `SELECT MAX(idx) AS n FROM bill_items WHERE bill_id = ?`, [billId],
      )
      const copy: Row = { ...line!, id: 'second-line', idx: (top?.n ?? 0) + 1 }
      const cols = Object.keys(copy)
      await a.db.execute(
        `INSERT INTO bill_items (${cols.map((c) => `"${c}"`).join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => copy[c] ?? null),
      )
    })
    await bothWays()

    const lines = await b.db.query<{ id: string }>(
      `SELECT id FROM bill_items WHERE bill_id = ?`, [billId],
    )
    expect(lines).toHaveLength(2)
  })
})

describe('when both tills changed the same thing', () => {
  it('leaves them agreeing, whichever way it goes', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From A', id]))
    await as(b, () => b.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From B', id]))

    await bothWays()
    await bothWays()

    /* The rule may pick either. What it may never do is leave the two tills
       holding different answers, each certain it is right and no further round
       able to settle it. */
    expect(await nameOf(a, id)).toBe(await nameOf(b, id))
  })

  it('says an edit was dropped rather than dropping it quietly', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From A', id]))
    await as(b, () => b.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From B', id]))

    const round = await as(a, () => syncWith(a.db, wireTo(b, a)))

    expect(round.ok).toBe(true)
    if (round.ok) {
      const complaint = round.contested.find((c) => c.rowId === id)
      expect(complaint).toBeDefined()
      expect(complaint?.explain).toMatch(/an edit is being dropped/)
    }
  })

  it('does not cry conflict when one till was simply behind', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Only A', id]))

    const round = await as(b, () => syncWith(b.db, wireTo(a, b)))
    expect(round.ok && round.contested).toEqual([])
  })
})

describe('what must never happen', () => {
  it('refuses a till too far behind to be talked to, before a single row moves', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    /* Below the floor, so the two are on opposite sides of a migration that
       dropped something. One version behind is a different case and is allowed
       -- `schema-skew.test.ts` in the bench is where both are pinned. */
    const round = await as(a, () =>
      syncWith(a.db, wireTo(b, a, { schemaVersion: MIN_PEER_SCHEMA_VERSION - 1 })))

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('theirs')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
    // And nothing crossed.
    expect(await b.db.query(`SELECT id FROM products`)).toHaveLength(0)
  })

  it('refuses when this till is the one that is too old', async () => {
    /* The other direction, which is not the same test. A peer that has taken a
       breaking migration this build has never seen says so in `minPeerSchema`,
       and the honest answer is that *we* are behind -- which is the sentence a
       shopkeeper needs, because the fix is on this machine. */
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    const round = await as(a, () => syncWith(a.db, wireTo(b, a, {
      schemaVersion: EXPECTED_SCHEMA_VERSION + 2,
      minPeerSchema: EXPECTED_SCHEMA_VERSION + 1,
    })))

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('mine')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
    expect(await b.db.query(`SELECT id FROM products`)).toHaveLength(0)
  })

  it('refuses a peer running a build from before the floor existed', async () => {
    /* An older build does not send `minPeerSchema` at all, and its own code
       demands an exact match -- so a round with it would be refused at its end
       whatever this side decides. Absent is read as "they demand equality",
       which makes the refusal happen here, with a reason, rather than halfway
       through. */
    const round = await as(a, () =>
      syncWith(a.db, wireTo(b, a, { schemaVersion: EXPECTED_SCHEMA_VERSION + 1 })))

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('mine')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
  })

  it('refuses a till that has set itself up as its own shop', async () => {
    /* The failure that produced migration 024. A second till that is installed
       and then *set up* has minted its own Admin role, its own counter and its
       own price list — the same names, different ids — and applying one into the
       other died on `UNIQUE constraint failed: roles.name` halfway through a
       batch, having already written part of somebody's database. There is no
       merge rule for it: the two rows are not two versions of one thing. */
    const ownShop = await freshDb()
    const other: Till = { id: TILL_B, db: ownShop.db }

    const round = await as(a, () => syncWith(a.db, wireTo(other, a)))

    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('DIFFERENT_SHOP')
    expect(await ownShop.db.query(`SELECT id FROM products`)).toHaveLength(0)
    await ownShop.db.close()
  })

  it('lets a till that has never been set up join any shop', async () => {
    // Which is what the second till in a shop actually is.
    expect(await getSetting(b.db, 'shop_id')).toBeNull()

    await bothWays()

    expect(await getSetting(b.db, 'shop_id')).toBe(await getSetting(a.db, 'shop_id'))
  })

  it('refuses to sync a till with itself', async () => {
    const round = await as(a, () => syncWith(a.db, wireTo(a, a)))
    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('SAME_DEVICE')
  })

  it('refuses when this machine does not know which machine it is', async () => {
    setDeviceId(null)
    const round = await syncWith(a.db, wireTo(b, a))
    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('NO_IDENTITY')
  })

  it('does not hand a change straight back to the till it came from', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    /* Applying is a write, and the write does land in B's feed — that is how a
       till in the middle relays to a third counter, which is migration 036. The
       thing that must not happen is the row going back to A: A would pull its
       own change, apply it, feed it, and two tills would pass one row between
       them for ever, each doing real work.

       So the entry is there, it says where it came from, and a batch built for
       A leaves it out. */
    const bFeed = await changesSince(b.db, 0, 1000)
    const entry = bFeed.find((c) => c.rowId === id)
    expect(entry?.originDevice).toBe(TILL_A)

    const forA = await collectChanges(b.db, 0, 500, TILL_A)
    expect(forA.records.some((r) => r.rowId === id)).toBe(false)

    // And for anybody else it travels, which is the point of keeping it.
    const forSomebodyElse = await collectChanges(b.db, 0, 500, TILL_C)
    expect(forSomebodyElse.records.some((r) => r.rowId === id)).toBe(true)
  })

  it('settles rather than circling, when both tills keep asking', async () => {
    /* The property the suppression used to give for free. Five rounds after the
       row has landed must move nothing and change nothing: an identical row
       that keeps being written is an identical row that keeps raising its own
       revision, because `bump_rev` fires on exactly the write that changes
       nothing. */
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    const revOf = async (till: Till) => (await till.db.get<{ rev: number }>(
      `SELECT rev FROM products WHERE id = ?`, [id]))?.rev

    const settled = { a: await revOf(a), b: await revOf(b) }
    expect(settled.a).toBe(settled.b)

    for (let i = 0; i < 5; i += 1) {
      const { first, second } = await bothWays()
      expect(first.ok && first.received, `round ${i} pulled nothing back`).toBe(0)
      expect(second.ok && second.received, `round ${i} pulled nothing back`).toBe(0)
    }

    expect(await revOf(a)).toBe(settled.a)
    expect(await revOf(b)).toBe(settled.b)
  })

  it('does not raise the revision of a row it was given', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    const mine = await a.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [id])
    const theirs = await b.db.get<{ rev: number }>(`SELECT rev FROM products WHERE id = ?`, [id])
    // Higher on the receiving side would make it look newer than the machine
    // that wrote it, and the next round would send it back as an edit nobody made.
    expect(theirs?.rev).toBe(mine?.rev)
  })
})

describe('a till joining a shop that was already selling', () => {
  /* The feed holds what has *changed*, and it started empty at migration 021. A
     shop a year into trading had two rows in its feed and twenty products, six
     customers and twenty-nine bills outside it — so a new till paired, synced,
     and received none of the shop. Pairing worked. Syncing worked. Nothing
     arrived, and nothing said so. */

  it('is sent the whole shop, not only what has changed lately', async () => {
    const productId = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await raiseBill(a, productId)

    // Everything settles, and then the feed is emptied — a shop that has been
    // running for a year, with nothing left to say to anybody.
    await pruneFeed(a.db, await feedHead(a.db))
    expect(await changesSince(a.db, 0, 10)).toEqual([])

    // A till joins now.
    const marked = await as(a, () => seedFeedWithEverything(a.db))
    expect(marked).toBeGreaterThan(0)
    await bothWays()

    for (const table of ['products', 'bills', 'bill_items', 'users', 'roles', 'registers']) {
      const there = await b.db.query(`SELECT * FROM "${table}"`)
      const here = await a.db.query(`SELECT * FROM "${table}"`)
      expect(there.length, `${table} did not arrive`).toBe(here.length)
    }
  })

  it('seeds parents before children, so nothing arrives orphaned', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await pruneFeed(a.db, await feedHead(a.db))
    await as(a, () => seedFeedWithEverything(a.db))

    const order = (await changesSince(a.db, 0, 10_000)).map((c) => c.table)
    // A user cannot be offered before the role it points at.
    expect(order.indexOf('roles')).toBeLessThan(order.indexOf('users'))
    expect(order.indexOf('categories')).toBeLessThan(order.indexOf('products'))
  })

  it('does not offer the same row twice when run again', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await pruneFeed(a.db, await feedHead(a.db))

    await as(a, () => seedFeedWithEverything(a.db))
    const first = (await changesSince(a.db, 0, 10_000)).length
    // A second till joins later; the first till's entries are still pending.
    expect(await as(a, () => seedFeedWithEverything(a.db))).toBe(0)
    expect((await changesSince(a.db, 0, 10_000)).length).toBe(first)
  })

  it('never raises a revision, because nothing actually changed', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    const before = await a.db.get<{ rev: number }>(
      `SELECT rev FROM products WHERE id = ?`, [id],
    )

    await as(a, () => seedFeedWithEverything(a.db))

    /* Touching the rows would have been the easy way to fill the feed, and it
       would have made this till look newer than every other one — a lie that
       then wins every merge it is in. */
    const after = await a.db.get<{ rev: number }>(
      `SELECT rev FROM products WHERE id = ?`, [id],
    )
    expect(after?.rev).toBe(before?.rev)
  })
})

describe('a till that has been switched off for a fortnight', () => {
  /* One round carries at most a batch. A till a long way behind needs several,
     and nothing above loops — so `more` was a flag nobody acted on. */

  it('keeps going until there is nothing left to say', async () => {
    await as(a, async () => {
      for (let i = 0; i < 12; i += 1) await makeProduct(a.db, { name: `Item ${i}` })
    })

    const round = await as(a, () => syncUntilDone(a.db, wireTo(b, a), 20))

    expect(round.ok).toBe(true)
    if (round.ok) expect(round.more).toBe(false)
    // Everything, not the first batch of it.
    const there = await b.db.query<{ id: string }>(`SELECT id FROM products`)
    const here = await a.db.query<{ id: string }>(`SELECT id FROM products`)
    expect(there).toHaveLength(here.length)
  })

  it('stops rather than spinning when a round achieves nothing', async () => {
    /* Two tills handing one row back and forth would otherwise loop for ever,
       each doing real work and neither getting anywhere. */
    let rounds = 0
    const stuck: SyncTransport = {
      ...wireTo(b, a),
      async fetch() {
        rounds += 1
        return {
          fromDevice: TILL_B, schemaVersion: EXPECTED_SCHEMA_VERSION,
          records: [], upTo: 0, complete: false,
        }
      },
    }

    const round = await as(a, () => syncUntilDone(a.db, stuck, 20))

    expect(round.ok).toBe(true)
    expect(rounds).toBeLessThan(5)
  })

  it('gives up after a fixed number of rounds rather than for ever', async () => {
    let rounds = 0
    const endless: SyncTransport = {
      ...wireTo(b, a),
      async fetch(since) {
        rounds += 1
        const id = `endless-${rounds}`
        return {
          fromDevice: TILL_B,
          schemaVersion: EXPECTED_SCHEMA_VERSION,
          records: [{
            table: 'categories', rowId: id, op: 'upsert',
            row: { id, name: id, created_at: '2026-01-01', updated_at: '2026-01-01', rev: 1 },
          }],
          upTo: since + 1,
          complete: false,
        }
      },
    }

    await as(a, () => syncUntilDone(a.db, endless, 4))
    expect(rounds).toBe(4)
  })
})

describe('what a person is told afterwards', () => {
  /* Up to here a sync happened because somebody pressed a button and watched the
     answer. Once it runs on its own, nobody is watching — and the failures that
     matter are the ones nothing interrupts. */

  it('keeps a record of an edit it dropped, rather than only returning it', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From A', id]))
    await as(b, () => b.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['From B', id]))
    await as(a, () => syncWith(a.db, wireTo(b, a)))

    const kept = await recentConflicts(a.db)
    const mine = kept.find((c) => c.rowId === id)
    expect(mine).toBeDefined()
    expect(mine?.table).toBe('products')
    expect(mine?.explain).toMatch(/dropped/)
    expect(mine?.peerDevice).toBe(TILL_B)
  })

  it('writes nothing when the merge it belonged to rolled back', async () => {
    /* A complaint about a change that was never applied would send somebody
       looking for something that did not happen. */
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()

    // Changed here too, so the incoming one is a genuine conflict.
    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Mine', id]))
    const row = await a.db.get<Row>(`SELECT * FROM products WHERE id = ?`, [id])

    const broken: SyncTransport = {
      ...wireTo(b, a),
      async fetch() {
        return {
          fromDevice: TILL_B,
          schemaVersion: EXPECTED_SCHEMA_VERSION,
          records: [
            // Wins, and is contested: this is the conflict that must not survive.
            { table: 'products', rowId: id, op: 'upsert',
              row: { ...row!, name: 'Theirs', rev: Number(row!['rev']) + 5 } },
            // And a user pointing at a role that does not exist. Foreign keys are
            // deferred inside the batch, so this fails at the commit and takes
            // everything written before it with it.
            { table: 'users', rowId: 'ghost', op: 'upsert', row: {
              id: 'ghost', username: 'ghost', full_name: 'Ghost',
              role_id: 'no-such-role', password_hash: 'x', is_active: 1,
              failed_logins: 0, rev: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            } },
          ],
          upTo: 99, complete: true,
        }
      },
    }

    await expect(as(a, () => syncWith(a.db, broken))).rejects.toThrow()

    expect(await recentConflicts(a.db)).toEqual([])
    // And the product it would have overwritten is untouched.
    expect(await nameOf(a, id)).toBe('Mine')
  })

  it('counts only what nobody has looked at', async () => {
    const id = await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await bothWays()
    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['A', id]))
    await as(b, () => b.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['B', id]))
    await as(a, () => syncWith(a.db, wireTo(b, a)))

    expect(await unreadConflictCount(a.db)).toBeGreaterThan(0)
    await acknowledgeConflicts(a.db)
    expect(await unreadConflictCount(a.db)).toBe(0)

    // Kept, not deleted: what the tills disagreed about is worth having later.
    expect((await recentConflicts(a.db, { unreadOnly: false })).length).toBeGreaterThan(0)
  })

  it('tells a till that is not answering apart from one with nothing to say', async () => {
    /* The number that lies most comfortably: a till that agreed at four and has
       been unreachable since five past looks, at a glance, exactly like one that
       agreed at four and has been quiet since. */
    await bothWays()
    const settled = (await listPeers(a.db))[0]!
    expect(settled.lastError).toBeNull()
    expect(settled.lastAgreedAt).not.toBeNull()

    await recordAttempt(a.db, TILL_B, 'fetch failed')

    const broken = (await listPeers(a.db))[0]!
    expect(broken.lastError).toBe('fetch failed')
    // And the moment it works again, it stops complaining.
    await recordAttempt(a.db, TILL_B, null)
    expect((await listPeers(a.db))[0]!.lastError).toBeNull()
  })

  it('says how much this till still has to tell that one', async () => {
    await bothWays()
    expect((await listPeers(a.db))[0]!.waiting).toBe(0)

    await as(a, () => makeProduct(a.db, { name: 'Not sent yet' }))
    expect((await listPeers(a.db))[0]!.waiting).toBeGreaterThan(0)

    await bothWays()
    expect((await listPeers(a.db))[0]!.waiting).toBe(0)
  })
})

describe('cursors', () => {
  it('moves a peer’s cursor only when that peer confirms it', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    const refuses: SyncTransport = {
      ...wireTo(b, a),
      // The batch left, and never landed.
      async offer() { throw new Error('the other till went away') },
    }

    await expect(as(a, () => syncWith(a.db, refuses))).rejects.toThrow('went away')

    const row = await a.db.get<{ my_cursor: number }>(
      `SELECT my_cursor FROM sync_peers WHERE device_id = ?`, [TILL_B],
    )
    expect(row?.my_cursor ?? 0).toBe(0)

    // And the change is still there to send, rather than lost in silence.
    await bothWays()
    expect(await b.db.query(`SELECT id FROM products`)).not.toHaveLength(0)
  })

  it('remembers who it has agreed with, and when', async () => {
    await bothWays()

    const peers = await listPeers(a.db)
    expect(peers.map((p) => p.deviceId)).toEqual([TILL_B])
    expect(peers[0]?.lastAgreedAt).not.toBeNull()
  })

  it('keeps a change until every peer has had it', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    // Nobody has confirmed anything yet, so nothing may be forgotten.
    expect(await pruneAcknowledged(a.db)).toBe(0)
    expect(await feedHead(a.db)).toBeGreaterThan(0)

    await bothWays()
    await pruneAcknowledged(a.db)

    const left = await changesSince(a.db, 0, 1000)
    expect(left).toEqual([])
  })

  it('prunes nothing on a shop that has never paired', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    expect(await pruneAcknowledged(a.db)).toBe(0)
  })
})

/**
 * A bill that has been rung up, which is the only kind that replicates.
 *
 * `createBill` leaves a draft, and since migration 042 a draft deliberately
 * stays on the till that is typing it. Submitted by hand rather than through
 * `submitBill` because these are replication tests: a bill refused on stock
 * policy would fail here as the wrong thing entirely.
 */
async function raiseBill(till: Till, productId: string): Promise<string> {
  return as(till, async () => {
    const made = await createBill(till.db, {
      registerId: till.fx!.seed.registerId,
      lines: [{ productId, qty: fromUnits(2) }],
      actorId: till.fx!.adminId,
    })
    if (!made.ok) throw new Error(made.code)
    await till.db.execute(
      `UPDATE bills SET docstatus = 1, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), made.billId],
    )
    return made.billId
  })
}

describe('points spent on one till', () => {
  /**
   * The schema review's first finding. A loyalty entry had no revision, so a
   * merge between an edited copy and an untouched one fell through to the last
   * tiebreak -- the higher device id -- and B is the higher id here. B kept its
   * copy with nothing spent, the redemption arrived inside its bill anyway, and
   * the customer could spend the same points again at B.
   */
  it('reach the other till, even when that till has the higher device id', async () => {
    const product = await as(a, async () => {
      await setSetting(a.db, 'loyalty_program', JSON.stringify({
        enabled: true, tiers: [{ minSpend: 0, pointsPerHundred: 5 }], expiryDays: 365,
        pointValue: 100, earnOnCreditPortion: false, minBillForEarn: 0, maxRedeemFractionBp: 10_000,
      }))
      const p = await makeProduct(a.db, { baseRate: rupees(500), taxRateBp: 0 })
      await a.db.transaction((tx) => postMovement(tx, {
        productId: p, qtyChange: fromUnits(20), voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
      }))
      return p
    })
    const customer = await makeCustomer(a.db)

    const sell = (redeem: number) => as(a, async () => {
      const draft = await createBill(a.db, {
        registerId: a.fx!.seed.registerId, customerId: customer,
        lines: [{ productId: product, qty: fromUnits(2) }], actorId: a.fx!.adminId,
      })
      if (!draft.ok) throw new Error(draft.code)
      const paid = await submitBill(a.db, {
        billId: draft.billId,
        payments: [{ method: 'cash', amount: (draft.grandTotal - rupees(redeem)) as typeof draft.grandTotal }],
        ...(redeem > 0 ? { redeemPoints: redeem } : {}),
        actorId: a.fx!.adminId,
      })
      if (!paid.ok) throw new Error(paid.code)
      return draft.billId
    })

    const earned = await sell(0)
    await bothWays()
    const spentOn = async (till: Till) => (await till.db.get<{ consumed: number }>(
      'SELECT consumed FROM loyalty_entries WHERE bill_id = ?', [earned]))?.consumed

    expect(await spentOn(b)).toBe(0)

    await sell(10)
    await bothWays()

    expect(await spentOn(a)).toBe(10)
    expect(await spentOn(b)).toBe(10)
  })
})

describe('one bill refunded on two tills while apart', () => {
  /**
   * Found by the independent review. A return was numbered in the series of
   * the *bill's* counter, so two tills refunding against one bill both minted
   * the same credit note number; after sync each quarantined the other's, and
   * a refund paid out on one never reached the other.
   */
  it('keeps both refunds, each under the till that paid it out', async () => {
    const { billId, itemId } = await as(a, async () => {
      const p = await makeProduct(a.db, { baseRate: rupees(100), taxRateBp: 0 })
      await a.db.transaction((tx) => postMovement(tx, {
        productId: p, qtyChange: fromUnits(10), voucherType: 'opening', voucherId: newId(), postingDate: '2026-01-01',
      }))
      const second = await createRegister(a.db, { name: 'Front Counter', prefix: 'FC', actorId: a.fx!.adminId })
      if (!second.ok) throw new Error(second.code)
      await claimRegister(a.db, { registerId: a.fx!.seed.registerId })
      const draft = await createBill(a.db, {
        registerId: a.fx!.seed.registerId, lines: [{ productId: p, qty: fromUnits(4) }], actorId: a.fx!.adminId,
      })
      if (!draft.ok) throw new Error(draft.code)
      const paid = await submitBill(a.db, {
        billId: draft.billId, payments: [{ method: 'cash', amount: draft.grandTotal }], actorId: a.fx!.adminId,
      })
      if (!paid.ok) throw new Error(paid.code)
      const item = await a.db.get<{ id: string }>('SELECT id FROM bill_items WHERE bill_id = ?', [draft.billId])
      return { billId: draft.billId, itemId: item!.id }
    })
    await bothWays()
    await as(b, async () => {
      const fc = await b.db.get<{ id: string }>(`SELECT id FROM registers WHERE prefix = 'FC'`)
      await claimRegister(b.db, { registerId: fc!.id })
    })

    const refund = (till: Till) => as(till, async () => {
      const ret = await createReturn(till.db, {
        billId, lines: [{ billItemId: itemId, qty: fromUnits(1) }], refundMethod: 'cash', actorId: a.fx!.adminId,
      })
      if (!ret.ok) throw new Error(ret.code)
      const done = await submitReturn(till.db, { returnId: ret.returnId, actorId: a.fx!.adminId })
      if (!done.ok) throw new Error(done.code)
      return done.docNo
    })
    const onA = await refund(a)
    const onB = await refund(b)
    expect(onA).not.toBe(onB)

    await bothWays()
    for (const till of [a, b]) {
      const setAside = await till.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_quarantine')
      expect(setAside?.n, 'nothing set aside').toBe(0)
      const held = await till.db.query<{ doc_no: string }>(
        'SELECT doc_no FROM sales_returns WHERE docstatus = 1 ORDER BY doc_no')
      expect(held.map((r) => r.doc_no).sort()).toEqual([onA, onB].sort())
    }
  })
})

describe('the same name made on two tills while apart', () => {
  it('is set aside with a reason that says what to do', async () => {
    await bothWays()
    await as(a, () => createRegister(a.db, { name: 'Counter 2', prefix: 'CA', actorId: a.fx!.adminId }))
    const user = await b.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')
    await as(b, () => createRegister(b.db, { name: 'Counter 2', prefix: 'CB', actorId: user!.id }))

    await bothWays()
    const reasons = [
      ...await a.db.query<{ reason: string }>('SELECT reason FROM sync_quarantine'),
      ...await b.db.query<{ reason: string }>('SELECT reason FROM sync_quarantine'),
    ].map((r) => r.reason)
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons[0]).toMatch(/a counter with the same name .* Rename or remove one/)
  })
})

describe('a barcode taken off an item', () => {
  it('stops scanning on the other till too, and comes back as the same row', async () => {
    /* Removal is an edit since 056, so it travels and merges like one -- a
       delete's tombstone could be outlived by a third till, and a barcode
       brought back that way scans as an item the shop took it off. */
    const { setBarcodes } = await import('../src/services/barcodes.js')
    const { productIdForBarcode } = await import('../src/services/barcodes.js')
    const ctx = { actorId: a.fx!.adminId }
    const p = await as(a, () => makeProduct(a.db, { name: 'Pen' }))
    await as(a, () => setBarcodes(a.db, ctx, p, [{ barcode: '8900000000017' }, { barcode: 'OLD-77' }]))
    await bothWays()
    expect(await as(b, () => productIdForBarcode(b.db, 'OLD-77'))).toBe(p)

    await as(a, () => setBarcodes(a.db, ctx, p, [{ barcode: '8900000000017' }]))
    await bothWays()
    expect(await as(b, () => productIdForBarcode(b.db, 'OLD-77'))).toBeNull()
    const kept = await b.db.get<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM product_barcodes WHERE barcode = 'OLD-77'`)
    expect(kept?.deleted_at).not.toBeNull()

    const before = await a.db.get<{ id: string }>(`SELECT id FROM product_barcodes WHERE barcode = 'OLD-77'`)
    await as(a, () => setBarcodes(a.db, ctx, p, [{ barcode: '8900000000017' }, { barcode: 'OLD-77' }]))
    const after = await a.db.get<{ id: string; deleted_at: string | null }>(
      `SELECT id, deleted_at FROM product_barcodes WHERE barcode = 'OLD-77'`)
    expect(after).toEqual({ id: before!.id, deleted_at: null })
  })
})
