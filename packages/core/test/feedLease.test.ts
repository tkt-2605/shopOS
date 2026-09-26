import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { pruneAcknowledged, collectChanges } from '../src/services/sync.js'
import { feedHead, prunedThrough, pendingCount } from '../src/services/changefeed.js'
import { setDeviceId } from '../src/device.js'
import { freshDb, makeProduct, type Fixture } from './helpers.js'

/**
 * A peer that stops coming back.
 *
 * Pruning stopped at the slowest peer, and a peer was only ever forgotten by a
 * person, so one phone in a drawer held every till's feed where it was for the
 * life of the shop. Now a peer unheard for thirty days stops holding it back,
 * and if it does return it is sent the whole shop again. Migration 061.
 */

const SHOP = '11111111-1111-4111-8111-111111111111'
const DAY = 24 * 60 * 60 * 1000
let fx: Fixture

beforeEach(async () => { fx = await freshDb(); setDeviceId(SHOP) })
afterEach(async () => { setDeviceId(null); await fx.db.close() })

async function peer(id: string, cursor: number, heardDaysAgo: number) {
  const at = new Date(Date.now() - heardDaysAgo * DAY).toISOString()
  await fx.db.execute(
    `INSERT INTO sync_peers (device_id, my_cursor, last_agreed_at, created_at) VALUES (?, ?, ?, ?)`,
    [id, cursor, at, at],
  )
}

describe('pruning the feed', () => {
  it('is held back by a peer still in touch', async () => {
    await makeProduct(fx.db)
    await peer('the-back-till', 0, 2)
    expect(await pruneAcknowledged(fx.db)).toBe(0)
  })

  it('is no longer held back by a peer gone quiet for a month, and says how far it went', async () => {
    await makeProduct(fx.db)
    const head = await feedHead(fx.db)
    await peer('the-back-till', head, 0)
    await peer('a-phone-in-a-drawer', 0, 40)

    expect(await pruneAcknowledged(fx.db)).toBeGreaterThan(0)
    expect(await pendingCount(fx.db)).toBe(0)
    expect(await prunedThrough(fx.db)).toBe(head)
  })

  it('prunes nothing when every peer has gone quiet', async () => {
    await makeProduct(fx.db)
    await peer('a-phone-in-a-drawer', 0, 40)
    expect(await pruneAcknowledged(fx.db)).toBe(0)
  })
})

describe('a peer that comes back after the feed went on without it', () => {
  it('is sent the whole shop, not what happens to be left in the feed', async () => {
    const early = await makeProduct(fx.db, { name: 'Sold before the phone went quiet' })
    await peer('the-back-till', await feedHead(fx.db), 0)
    await peer('a-phone-in-a-drawer', 0, 40)
    await pruneAcknowledged(fx.db)

    const batch = await collectChanges(fx.db, 0, 5000, 'a-phone-in-a-drawer')
    expect(batch.records.some((r) => r.rowId === early), 'the pruned row is sent again').toBe(true)
  })

  it('is not sent it again by a peer that never fell behind', async () => {
    const head0 = await feedHead(fx.db)
    await peer('the-back-till', head0, 0)
    await pruneAcknowledged(fx.db)
    await makeProduct(fx.db, { name: 'After' })

    const batch = await collectChanges(fx.db, head0, 5000, 'the-back-till')
    expect(batch.records.map((r) => r.table)).toEqual(['products'])
  })
})
