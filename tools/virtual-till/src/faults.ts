import type { ChangeBatch, PeerHello, SyncTransport } from '@shopos/core'

/**
 * Making the network behave the way a shop's network behaves.
 *
 * Wrapped around a transport rather than stubbed in place of one: what is being
 * tested is the till's reaction, so every request that is not deliberately
 * broken must still go over the real socket and through the real
 * `handleSyncRequest`. A stub that returns canned answers tests the stub.
 */

export interface Faults {
  /**
   * Forward the request, wait for the far side to answer, then throw.
   *
   * This is the one that matters, and it is not the same as "the request
   * failed". The far side has **committed** — the bill is in its database, its
   * cursor has moved — and the near side has no idea, so it will retry. Every
   * idempotency claim in the protocol is a claim about exactly this moment. A
   * test that merely drops the request proves nothing, because nothing
   * happened on either side.
   *
   * The number is how many times to do it; after that the wrapper is honest.
   */
  dropReplyAfterCommit?: number
  /** Milliseconds before each request is let through. */
  delayMs?: number
  /** While this answers true, nothing reaches the far side at all. */
  partitioned?: () => boolean
}

export class Partitioned extends Error {
  override readonly name = 'Partitioned'
  constructor() { super('the network is down') }
}

export class ReplyLost extends Error {
  override readonly name = 'ReplyLost'
  constructor() { super('the far side answered and the reply did not arrive') }
}

export function withFaults(inner: SyncTransport, faults: Faults): SyncTransport {
  let dropsLeft = faults.dropReplyAfterCommit ?? 0

  async function gate(): Promise<void> {
    if (faults.partitioned?.()) throw new Partitioned()
    if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs))
  }

  return {
    /* `hello` and `fetch` are reads. Losing their replies costs a round trip and
       nothing else, so only the write is worth corrupting — keeping the fault
       on `offer` is what makes a failing test point at the idempotency bug
       rather than at retry plumbing. */
    async hello(): Promise<PeerHello> {
      await gate()
      return inner.hello()
    },

    async fetch(since: number, limit: number): Promise<ChangeBatch> {
      await gate()
      return inner.fetch(since, limit)
    },

    async offer(batch: ChangeBatch): Promise<{ upTo: number }> {
      await gate()
      const answer = await inner.offer(batch)
      if (dropsLeft > 0) {
        dropsLeft -= 1
        throw new ReplyLost()
      }
      return answer
    },
  }
}
