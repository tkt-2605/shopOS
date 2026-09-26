import { describe, it, expect, afterEach } from 'vitest'
import { EXPECTED_SCHEMA_VERSION, MIN_PEER_SCHEMA_VERSION } from '@shopos/core'
import { host, joiner, stopAll, writeBill, countOf } from './bench.js'

/**
 * A till at schema N talking to one at N−1.
 *
 * The answer used to be refusal, always: `syncWith` compared the two versions
 * and stopped unless they were equal. That was right while the installed base
 * was zero and every till in a shop was updated by one person on one afternoon.
 * It stopped being right the first time it was not — an update rolls out, the
 * second till is switched off, it comes back on Monday, and the shop cannot
 * sync at all with nothing on either screen explaining why.
 *
 * Phase 2c classifies every migration as additive or breaking and replaces the
 * equality check with a floor on each side: the version after that build's last
 * breaking migration. The pair is allowed when each side is at or above the
 * other's floor.
 *
 * Both directions are checked here, because the danger is not symmetrical with
 * the numbers. The newer till writes columns the older has no place for; the
 * older sends rows missing columns the newer has made NOT NULL. One rule has to
 * cover both, and a test that only looked at the older side would pass on a
 * build that let the other half through.
 */

afterEach(stopAll)

/** The far side, answering `hello` as a till on a different build. */
async function pretending(
  back: Awaited<ReturnType<typeof joiner>>,
  over: { schemaVersion: number; minPeerSchema?: number },
) {
  return back.as(async () => {
    const { syncWith, httpTransport, pairedPeers } = await import('@shopos/core')
    const peer = (await pairedPeers(back.db))[0]!
    const real = httpTransport(peer)
    /* Forced rather than built from a real older tree: what is being pinned is
       the decision `syncWith` makes about two numbers, and a second migration
       set would test the migration runner instead. */
    const faked = {
      ...real,
      hello: async () => {
        const said = { ...(await real.hello()), ...over }
        /* An old build does not merely send a different floor -- it sends no
           field at all, and the real hello now carries one, so it has to be
           taken back off or the case being tested is not the case. */
        if (over.minPeerSchema === undefined) delete said.minPeerSchema
        return said
      },
    }
    return syncWith(back.db, faked, back.registerId)
  })
}

describe('a version difference that is only additive', () => {
  it('accepts a peer one migration behind', async () => {
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    const round = await pretending(back, {
      schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
      minPeerSchema: MIN_PEER_SCHEMA_VERSION,
    })

    expect(round.ok).toBe(true)
  })

  it('carries rows across the difference, rather than merely agreeing to', async () => {
    /* The handshake passing is not the point; the shop syncing is. A rule that
       said yes and then moved nothing would pass the assertion above. */
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    await front.as(() => writeBill(front.db, front.registerId!, { docNo: 'SKEW-1' }))

    const round = await pretending(back, {
      schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
      minPeerSchema: MIN_PEER_SCHEMA_VERSION,
    })

    expect(round.ok).toBe(true)
    expect(await countOf(back.db, 'bills')).toBeGreaterThan(0)
  })
})

describe('a version difference across a breaking migration', () => {
  it('is still refused, in the direction where they are too old', async () => {
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    const round = await pretending(back, {
      schemaVersion: MIN_PEER_SCHEMA_VERSION - 1,
      minPeerSchema: 1,
    })

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('theirs')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
  })

  it('is still refused in the direction where we are too old', async () => {
    /* A peer that has taken a breaking migration this build has never seen.
       The honest answer names *this* machine as the one behind, because that is
       where somebody has to go to fix it. */
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    const round = await pretending(back, {
      schemaVersion: EXPECTED_SCHEMA_VERSION + 5,
      minPeerSchema: EXPECTED_SCHEMA_VERSION + 1,
    })

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('mine')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
  })

  it('refuses a build from before the floor existed, whatever its version', async () => {
    /* An older build sends no `minPeerSchema` and its own code demands an exact
       match, so a round with it dies at its end whatever this side decides.
       Absent is read as "they demand equality", which puts the refusal here,
       with a reason, instead of halfway through. */
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    const round = await pretending(back, {
      schemaVersion: EXPECTED_SCHEMA_VERSION + 1,
    })

    expect(round.ok).toBe(false)
    if (!round.ok && round.code === 'SCHEMA_MISMATCH') {
      expect(round.behind).toBe('mine')
    } else {
      expect.fail(`expected SCHEMA_MISMATCH, got ${round.ok ? 'ok' : round.code}`)
    }
  })
})

describe('what the newer till can say about the older one', () => {
  it('reports the columns it had no place for', async () => {
    /* `ignoredColumns` is how a screen can tell a shopkeeper that the other
       till is behind. A round that silently dropped them would leave two tills
       holding different things with nothing anywhere saying so. */
    const front = await host()
    const back = await joiner()
    await back.pairWith(front)
    await back.sync(front)

    await front.as(() => writeBill(front.db, front.registerId!, { docNo: 'SKEW-2' }))

    const round = await pretending(back, {
      schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
      minPeerSchema: MIN_PEER_SCHEMA_VERSION,
    })

    expect(round.ok).toBe(true)
    if (round.ok) {
      /* Both tills here are on the same real schema, so nothing is actually
         dropped and the count is zero. What is being pinned is that the number
         is reported at all and is a number rather than undefined -- the case
         where it is non-zero needs two real trees, which is Layer 3's job. */
      expect(round.ignoredColumns).toBe(0)
      expect(round.ignoredTables).toBe(0)
    }
  })
})
