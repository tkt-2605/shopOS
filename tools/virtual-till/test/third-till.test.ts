import { describe, it, expect, afterEach } from 'vitest'
import { DEVICE_IDS, benchDir, drain, host, joiner, till, stopAll, writeBill, countOf } from './bench.js'

/**
 * A third counter, added to a shop that has been trading.
 *
 * Every other scenario starts both tills empty, which is the one case a shop is
 * never in. The interesting one is this: two counters have been selling for
 * months, and a third till is switched on. It has to end up holding *the same
 * shop* — not most of it, not everything since it was plugged in, all of it.
 *
 * The bug this guards against is a real one that was already found once: the
 * change feed only holds what has changed since migration 021, so on a shop
 * that had been selling for a year it held two rows. Pairing succeeded, syncing
 * succeeded, and nothing arrived. `seedFeedWithEverything` is why that is not
 * still true, and this is what keeps it not true.
 */

afterEach(stopAll)

const TRAFFIC = 200

describe('a till that joins a shop already in business', () => {
  it('ends up with the same rows as the two that were already there', async () => {
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    // Months of trade, from both counters.
    for (let n = 1; n <= TRAFFIC / 2; n += 1) {
      await front.as(() => writeBill(front.db, front.registerId!, {
        docNo: `BFR/2627/${String(n).padStart(5, '0')}`,
      }))
      await back.as(() => writeBill(back.db, back.registerId!, {
        docNo: `BBC/2627/${String(n).padStart(5, '0')}`,
      }))
    }
    await back.sync(front)
    await front.sync(back)

    expect(await countOf(front.db, 'bills')).toBe(TRAFFIC)
    expect(await countOf(back.db, 'bills')).toBe(TRAFFIC)

    // The new till, switched on for the first time.
    const third = await till({
      dataDir: benchDir(), deviceId: DEVICE_IDS.c, label: 'Side counter',
      registerPrefix: 'SD', seed: 'empty',
    })
    await third.pairWith(front)

    // `syncUntilDone` is what the app runs; one round is capped at a batch.
    for (let i = 0; i < 12; i += 1) {
      const round = await third.sync(front)
      expect(round.ok).toBe(true)
      if (round.ok && !round.more) break
    }

    expect(await countOf(third.db, 'bills')).toBe(TRAFFIC)
  })

  it('carries the shop, not just the bills', async () => {
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    const third = await till({
      dataDir: benchDir(), deviceId: DEVICE_IDS.c, label: 'Side counter',
      registerPrefix: 'SD', seed: 'empty',
    })
    await third.pairWith(front)
    for (let i = 0; i < 12; i += 1) {
      const round = await third.sync(front)
      if (round.ok && !round.more) break
    }

    /* A till that took the bills and not the roles, the counters or the shop's
       own settings is a till that cannot sign anybody in — and it would look
       perfectly synced. */
    for (const table of ['registers', 'roles', 'settings']) {
      expect(await countOf(third.db, table)).toBe(await countOf(front.db, table))
    }
  })

  it('keeps getting that counter’s sales afterwards, through the till in the middle', async () => {
    /* The one that matters, and the one the two above do not cover.
       `seedFeedWithEverything` means a joining till receives the whole shop
       from whoever it pairs with, including rows that came from a third
       machine -- so a shop set up this morning looks perfectly synced. What a
       shop actually does is sell something tomorrow.

       A hub is what a shopkeeper builds: one machine everything talks to. So
       the hub has to relay, and relaying is exactly what a till that applies a
       change does not do by default -- it keeps the change out of its own feed
       so two tills cannot hand one row back and forth for ever. */
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const third = await till({
      dataDir: benchDir(), deviceId: DEVICE_IDS.c, label: 'Side counter',
      registerPrefix: 'SD', seed: 'empty',
    })
    await third.pairWith(front)
    await drain(third, front)

    // Tomorrow. The back counter sells something; the side counter is not
    // paired with it and never will be.
    await back.as(() => writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00999' }))
    await back.sync(front)
    await drain(third, front)

    const onThird = await third.db.query<{ doc_no: string }>(
      `SELECT doc_no FROM bills WHERE doc_no = ?`, ['BBC/2627/00999'])
    expect(onThird, 'the side counter has the back counter’s sale').toHaveLength(1)
  })

  it('agrees with both of the others, not just the one it paired with', async () => {
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    await back.as(() => writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00777' }))
    await back.sync(front)

    const third = await till({
      dataDir: benchDir(), deviceId: DEVICE_IDS.c, label: 'Side counter',
      registerPrefix: 'SD', seed: 'empty',
    })
    await third.pairWith(front)
    for (let i = 0; i < 12; i += 1) {
      const round = await third.sync(front)
      if (round.ok && !round.more) break
    }

    // It never spoke to the back counter, and still has the back counter's bill.
    const rows = await third.db.query<{ doc_no: string }>(
      `SELECT doc_no FROM bills WHERE doc_no = ?`, ['BBC/2627/00777'])
    expect(rows).toHaveLength(1)
  })
})
