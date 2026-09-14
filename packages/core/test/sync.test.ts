import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  syncWith, collectChanges, applyBatch, changedHere, listPeers, pruneAcknowledged,
  type SyncTransport, type PeerHello,
} from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { changesSince, feedHead } from '../src/services/changefeed.js'
import { setSetting, getSetting } from '../src/services/bootstrap.js'
import { createBill } from '../src/services/billing.js'
import { fromUnits } from '../src/quantity.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
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
      return as(peer, () => collectChanges(peer.db, since, limit))
    },
    async offer(batch) {
      return as(peer, async () => {
        // The far side records how far it has read of ours before answering,
        // so the cursor it hands back is one it has actually committed to.
        const both = await changedHere(peer.db, 0)
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
    const billId = await as(a, async () => {
      const made = await createBill(a.db, {
        registerId: a.fx!.seed.registerId,
        lines: [{ productId, qty: fromUnits(2) }],
        actorId: a.fx!.adminId,
      })
      if (!made.ok) throw new Error(made.code)
      return made.billId
    })

    // Twice: the bill references a register and a user that have to land first.
    await bothWays()
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
    const billId = await as(a, async () => {
      const made = await createBill(a.db, {
        registerId: a.fx!.seed.registerId,
        lines: [{ productId, qty: fromUnits(2) }],
        actorId: a.fx!.adminId,
      })
      if (!made.ok) throw new Error(made.code)
      return made.billId
    })
    await bothWays()
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
    await bothWays()

    await as(a, () => a.db.execute(`UPDATE products SET name = ? WHERE id = ?`, ['Only A', id]))

    const round = await as(b, () => syncWith(b.db, wireTo(a, b)))
    expect(round.ok && round.contested).toEqual([])
  })
})

describe('what must never happen', () => {
  it('refuses a till on a different schema before a single row moves', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))

    const round = await as(a, () =>
      syncWith(a.db, wireTo(b, a, { schemaVersion: EXPECTED_SCHEMA_VERSION - 1 })))

    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('SCHEMA_MISMATCH')
    // And nothing crossed.
    expect(await b.db.query(`SELECT id FROM products`)).toHaveLength(0)
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

    /* Applying is a write. Without the suppression that write lands in B's feed,
       and A pulls its own change back, applies it, feeds it — two tills passing
       one row between them for ever, each doing real work. */
    const bFeed = await changesSince(b.db, 0, 1000)
    expect(bFeed.some((c) => c.rowId === id)).toBe(false)
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
