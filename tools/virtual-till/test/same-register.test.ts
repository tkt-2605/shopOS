import { describe, it, expect, afterEach } from 'vitest'
import { claimRegister, countersOtherTillsUse } from '@shopos/core'
import { host, joiner, stopAll, writeBill } from './bench.js'
import { openShop, topology, drainUntilQuiet } from './shop.js'
import type { Till } from '../src/till.js'

/**
 * Two tills that think they are the same counter.
 *
 * A document number is `B` + the counter's prefix + the fiscal year + a serial,
 * and the serial is per counter. Two tills on one counter therefore mint the
 * *same* number for two different sales, and under Rule 46(b) a consecutive
 * invoice number is not optional — two bills carrying `BMR/2627/00001` is a
 * defect on the shop's return, not an inconvenience.
 *
 * It is a real mistake to make: a shop installs the second till, is asked which
 * counter it sits at, and picks the one it recognises. So the refusal happens
 * before any row crosses, and it names the counter.
 */

afterEach(stopAll)

describe('two tills on one counter', () => {
  it('refuses to sync rather than minting a number twice', async () => {
    const front = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'MR' })

    await back.pairWith(front)
    // The first round is how the joiner takes the shop, and it is allowed:
    // until it has the shop it has no counters at all to collide with.
    await back.sync(front)

    // Now it picks a counter, and picks the one that is already in use.
    await back.claimRegister()
    expect(back.registerId).toBe(front.registerId)

    const round = await back.sync(front)

    expect(round.ok).toBe(false)
    if (!round.ok) {
      expect(round.code).toBe('SAME_REGISTER')
      if (round.code === 'SAME_REGISTER') expect(round.registerId).toBe(front.registerId)
    }
  })

  it('refuses from the host end as well', async () => {
    // The refusal is computed from `/hello`, which each side asks of the other.
    // A check that only ran on the joiner would leave the host happily pulling
    // bills numbered from a series it is also minting from.
    const front = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'MR' })

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const round = await front.sync(back)
    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('SAME_REGISTER')
  })

  it('never lets one document number exist twice across the two tills', async () => {
    const front = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'MR' })

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    // Both tills bill, both believing they own the series.
    await front.as(() => writeBill(front.db, front.registerId!, { docNo: 'BMR/2627/00001' }))
    await back.as(() => writeBill(back.db, back.registerId!, { docNo: 'BMR/2627/00002' }))

    // The refusal is what keeps them apart, so neither ever holds both rows —
    // which is what a collision would look like after the fact.
    expect((await back.sync(front)).ok).toBe(false)

    const onFront = await front.db.query<{ doc_no: string }>(`SELECT doc_no FROM bills`)
    const onBack = await back.db.query<{ doc_no: string }>(`SELECT doc_no FROM bills`)
    expect(onFront.map((b) => b.doc_no)).toEqual(['BMR/2627/00001'])
    expect(onBack.map((b) => b.doc_no)).toEqual(['BMR/2627/00002'])
  })

  it('syncs happily once the second till is moved to its own counter', async () => {
    const front = await host({ registerPrefix: 'MR' })
    const back = await joiner({ registerPrefix: 'MR' })

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()
    expect((await back.sync(front)).ok).toBe(false)

    // What a shopkeeper does next: pick the other counter. The refusal has to
    // be recoverable without re-pairing, or the fix is worse than the fault.
    const own = await back.as(async () => {
      const id = 'back-counter'
      const now = new Date().toISOString()
      await back.db.execute(
        `INSERT INTO registers (id, name, prefix, is_active, created_at, updated_at)
         VALUES (?, 'Back counter', 'BC', 1, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [id, now, now],
      )
      return id
    })
    await back.useRegister(own)

    expect((await back.sync(front)).ok).toBe(true)
  })
})

/**
 * Four counters, which is where the refusal stops being a two-body problem.
 *
 * With two tills, "are we on the same counter" is one comparison and the
 * scenarios above cover it from both ends. With four, three things become
 * possible that were not, and none of them is exotic:
 *
 *   * the two tills on one counter may not be paired with each other at all,
 *     so neither ever asks the other the question;
 *   * a till may be on a counter that is fine with two of its peers and a
 *     collision with the third, so refusing a peer is not the same as stopping;
 *   * the shop must go on working around the pair that cannot talk, rather than
 *     one mistake at one counter stopping the whole of it.
 */
describe('four tills, and two of them on one counter', () => {
  async function fourCounters(): Promise<Till[]> {
    const shop = await openShop(4, topology.mesh(4))
    return shop.tills
  }

  it('refuses the pair that collides and nobody else', async () => {
    const tills = await fourCounters()
    const [front, back, side, store] = tills as [Till, Till, Till, Till]

    // The store room is moved onto the front counter — the mistake a shopkeeper
    // makes by recognising the name on the list.
    await store.useRegister(front.registerId!)

    const clash = await store.sync(front)
    expect(clash.ok, 'the two on one counter').toBe(false)
    if (!clash.ok) expect(clash.code).toBe('SAME_REGISTER')

    /* And the rest of the shop carries on. A refusal is about a pair of tills,
       not about the shop — treating it as a shop-wide stop would mean one
       mis-set counter halting replication between two machines that are
       perfectly fine. */
    for (const [from, to] of [[store, back], [store, side], [back, front], [side, front]] as const) {
      const round = await from.sync(to)
      expect(round.ok, `${from.label} -> ${to.label}`).toBe(true)
    }
  }, 120_000)

  it('is refused from whichever end asks', async () => {
    const tills = await fourCounters()
    const [front, , , store] = tills as [Till, Till, Till, Till]
    await store.useRegister(front.registerId!)

    for (const [from, to] of [[store, front], [front, store]] as const) {
      const round = await from.sync(to)
      expect(round.ok, `${from.label} -> ${to.label}`).toBe(false)
      if (!round.ok) expect(round.code).toBe('SAME_REGISTER')
    }
  }, 120_000)

  it('still refuses when the two on one counter have never met', async () => {
    /* A ring, so the front counter and the store room are never paired: the
       question "are we on the same counter" is one neither of them is ever in a
       position to ask the other. The claim is what carries — it rides on
       `registers`, which replicates — so each of them finds out from a till in
       the middle. */
    const shop = await openShop(4, topology.ring(4))
    const [front, , , store] = shop.tills as [Till, Till, Till, Till]

    await store.useRegister(front.registerId!)
    await store.as(() => claimRegister(store.db, {
      registerId: front.registerId!, deviceId: store.deviceId,
    }))
    await drainUntilQuiet(shop.tills[3]!, shop.tills[2]!)
    await drainUntilQuiet(shop.tills[2]!, shop.tills[1]!)
    await drainUntilQuiet(shop.tills[1]!, shop.tills[0]!)

    const taken = await front.as(() => countersOtherTillsUse(front.db, front.deviceId))
    expect(
      taken.map((t) => t.registerId),
      'the front counter has heard that somebody else claims its counter',
    ).toContain(front.registerId)
  }, 120_000)
})
