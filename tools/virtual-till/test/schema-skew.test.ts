import { describe, it, expect, afterEach } from 'vitest'
import { EXPECTED_SCHEMA_VERSION } from '@shopos/core'
import { host, joiner, stopAll } from './bench.js'

/**
 * A till at schema N talking to one at N−1.
 *
 * Today the answer is always refusal: `syncWith` compares the two versions and
 * stops unless they are equal. That is the right answer while the installed
 * base is zero and every till is updated by the same person on the same day.
 * It stops being the right answer the moment an update rolls out to a shop
 * whose second till is switched off — the first till updates, the second comes
 * back on Monday, and the shop cannot sync until somebody notices.
 *
 * Phase 2c classifies every migration as additive or breaking and replaces the
 * equality check with `peer.schema >= mine.minPeer && mine.schema >= peer.minPeer`.
 * The two assertions that matter then are in this file, and the one that is
 * true *now* is asserted now — so that the day the rule changes, this file is
 * the thing that says what changed.
 */

afterEach(stopAll)

describe('what a version difference does today', () => {
  it('refuses any difference at all, in both directions', async () => {
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    // Forced rather than built from a real older tree: what is being pinned is
    // the decision `syncWith` makes about two numbers, and a second migration
    // set would test the migration runner instead.
    const round = await back.as(async () => {
      const { syncWith, httpTransport, pairedPeers } = await import('@shopos/core')
      const peer = (await pairedPeers(back.db))[0]!
      const real = httpTransport(peer)
      const older = {
        ...real,
        hello: async () => ({
          ...(await real.hello()),
          schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
        }),
      }
      return syncWith(back.db, older, back.registerId)
    })

    expect(round.ok).toBe(false)
    if (!round.ok) expect(round.code).toBe('SCHEMA_MISMATCH')
  })
})

/**
 * Lands with Phase 2c, in the same commit as the handshake change.
 *
 * Left here rather than written later so that the commit which relaxes the rule
 * has a test waiting for it, and so the relaxation cannot be merged while
 * quietly accepting a *breaking* difference too.
 */
describe.skip('what a version difference will do after Phase 2c', () => {
  it('accepts a peer one additive migration behind', async () => {
    expect.fail('Phase 2c: MIN_PEER_SCHEMA_VERSION handshake')
  })

  it('still refuses a peer across a breaking migration', async () => {
    expect.fail('Phase 2c: MIN_PEER_SCHEMA_VERSION handshake')
  })

  it('reports ignoredColumns so the newer till can say the other is behind', async () => {
    expect.fail('Phase 2c: applyBatch column filtering')
  })
})
