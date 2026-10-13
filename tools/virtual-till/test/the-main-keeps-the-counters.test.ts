import { describe, it, expect, afterEach } from 'vitest'
import {
  changeCounter, claimRegister, grantClaim, pairedPeers, renewClaim, requestClaim,
  resolveDeviceRegister, type ClaimAsk,
} from '@shopos/core'
import { DEVICE_IDS, drain, host, joiner, stopAll } from './bench.js'
import type { Till } from '../src/till.js'

/**
 * Which till sits at a counter is the main's to say, and only while it can be
 * asked.
 *
 * A counter is a number series, and two machines on one counter print one bill
 * number twice. Tills apart from each other cannot settle that: each holds its
 * own copy of who sits where, and a till switched off for four days wakes up
 * believing the counter it left is still its own. So a till asks the main,
 * live, and the main does not take a claim from a merge either.
 */

afterEach(stopAll)

const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000

/** The question a till's Counters screen puts, through the real `/claim`. */
function ask(till: Till): (a: ClaimAsk) => Promise<Awaited<ReturnType<typeof requestClaim>>> {
  return async (a) => {
    const peer = (await pairedPeers(till.db))[0]
    if (peer === undefined) throw new Error('no main to ask')
    return requestClaim(peer, a, fetch, { listenPort: till.port })
  }
}

async function claimedBy(till: Till, registerId: string): Promise<string | null> {
  const row = await till.db.get<{ claimed_by: string | null }>(
    `SELECT claimed_by FROM registers WHERE id = ?`, [registerId],
  )
  return row?.claimed_by ?? null
}

/** A shop with a main that sits at its own counter, and one till behind it. */
async function shop(): Promise<{ main: Till; back: Till; mainCounter: string; backCounter: string }> {
  const main = await host({ registerPrefix: 'MR', star: true })
  const mainCounter = main.registerId!
  await main.as(() => grantClaim(main.db, main.deviceId, { registerId: mainCounter, take: false }))

  const back = await joiner({ registerPrefix: 'BC', star: true })
  await back.pairWith(main)
  await drain(back, main)
  const backCounter = await back.claimRegister()
  await drain(back, main)
  return { main, back, mainCounter, backCounter }
}

describe('a till changes counter only by asking the main', () => {
  it('is granted a free counter, and the main records it', async () => {
    const { main, back, backCounter } = await shop()

    const answer = await back.as(() =>
      changeCounter(back.db, { registerId: backCounter, take: false }, ask(back)))

    expect(answer).toEqual({ ok: true })
    expect(await claimedBy(main, backCounter)).toBe(back.deviceId)
    expect(await claimedBy(back, backCounter)).toBe(back.deviceId)
  })

  it('is refused the main\'s own counter, by name', async () => {
    const { main, back, mainCounter } = await shop()

    const answer = await back.as(() =>
      changeCounter(back.db, { registerId: mainCounter, take: true }, ask(back)))

    expect(answer).toMatchObject({ ok: false, code: 'STILL_HELD', stale: false })
    expect(await claimedBy(main, mainCounter)).toBe(main.deviceId)
    expect(await claimedBy(back, mainCounter)).toBe(main.deviceId)
  })

  it('changes nothing while the main is switched off', async () => {
    const { main, back, backCounter } = await shop()
    await back.as(() => changeCounter(back.db, { registerId: backCounter, take: false }, ask(back)))
    const otherCounter = main.registerId!
    await main.stop()

    const answer = await back.as(() =>
      changeCounter(back.db, { registerId: otherCounter, take: true }, ask(back)))

    expect(answer).toMatchObject({ ok: false, code: 'MAIN_UNREACHABLE' })
    // Still where it was, and still billing there.
    expect(await claimedBy(back, backCounter)).toBe(back.deviceId)
    expect(await back.as(() => resolveDeviceRegister(back.db, backCounter))).toBe(backCounter)
  })
})

describe('the main does not take a claim from a merge', () => {
  it('puts right a till that claimed the main\'s counter by itself', async () => {
    /* What an old build does, or a till that never asked: writes the claim in
       its own books and syncs. Without the rule it wins on revision. */
    const { main, back, mainCounter } = await shop()
    await back.as(() => claimRegister(back.db, { registerId: mainCounter, deviceId: back.deviceId }))

    await drain(back, main)
    await drain(back, main)

    expect(await claimedBy(main, mainCounter)).toBe(main.deviceId)
    // And the correction came back: the till no longer believes it.
    expect(await claimedBy(back, mainCounter)).toBe(main.deviceId)
    expect(await back.as(() => resolveDeviceRegister(back.db, mainCounter))).toBeNull()
  })

  it('keeps a take-over when the till it was taken from wakes up on day four', async () => {
    /* The back till goes quiet. Four days on the store room takes its counter,
       asking the main. Then the back till is switched on, still holding its own
       claim in its own books, renews it at startup the way every till does,
       and syncs. The main's answer stands, and the back till is told. */
    const { main, back, backCounter } = await shop()
    await back.as(() => changeCounter(back.db, { registerId: backCounter, take: false }, ask(back)))
    await drain(back, main)

    // Four days without a word from the back till.
    await main.db.execute(
      `UPDATE registers SET claimed_at = ? WHERE id = ?`,
      [new Date(Date.now() - FOUR_DAYS).toISOString(), backCounter],
    )

    const store = await joiner({
      registerPrefix: 'ST', deviceId: DEVICE_IDS.c, label: 'Store room', star: true,
    })
    await store.pairWith(main)
    await drain(store, main)
    const taken = await store.as(() =>
      changeCounter(store.db, { registerId: backCounter, take: true }, ask(store)))
    expect(taken).toEqual({ ok: true })
    expect(await claimedBy(main, backCounter)).toBe(store.deviceId)

    /* Day four: the back till wakes up on its old counter, and is switched on
       and off a few times before the network comes back -- every start renews
       the claim, and every renewal raises the row's revision, until the stale
       claim is the newer row by the merge's own reckoning. */
    expect(await claimedBy(back, backCounter)).toBe(back.deviceId)
    for (let start = 0; start < 5; start += 1) {
      await back.as(() => renewClaim(back.db, backCounter, back.deviceId))
    }
    await drain(back, main)
    await drain(back, main)

    expect(await claimedBy(main, backCounter)).toBe(store.deviceId)
    expect(await claimedBy(back, backCounter)).toBe(store.deviceId)
    expect(await back.as(() => resolveDeviceRegister(back.db, backCounter))).toBeNull()
  })
})
