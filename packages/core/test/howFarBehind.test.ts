import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listPeers, syncWith, collectChanges, applyBatch } from '../src/services/sync.js'
import { pruneAcknowledged } from '../src/services/sync.js'
import { feedHead, pruneFeed } from '../src/services/changefeed.js'
import { handleOffer } from '../src/services/syncServer.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { newId } from '../src/ids.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { getSetting } from '../src/services/bootstrap.js'
import { freshDb, emptyDb, makeProduct, type Fixture } from './helpers.js'
import type { SqlDriver } from '../src/db/driver.js'
import type { SyncTransport, PeerHello } from '../src/services/sync.js'

/**
 * How far behind the other till this one is.
 *
 * The number nothing could produce before migration 044: `PeerHealth` carried
 * what this till still owed a peer and nothing about what it was owed, so a
 * report could say "both tills have everything" while this machine was ninety
 * bills short and every total printed was short with it.
 *
 * The distinction these tests exist for is between **nothing to send** and
 * **nothing said**, which arrive as the same number. A peer whose feed has been
 * pruned — every entry read by everybody, which is a shop that has caught up
 * and gone quiet — honestly reports a head of 0. So does a peer on a build too
 * old to have the field. The first is the healthiest state there is and the
 * second is a state nothing is known about, and a screen that prints them the
 * same way gets the common one wrong.
 *
 * That is not hypothetical and it is not theoretical. It shipped, and three
 * real tills left running for four minutes found it: every one of them caught
 * up, every feed pruned empty, and every screen saying it could not tell.
 */

const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

interface Till { id: string; db: SqlDriver; fx?: Fixture }
let a: Till
let b: Till

beforeEach(async () => {
  const fxa = await freshDb()
  a = { id: TILL_A, db: fxa.db, fx: fxa }
  b = { id: TILL_B, db: await emptyDb() }
})

afterEach(async () => {
  setDeviceId(null)
  await a.db.close()
  await b.db.close()
})

async function as<T>(till: Till, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(till.id)
  try { return await fn() } finally { setDeviceId(before) }
}

/** B talking to A, over the same calls the app makes. */
function transportToA(): SyncTransport {
  return {
    async hello(): Promise<PeerHello> {
      return as(a, async () => {
        const row = await a.db.get<{ c: number }>(
          `SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [TILL_B],
        )
        return {
          deviceId: TILL_A, label: 'Front counter',
          schemaVersion: EXPECTED_SCHEMA_VERSION, minPeerSchema: 1,
          shopId: await getSetting(a.db, 'shop_id'),
          registerId: null,
          yourCursorWithThem: row?.c ?? 0,
          head: await feedHead(a.db),
          answers: true,
          now: Date.now(),
        }
      })
    },
    fetch: (since, limit) => as(a, () => collectChanges(a.db, since, limit, TILL_B)),
    async offer(batch) {
      const answer = await as(a, () => handleOffer(
        a.db, { path: '/offer', body: JSON.stringify(batch), auth: null }, TILL_B,
      ))
      return JSON.parse(answer.body) as { upTo: number }
    },
  }
}

async function behindOnB(): Promise<number | null> {
  const [peer] = await as(b, () => listPeers(b.db))
  return peer?.behind ?? null
}

describe('what this till is short of', () => {
  it('is unknown until the other one has said, which is not the same as level', async () => {
    /* A peer row written by pairing and never synced. Nothing has been told, and
       "0 behind" would be a claim nobody has earned. */
    await b.db.execute(
      `INSERT INTO sync_peers (device_id, label, created_at) VALUES (?, 'A', ?)`,
      [TILL_A, new Date().toISOString()],
    )
    expect(await behindOnB()).toBeNull()
  })

  it('counts what the other till holds and this one has not read', async () => {
    for (let i = 0; i < 3; i += 1) {
      await as(a, () => makeProduct(a.db, { id: newId(), name: `Product ${i}` }))
    }
    // A handshake and nothing else: B learns A's head without taking a batch.
    await b.db.execute(
      `INSERT INTO sync_peers (device_id, label, created_at) VALUES (?, 'A', ?)`,
      [TILL_A, new Date().toISOString()],
    )
    const hello = await transportToA().hello()
    await as(b, () => applyBatch(b.db, {
      fromDevice: TILL_A, schemaVersion: EXPECTED_SCHEMA_VERSION,
      records: [], upTo: 0, complete: true,
    }, new Set()))
    await b.db.execute(
      `UPDATE sync_peers SET their_head = ?, head_said_at = ? WHERE device_id = ?`,
      [hello.head ?? 0, new Date().toISOString(), TILL_A],
    )

    expect(await behindOnB()).toBeGreaterThan(0)
  })

  it('goes to zero once this till has read it all', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await as(b, () => syncWith(b.db, transportToA(), null))
    await as(b, () => syncWith(b.db, transportToA(), null))

    expect(await behindOnB()).toBe(0)
  })

  /**
   * The one that shipped broken.
   *
   * `pruneAcknowledged` drops every entry all peers have read, so a shop that
   * has caught up has an empty feed and `feedHead` returns 0 — honestly. Read
   * as "nothing said", that made the quietest, healthiest state the one that
   * reported it could not tell.
   */
  it('stays zero when the other till has pruned its feed away', async () => {
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await as(b, () => syncWith(b.db, transportToA(), null))
    await as(b, () => syncWith(b.db, transportToA(), null))

    // A has nothing left to tell anybody, so it keeps nothing.
    const head = await feedHead(a.db)
    await as(a, () => pruneFeed(a.db, head))
    expect(await feedHead(a.db), 'an empty feed is what a caught-up shop has').toBe(0)

    await as(b, () => syncWith(b.db, transportToA(), null))

    expect(
      await behindOnB(),
      'nothing to send is not silence — this is a shop that agrees, not one that cannot tell',
    ).toBe(0)
  })

  it('never reports a negative, however the two numbers cross', async () => {
    /* A head recorded at a handshake, then overtaken by rows this till pulled
       in the same pass. Owing somebody minus four bills is not a sentence. */
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await as(b, () => syncWith(b.db, transportToA(), null))
    await b.db.execute(
      `UPDATE sync_peers SET their_head = 1, their_cursor = 99 WHERE device_id = ?`, [TILL_A],
    )

    expect(await behindOnB()).toBe(0)
  })
})

describe('a feed nobody has finished reading', () => {
  it('is held for the till that is behind, and let go once it is not', async () => {
    /* The other half of the same fact, and the reason `their_head` is worth
       having: a peer that is behind is a peer whose feed entries this till must
       keep. `pruneAcknowledged` is what enforces it. */
    await as(a, () => makeProduct(a.db, { name: 'Notebook' }))
    await a.db.execute(
      `INSERT INTO sync_peers (device_id, label, my_cursor, created_at) VALUES (?, 'B', 0, ?)`,
      [TILL_B, new Date().toISOString()],
    )

    expect(await as(a, () => pruneAcknowledged(a.db)), 'B has read none of it').toBe(0)

    const head = await feedHead(a.db)
    await a.db.execute(
      `UPDATE sync_peers SET my_cursor = ? WHERE device_id = ?`, [head, TILL_B],
    )
    expect(await as(a, () => pruneAcknowledged(a.db))).toBeGreaterThan(0)
  })
})
