import { describe, it, expect, afterEach } from 'vitest'
import { DEVICE_IDS, benchDir, host, joiner, till, stopAll, writeBill, countOf } from './bench.js'

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
