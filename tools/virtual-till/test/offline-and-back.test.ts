import { describe, it, expect, afterEach } from 'vitest'
import { nextBackoff, BACKOFF_START_MS, BACKOFF_MAX_MS } from '@shopos/core'
import { withFaults } from '../src/faults.js'
import { host, joiner, stopAll, writeBill, billIds } from './bench.js'

/**
 * A till that was switched off, or on the other side of a dead switch.
 *
 * The thing being asserted is that the *other* till carries on. A shop with two
 * counters loses one of them regularly — it is unplugged to make room, the
 * power strip is switched off at the wall, somebody takes it home — and the
 * counter still selling must not stop, must not throw its way onto the screen,
 * and must not quietly decide the peer is gone and stop trying.
 *
 * Then the till comes back, and everything written while it was away arrives in
 * the next round. Not eventually, not after a manual "full resync": the next
 * round.
 */

afterEach(stopAll)

describe('a peer that cannot be reached', () => {
  it('fails a round without the failure escaping, three times running', async () => {
    let down = false
    const front = await host({ transport: (inner) => withFaults(inner, { partitioned: () => down }) })
    const back = await joiner()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    down = true

    let backoff = 0
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // No throw escapes. A sync loop runs every ninety seconds all day, and an
      // unhandled rejection there is an error dialog over the counter.
      const round = await front.sync(back)
      expect(round.ok).toBe(false)
      if (!round.ok) expect(round.code).toBe('UNREACHABLE')

      // And the gap grows, so a till that has been off since Tuesday is not
      // being dialled forty times an hour.
      const grown = nextBackoff(backoff)
      expect(grown).toBeGreaterThan(backoff)
      backoff = grown
    }
    expect(backoff).toBe(BACKOFF_START_MS * 4)
  })

  it('caps how long a till that is away is left alone', async () => {
    // Capped, because the till will come back and the shop must not then wait
    // an hour for its bills.
    let backoff = 0
    for (let i = 0; i < 40; i += 1) backoff = nextBackoff(backoff)
    expect(backoff).toBe(BACKOFF_MAX_MS)
  })

  it('carries everything written during the outage in the next round', async () => {
    let down = false
    const front = await host({ transport: (inner) => withFaults(inner, { partitioned: () => down }) })
    const back = await joiner()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    down = true
    const written: string[] = []
    for (let n = 1; n <= 3; n += 1) {
      written.push(await back.as(() =>
        writeBill(back.db, back.registerId!, { docNo: `BBC/2627/0000${n}` })))
    }

    expect(await front.sync(back)).toMatchObject({ ok: false })
    // Nothing arrived while it was down — the assertion that the failure was
    // real and not a test that passed because the partition did nothing.
    for (const id of written) expect(await billIds(front.db)).not.toContain(id)

    down = false
    const healed = await front.sync(back)
    expect(healed.ok).toBe(true)

    const landed = await billIds(front.db)
    for (const id of written) expect(landed).toContain(id)
  })

  it('leaves the peer paired, so nothing has to be set up again', async () => {
    let down = true
    const front = await host({ transport: (inner) => withFaults(inner, { partitioned: () => down }) })
    const back = await joiner()

    down = false
    await back.pairWith(front)
    await back.sync(front)

    down = true
    await front.sync(back)

    // A failed round is not a reason to forget a till. Re-pairing means reading
    // a code off a screen, which needs two people at two counters.
    const peers = await front.db.query<{ device_id: string }>(
      `SELECT device_id FROM sync_peers WHERE secret IS NOT NULL`,
    )
    expect(peers.map((p) => p.device_id)).toContain(back.deviceId)
  })
})
