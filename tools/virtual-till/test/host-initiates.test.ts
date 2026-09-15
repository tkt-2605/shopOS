import { describe, it, expect, afterEach } from 'vitest'
import { pairedPeers } from '@shopos/core'
import { host, joiner, stopAll, writeBill, billIds } from './bench.js'

/**
 * The host till starts the sync.
 *
 * This is the scenario the package exists for. The bug it catches survived 1047
 * tests, and it survived them for one reason: **every test let the joiner
 * initiate**. That is the shape the app's screens make easy — the second till
 * is the one a person sets up, so the second till is the one the tests drove —
 * and so the host's outbound path was never exercised even once.
 *
 * What that meant in a shop: the front counter could receive, and could not
 * fetch. The back counter's bills arrived only when somebody stood at the back
 * counter and pressed sync. The front counter's Settings screen meanwhile said
 * the tills agreed, because it had never contacted anything and had nothing to
 * disagree with.
 *
 * Symmetry is asserted here, never assumed. Both directions, in one file, so
 * that deleting one of them is a visible deletion.
 */

afterEach(stopAll)

describe('a sync the host starts', () => {
  it('fetches a bill the joiner wrote, without the joiner doing anything', async () => {
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)
    // The joiner takes the shop first — it has nothing until it does.
    await back.sync(front)
    await back.claimRegister()

    const billId = await back.as(() =>
      writeBill(back.db, back.registerId!, { docNo: 'BBC/2627/00001' }))

    // Nobody touches the back counter again. The front counter goes and gets it.
    const round = await front.sync(back)

    expect(round.ok).toBe(true)
    expect(await billIds(front.db)).toContain(billId)
  })

  it('records the peer on both sides when they pair', async () => {
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)

    // The joiner's row is the one the old tests checked. The host's row is the
    // one that was missing, and without it the host has no peer to initiate to.
    const onJoiner = await back.as(() => pairedPeers(back.db))
    const onHost = await front.as(() => pairedPeers(front.db))

    expect(onJoiner.map((p) => p.deviceId)).toContain(front.deviceId)
    expect(onHost.map((p) => p.deviceId)).toContain(back.deviceId)
  })

  it('carries a change the host wrote to the joiner, host-initiated', async () => {
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)
    await back.sync(front)
    await back.claimRegister()

    const billId = await front.as(() =>
      writeBill(front.db, front.registerId!, { docNo: 'BFR/2627/00009' }))

    // Push, not pull, and still started by the host.
    const round = await front.sync(back)
    expect(round.ok).toBe(true)

    expect(await billIds(back.db)).toContain(billId)
  })
})

describe('what the host says when there is nothing to carry', () => {
  it('reports a round that contacted the peer and found nothing', async () => {
    const front = await host()
    const back = await joiner()

    await back.pairWith(front)
    await back.sync(front)

    // The joiner writes nothing at all.
    const round = await front.sync(back)

    expect(round.ok).toBe(true)
    if (round.ok) expect(round.received).toBe(0)
  })

  it('distinguishes "no peers" from "a peer with nothing new"', async () => {
    const front = await host()

    // Unpaired: there is genuinely nothing to sync with, and `pairedPeers` is
    // the only thing that may be read as saying so. The bug being guarded
    // against is a screen that shows the same reassuring line in both cases —
    // one of which means the tills agree and the other of which means the till
    // has never spoken to anything.
    expect(await front.as(() => pairedPeers(front.db))).toHaveLength(0)

    const back = await joiner()
    await back.pairWith(front)

    expect(await front.as(() => pairedPeers(front.db))).toHaveLength(1)
  })
})
