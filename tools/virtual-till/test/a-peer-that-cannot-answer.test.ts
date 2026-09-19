import { describe, it, expect, afterEach } from 'vitest'
import { pairedPeers, pruneAcknowledged, listPeers } from '@shopos/core'
import { stopAll } from './bench.js'
import { openShop, quiesce, disagreements, drainUntilQuiet, topology } from './shop.js'
import type { Till } from '../src/till.js'

/**
 * A till nobody can dial.
 *
 * Two of the three peer shapes this protocol has to carry cannot be knocked on.
 * A phone is one — iOS suspends a backgrounded app, so there is no port and
 * there never will be. Anything behind NAT is the other, which is where a cloud
 * peer lives from the shop's side of the wire. Both work the same way: they ask,
 * and they are never asked.
 *
 * Until migration 044 that was inferred by accident. `pairedPeers` returned the
 * rows where an address happened to be recorded, which excluded a phone for the
 * right reason by the wrong route and *included* a cloud peer that a shop cannot
 * reach. An accident is not something the rest of the code can read: a screen
 * cannot say how far behind a peer is when its silence might mean asleep, might
 * mean unreachable, and might mean it was never going to answer.
 *
 * Nothing here needs a transport to be real, which is the point of it being
 * here. This is the cloud peer and the phone in one test.
 */

afterEach(stopAll)

/** What the shop records about a till it must never dial. */
async function cannotAnswer(shop: { tills: Till[] }, who: Till): Promise<void> {
  for (const till of shop.tills) {
    if (till === who) continue
    await till.db.execute(
      `UPDATE sync_peers SET reach = 'none' WHERE device_id = ?`, [who.deviceId],
    )
  }
}

const now = () => new Date().toISOString()

async function writeProductOn(till: Till, name: string): Promise<void> {
  await till.as(() => till.db.execute(
    `INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, 10000, 0, ?, ?)`,
    [name, now(), now()],
  ))
}

describe('a peer that asks and cannot answer', () => {
  it('is left alone by every till that could dial it', async () => {
    const shop = await openShop(3, topology.star(3))
    const phone = shop.tills[2]!
    await cannotAnswer(shop, phone)

    for (const till of shop.tills) {
      if (till === phone) continue
      const dialling = await till.as(() => pairedPeers(till.db))
      expect(
        dialling.map((p) => p.deviceId),
        `${till.label} should not be dialling a till that cannot pick up`,
      ).not.toContain(phone.deviceId)
    }
  }, 120_000)

  it('still ends up holding everything, by asking', async () => {
    const shop = await openShop(3, topology.star(3))
    const [hub, counter, phone] = shop.tills as [Till, Till, Till]
    await cannotAnswer(shop, phone)

    await writeProductOn(hub, 'Rung up at the hub')
    await writeProductOn(counter, 'Rung up at the counter')
    await writeProductOn(phone, 'Typed on the phone')

    /* Every exchange the phone is part of is one the phone starts. The other
       two talk to each other as usual; nothing ever calls the phone. */
    await drainUntilQuiet(counter, hub)
    await drainUntilQuiet(hub, counter)
    await drainUntilQuiet(phone, hub)
    await drainUntilQuiet(counter, hub)
    await drainUntilQuiet(hub, counter)
    await drainUntilQuiet(phone, hub)

    expect(await disagreements(shop)).toEqual([])
  }, 120_000)

  /**
   * The half that is easy to get wrong in the other direction.
   *
   * `pruneAcknowledged` holds the feed at the lowest cursor of every peer. A
   * till that is never dialled reads late by definition — it reads when
   * somebody picks the phone up — so the feed has to wait for it exactly as it
   * would for a counter that was switched off. Dropping entries because a peer
   * is unreachable is how a machine silently never learns something.
   */
  it('holds the feed until it has read, and releases it afterwards', async () => {
    const shop = await openShop(2, topology.line(2))
    const [hub, phone] = shop.tills as [Till, Till]
    await cannotAnswer(shop, phone)
    await quiesce(shop)

    await writeProductOn(hub, 'Rung up while the phone was in a pocket')

    /* Pruning is free to drop what the phone has already read. What it must not
       drop is this, which the phone has not — and nothing will mention that row
       again once the entry is gone. */
    await hub.as(() => pruneAcknowledged(hub.db))
    expect(await feedRows(hub), 'held for a till that has not picked up').toBeGreaterThan(0)

    /* Twice, and not to be generous. The hub records how far the phone has read
       from what the phone *asks for*, so the round that carried the rows ends
       with the hub still believing the phone is one batch behind. It learns
       otherwise on the next ask, which on a real till is forty-five seconds
       later and which is why the feed is held rather than dropped. */
    await drainUntilQuiet(phone, hub)
    await drainUntilQuiet(phone, hub)
    await hub.as(() => pruneAcknowledged(hub.db))

    expect(await feedRows(hub), 'and released once it has').toBe(0)
  }, 120_000)

  it('is still counted when the shop asks how far behind it is', async () => {
    /* A peer nothing dials is still a peer, and the screens that add up the
       shop have to know whether its bills are in the total. */
    const shop = await openShop(2, topology.line(2))
    const [hub, phone] = shop.tills as [Till, Till]
    await cannotAnswer(shop, phone)

    await drainUntilQuiet(phone, hub)
    const [asSeenByThePhone] = await phone.as(() => listPeers(phone.db))
    expect(asSeenByThePhone?.behind, 'it asked, so it knows').not.toBeNull()
  }, 120_000)
})

async function feedRows(till: Till): Promise<number> {
  const row = await till.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_feed`)
  return row?.n ?? 0
}
