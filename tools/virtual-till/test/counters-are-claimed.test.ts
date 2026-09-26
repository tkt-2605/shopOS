import { describe, it, expect, afterEach } from 'vitest'
import { countersOtherTillsUse, claimRegister } from '@shopos/core'
import { host, joiner, stopAll } from './bench.js'
import { openShop, topology, quiesce } from './shop.js'
import type { Till } from '../src/till.js'

/**
 * A counter that says which till sits at it, across a real shop.
 *
 * This exists because the first attempt did not survive one. It remembered what
 * each peer said its counter was in the last `/hello`, which passed its tests
 * and then, on three real tills, let two of them onto counter T2 and produced
 * twenty-four failed bills all numbered `BT2/2627/00001`.
 *
 * Two things were wrong and both are scenarios rather than units:
 *
 *   * a till learns nothing until it has exchanged a hello, and two tills set
 *     up minutes apart both choose before that happens;
 *   * a till behind a hub never exchanges a hello with its sibling at all,
 *     however long it waits.
 *
 * So the claim rides on `registers`, which replicates, and these are the two
 * shapes of shop that broke it.
 */

afterEach(stopAll)

describe('a counter that is already somebody\'s', () => {
  it('is known to a till that has only just joined, before any hello', async () => {
    /* The ordinary case that used to fail. The joining till pulls the shop,
       which carries the claim with every other row, so the counter screen it is
       shown next already knows. Nothing has hello'd anybody about counters. */
    const front = await host({ registerPrefix: 'MR' })
    await front.as(() => claimRegister(front.db, {
      registerId: front.registerId!, deviceId: front.deviceId,
    }))

    const back = await joiner({ registerPrefix: 'BC' })
    await back.pairWith(front)
    await back.sync(front)

    const taken = await back.as(() => countersOtherTillsUse(back.db, back.deviceId))
    expect(taken).toHaveLength(1)
    expect(taken[0]?.registerId).toBe(front.registerId)
    expect(taken[0]?.deviceId).toBe(front.deviceId)
  })

  it('reaches a till that has never spoken to the one that claimed it', async () => {
    /* The hub. `store` pairs with the hub and only the hub; `back`'s claim
       reaches it the way a price would -- relayed, per migration 036. The
       peers table on `store` has one row in it and it is not `back`. */
    const hub = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'BC' })
    const store = await joiner({
      registerPrefix: 'ST',
      deviceId: '3333cccc-3333-4333-8333-333333333333',
      label: 'Store room',
    })

    await back.pairWith(hub)
    await back.sync(hub)
    await back.claimRegister()
    await back.as(() => claimRegister(back.db, {
      registerId: back.registerId!, deviceId: back.deviceId,
    }))
    await back.sync(hub)

    await store.pairWith(hub)
    await store.sync(hub)

    const taken = await store.as(() => countersOtherTillsUse(store.db, store.deviceId))
    expect(taken.map((t) => t.registerId)).toContain(back.registerId)
  })

  it('is released when the till that held it moves', async () => {
    const front = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'BC' })

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    // Claims its own counter, then thinks better of it and takes the other one.
    await back.as(() => claimRegister(back.db, {
      registerId: back.registerId!, deviceId: back.deviceId,
    }))
    await back.as(() => claimRegister(back.db, {
      registerId: front.registerId!, deviceId: back.deviceId,
    }))
    await back.sync(front)

    const seenByFront = await front.as(() => countersOtherTillsUse(front.db, front.deviceId))
    expect(seenByFront.map((t) => t.registerId)).toEqual([front.registerId])
  })
})

/**
 * Four counters, and the claim that has to reach all of them.
 *
 * The two-till cases above are about a claim travelling one hop. What four
 * tills add is that most pairs never speak: on a ring each till has two
 * neighbours and two strangers, and the counter screen a shopkeeper is looking
 * at has to be right about the strangers too. That is the case the first
 * implementation got wrong — it asked the peers table what each till had said
 * in its last `/hello`, which is narrow by exactly the tills that never hello.
 */
describe('four counters and who is at them', () => {
  it('shows every till the other three, however few of them it talks to', async () => {
    const shop = await openShop(4, topology.ring(4))

    for (const till of shop.tills) {
      await till.as(() => claimRegister(till.db, {
        registerId: till.registerId!, deviceId: till.deviceId,
      }))
    }
    await quiesce(shop)

    for (const till of shop.tills) {
      const taken = await till.as(() => countersOtherTillsUse(till.db, till.deviceId))
      expect(
        taken.map((t) => t.registerId).sort(),
        `${till.label} can see the other three counters`,
      ).toEqual(shop.tills.filter((t) => t !== till).map((t) => t.registerId!).sort())
    }
  }, 120_000)

  it('leaves one free counter free on every till at once', async () => {
    /* Three tills and four counters. The spare has to look spare everywhere —
       a counter that reads as taken on one machine and free on another is how
       two tills end up choosing it in the same minute. */
    const shop = await openShop(4, topology.ring(4))
    const spare = shop.tills[3]!.registerId!

    for (const till of shop.tills.slice(0, 3)) {
      await till.as(() => claimRegister(till.db, {
        registerId: till.registerId!, deviceId: till.deviceId,
      }))
    }
    await shop.tills[3]!.db.execute(
      `UPDATE registers SET claimed_by = NULL, claimed_at = NULL WHERE id = ?`, [spare],
    )
    await quiesce(shop)

    for (const till of shop.tills) {
      const taken = await till.as(() => countersOtherTillsUse(till.db, till.deviceId))
      expect(taken.map((t) => t.registerId), `${till.label}`).not.toContain(spare)
    }
  }, 120_000)

  it('releases a counter across the whole shop when the till that held it moves', async () => {
    const shop = await openShop(4, topology.ring(4))
    const [, , side, store] = shop.tills as [Till, Till, Till, Till]

    for (const till of shop.tills) {
      await till.as(() => claimRegister(till.db, {
        registerId: till.registerId!, deviceId: till.deviceId,
      }))
    }
    await quiesce(shop)

    // The store room moves onto the counter the side till has left.
    const vacated = store.registerId!
    await store.as(() => claimRegister(store.db, {
      registerId: side.registerId!, deviceId: store.deviceId,
    }))
    await quiesce(shop)

    /* Every till, not only the two involved. A counter released on one machine
       and still shown as taken on a third is a counter nobody will ever pick. */
    for (const till of shop.tills) {
      const taken = await till.as(() => countersOtherTillsUse(till.db, till.deviceId))
      expect(taken.map((t) => t.registerId), `${till.label}`).not.toContain(vacated)
    }
  }, 120_000)
})
