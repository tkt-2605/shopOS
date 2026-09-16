import { describe, it, expect, afterEach } from 'vitest'
import { host, joiner, stopAll, writeBill } from './bench.js'

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
