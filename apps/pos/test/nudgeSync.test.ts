import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SqlDriver } from '@shopos/core'

/**
 * When a write turns into a round.
 *
 * The loop every forty-five seconds is the floor. What decides whether the far
 * counter sees a bill in half a second or in three quarters of a minute is this
 * — and the two rules that are easy to get wrong are the burst (one action is
 * one round, not one row one round) and the merge (the rows a round pulls are
 * the other till's news, not ours, and must not set off another round each).
 *
 * `pairedPeers` stands in for "a round ran": it is the first thing `runOnce`
 * asks for, and asking for nothing back makes the round finish immediately.
 */

const pairedPeers = vi.fn(async () => [] as unknown[])
const syncUntilDone = vi.fn(async () => ({
  ok: true, received: 0, sent: 0, contested: [] as unknown[],
}))

class FakeHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The other till refused: ${code}`)
    this.name = 'SyncHttpError'
  }
}

const recordAttempt = vi.fn(async () => undefined)
const rememberAddress = vi.fn(async () => undefined)

vi.mock('@shopos/core', () => ({
  pairedPeers: (...args: unknown[]) => pairedPeers(...(args as [])),
  syncUntilDone: (...args: unknown[]) => syncUntilDone(...(args as [])),
  recordAttempt: (...args: unknown[]) => recordAttempt(...(args as [])),
  rememberAddress: (...args: unknown[]) => rememberAddress(...(args as [])),
  SyncHttpError: FakeHttpError,
  httpTransport: vi.fn(),
  pruneAcknowledged: vi.fn(async () => undefined),
  serveAs: vi.fn(),
  nextBackoff: (n: number) => (n === 0 ? 1000 : n * 2),
}))
vi.mock('../src/core/syncHost', () => ({
  servingOn: async () => null,
  lookAround: async () => [],
}))
vi.mock('../src/core/device', () => ({ chosenRegister: () => 'a-counter' }))
vi.mock('../src/core/outOfDate', () => ({ caughtUpWith: async () => undefined }))
vi.mock('../src/core/restoreHold', () => ({ caughtUpAfterRestore: async () => undefined }))
vi.mock('../src/core/log', () => ({ logEvent: vi.fn(), describe: String }))
vi.mock('../src/core/syncFetch', () => ({ syncFetch: vi.fn() }))

const db = {} as SqlDriver

let startSyncLoop: typeof import('../src/core/syncLoop').startSyncLoop
let stopSyncLoop: typeof import('../src/core/syncLoop').stopSyncLoop
let nudgeSync: typeof import('../src/core/syncLoop').nudgeSync

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  pairedPeers.mockClear()
  pairedPeers.mockImplementation(async () => [])
  syncUntilDone.mockClear()
  recordAttempt.mockClear()
  rememberAddress.mockClear()
  syncUntilDone.mockImplementation(async () => ({ ok: true, received: 0, sent: 0, contested: [] }))
  const loop = await import('../src/core/syncLoop')
  startSyncLoop = loop.startSyncLoop
  stopSyncLoop = loop.stopSyncLoop
  nudgeSync = loop.nudgeSync
})

afterEach(() => {
  stopSyncLoop()
  vi.useRealTimers()
})

/** The immediate round `startSyncLoop` runs, out of the way. */
async function started() {
  startSyncLoop(db)
  await vi.advanceTimersByTimeAsync(1)
  pairedPeers.mockClear()
}

describe('syncing on every change', () => {
  it('does nothing in a shop that has not paired', async () => {
    /* Most shops. The loop is not running, so there is nobody to tell, and a
       round per sale against no peers is work for nothing all day. */
    nudgeSync(db)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pairedPeers).not.toHaveBeenCalled()
  })

  it('catches up shortly after a write rather than at the next tick', async () => {
    await started()

    nudgeSync(db)
    expect(pairedPeers).not.toHaveBeenCalled() // not synchronously, either

    await vi.advanceTimersByTimeAsync(500)
    expect(pairedPeers).toHaveBeenCalledTimes(1)
  })

  it('turns a burst of writes into one round', async () => {
    // A stock count is hundreds of rows. It is still one thing that happened.
    await started()

    for (let i = 0; i < 200; i += 1) nudgeSync(db)
    await vi.advanceTimersByTimeAsync(500)

    expect(pairedPeers).toHaveBeenCalledTimes(1)
  })

  it('still runs on its own without anybody writing anything', async () => {
    /* The floor. It is what notices a till that has come back, and what pulls a
       counter that is not selling anything right now -- neither of which is a
       write on this machine. */
    await started()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(pairedPeers).toHaveBeenCalledTimes(1)
  })

  it('does not start a second round while one is running', async () => {
    /* Every row a merge applies is a write through the same driver. One round
       per applied row would be a round per row of somebody else's news. */
    await started()

    // Set after the loop's own opening round, so it is the nudge's round that
    // hangs rather than that one.
    let release: (() => void) | null = null
    pairedPeers.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return []
    })

    nudgeSync(db)
    await vi.advanceTimersByTimeAsync(500)
    expect(pairedPeers).toHaveBeenCalledTimes(1)

    // The merge, writing away inside the round that is still in flight.
    for (let i = 0; i < 50; i += 1) nudgeSync(db)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pairedPeers).toHaveBeenCalledTimes(1)

    release?.()
    await vi.advanceTimersByTimeAsync(1_000)

    /* Not fifty rounds, and here not even one: that round carried nothing in
       either direction, so there is nothing for a follow-up to carry either. */
    expect(pairedPeers).toHaveBeenCalledTimes(1)
  })

  it('goes round once more after a round that actually carried something', async () => {
    /* The reason the rule is "moved anything" rather than "never". A round that
       pulled rows wrote them, and those writes arrive here as nudges — but so
       does a sale rung up while that round was in flight, and from here the two
       are indistinguishable. One more round settles either. */
    await started()
    pairedPeers.mockImplementation(async () => [
      { deviceId: 'the-other-till', baseUrl: 'http://x', secret: 's' },
    ])
    // Applying three rows is three writes through the driver, which is three
    // nudges arriving from inside the round.
    syncUntilDone.mockImplementation(async () => {
      nudgeSync(db); nudgeSync(db); nudgeSync(db)
      return { ok: true, received: 3, sent: 0, contested: [] }
    })

    nudgeSync(db)
    await vi.advanceTimersByTimeAsync(500)
    expect(pairedPeers).toHaveBeenCalledTimes(1)

    // One follow-up is owed, however many of those writes there were.
    await vi.advanceTimersByTimeAsync(500)
    expect(pairedPeers).toHaveBeenCalledTimes(2)
  })

  it('stops going round once there is nothing left to carry', async () => {
    /* The termination condition, and the whole reason `moved` exists: every
       round writes something — cursors, attempts, applied rows — so re-arming
       on any write at all would be a round every four hundred milliseconds
       until the shop closed. */
    await started()
    pairedPeers.mockImplementation(async () => [
      { deviceId: 'the-other-till', baseUrl: 'http://x', secret: 's' },
    ])
    syncUntilDone.mockImplementationOnce(async () => {
      nudgeSync(db)
      return { ok: true, received: 3, sent: 0, contested: [] }
    })

    nudgeSync(db)
    await vi.advanceTimersByTimeAsync(2_000)
    const settled = pairedPeers.mock.calls.length

    // A long quiet stretch, short of the 45-second floor.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pairedPeers).toHaveBeenCalledTimes(settled)
  })

  it('tells every screen watching, not just the last one to mount', async () => {
    /* This used to be one callback in one slot, so a second screen silently
       took the first one's place: the Settings card and a bill list could not
       both follow the loop, and which one stopped updating depended on the
       order they happened to mount in. */
    const loop = await import('../src/core/syncLoop')
    const card: unknown[] = []
    const list: unknown[] = []
    const offCard = loop.onSyncRound((r) => card.push(r))
    const offList = loop.onSyncRound((r) => list.push(r))

    pairedPeers.mockImplementation(async () => [
      { deviceId: 'the-other-till', baseUrl: 'http://x', secret: 's' },
    ])
    syncUntilDone.mockImplementation(async () => ({
      ok: true, received: 1, sent: 0, contested: [],
    }))

    await started()
    await vi.advanceTimersByTimeAsync(45_000)

    // However many rounds there were, both heard all of them.
    expect(card.length).toBeGreaterThan(0)
    expect(list).toEqual(card)

    offCard()
    offList()
  })

  describe('a till that answered and said no', () => {
    /* `syncWith` returns `{ok:false}` for the refusals it decides itself, but
       one the far side decides — it does not know us — arrives as a thrown
       `SyncHttpError`. That used to land in the catch meant for a till that
       could not be reached, which produced an hour of backoff against a machine
       answering every time, and a screen saying "Cannot reach" about it. */

    const refusing = () => {
      pairedPeers.mockImplementation(async () => [
        { deviceId: 'the-other-till', baseUrl: 'http://192.168.1.2:7801', secret: 's' },
      ])
      syncUntilDone.mockImplementation(async () => {
        throw new FakeHttpError(401, 'UNKNOWN_PEER')
      })
    }

    it('records the code, not the sentence wrapped around it', async () => {
      // Storing the message is what made a screen say "The other till refused:
      // The other till refused: UNKNOWN_PEER".
      refusing()
      await started()
      await vi.advanceTimersByTimeAsync(1)

      expect(recordAttempt).toHaveBeenCalledWith(db, 'the-other-till', 'UNKNOWN_PEER')
    })

    it('does not back off from it', async () => {
      /* A refusal does not get better by being left alone, and it is not a
         network problem. `syncBackoff.ts` is where that is written down. */
      refusing()
      await started()

      await vi.advanceTimersByTimeAsync(45_000)
      const afterOne = pairedPeers.mock.calls.length
      await vi.advanceTimersByTimeAsync(45_000)

      // Asked again on the very next tick rather than in an hour.
      expect(pairedPeers.mock.calls.length).toBeGreaterThan(afterOne)
    })

    it('does not go looking for it on the network', async () => {
      // It answered. Where it is was never the question.
      refusing()
      await started()
      await vi.advanceTimersByTimeAsync(1)

      expect(rememberAddress).not.toHaveBeenCalled()
    })
  })

  it('looks for a till that did not answer where it used to be', async () => {
    /* Both sides holding an address that was true yesterday is a shop that
       backs off from itself for ever: a peer's address is otherwise only
       re-learned from a request that peer makes, and it cannot make one. */
    const loop = await import('../src/core/syncLoop')
    const host = await import('../src/core/syncHost')
    vi.spyOn(host, 'lookAround').mockResolvedValue([
      { address: '192.168.1.2:57380', device: 'the-other-till', label: 'Back', shop: null, shopId: null, port: 57380 },
    ])

    pairedPeers.mockImplementation(async () => [
      { deviceId: 'the-other-till', baseUrl: 'http://192.168.1.2:7801', secret: 's' },
    ])
    syncUntilDone.mockImplementation(async () => { throw new Error('connection refused') })

    loop.startSyncLoop(db)
    await vi.advanceTimersByTimeAsync(10)

    expect(rememberAddress).toHaveBeenCalledWith(db, 'the-other-till', 'http://192.168.1.2:57380')
  })

  it('stops nudging once the loop stops', async () => {
    await started()
    nudgeSync(db)
    stopSyncLoop()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(pairedPeers).not.toHaveBeenCalled()
  })
})
