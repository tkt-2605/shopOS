import { describe, it, expect } from 'vitest'
import type { PeerHealth } from '@shopos/core'
import { syncStatus } from '../src/core/syncStatus'

/**
 * One question — are the tills up to date — and one sentence answering it.
 *
 * Tested without a window or a port, which is the point of the function being
 * pure: every case below is a shop state that is awkward to arrange on two real
 * machines and trivial to state here.
 */

const NOW = Date.parse('2026-09-17T18:00:00.000Z')
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString()

function peer(over: Partial<PeerHealth> = {}): PeerHealth {
  return {
    deviceId: '1111aaaa-2222-4333-8444-555566667777',
    label: 'Back Counter',
    lastAgreedAt: minutesAgo(1),
    lastTriedAt: minutesAgo(1),
    lastError: null,
    waiting: 0,
    behind: 0,
    reach: 'lan',
    clockSkewMs: 0,
    ...over,
  }
}

describe('the one-line sync status', () => {
  it('says a single-till shop is a single-till shop', () => {
    // Most shops. It is not a problem and must not read like one.
    const said = syncStatus([], NOW)
    expect(said.tone).toBe('plain')
    expect(said.text).toBe('This is the only till in this shop.')
  })

  it('says both tills have everything, and when that was true', () => {
    const said = syncStatus([peer({ lastAgreedAt: minutesAgo(2) })], NOW)
    expect(said.tone).toBe('ok')
    expect(said.text).toBe('Both tills have everything. Checked 2 minutes ago.')
  })

  it('counts from when they last agreed, not from when this one last tried', () => {
    /* A till that tried a second ago and agreed an hour ago is not up to date.
       Reading `lastTriedAt` here would be true and misleading. */
    const said = syncStatus(
      [peer({ lastAgreedAt: minutesAgo(60), lastTriedAt: minutesAgo(0) })],
      NOW,
    )
    expect(said.text).toBe('Both tills have everything. Checked 1 hour ago.')
  })

  it('names what this till still owes, in the direction it is owed', () => {
    /* `waiting` is what this machine has not passed on. Saying the other till
       holds bills this one has not seen would send somebody to the wrong
       machine. */
    const said = syncStatus([peer({ waiting: 95 })], NOW)
    expect(said.text).toBe('95 changes still to pass on to Back Counter.')
  })

  it('says a till refused rather than calling it unreachable', () => {
    /* The screen said "Cannot reach the back counter. Last agreed 1 hour ago"
       about a till that was answering every request and refusing every one —
       which sends somebody to look at a network that is working. A refusal is
       an answer, and it is the one they can actually fix. */
    const said = syncStatus([peer({ lastError: 'UNKNOWN_PEER' })], NOW)
    expect(said.tone).toBe('warn')
    expect(said.text).toContain('Back Counter refused.')
    expect(said.text).toContain('Pair them again.')
    expect(said.text).not.toContain('Cannot reach')
  })

  it('tells a refusal from a socket error by its shape', () => {
    // Both live in `last_error`. Anything the protocol refuses with is shouted
    // in snake case; anything a socket says is a sentence.
    const socket = syncStatus(
      [peer({ lastError: 'No connection could be made because the target machine actively refused it' })],
      NOW,
    )
    expect(socket.text).toContain('Cannot reach')
  })

  it('leads with a till it cannot reach, and says since when', () => {
    const said = syncStatus(
      [peer({ lastError: 'ECONNREFUSED', lastAgreedAt: minutesAgo(110) })],
      NOW,
    )
    expect(said.tone).toBe('warn')
    expect(said.text).toBe('Cannot reach Back Counter. Last agreed 2 hours ago.')
  })

  it('adds what is stuck behind an unreachable till', () => {
    const said = syncStatus(
      [peer({ lastError: 'ECONNREFUSED', lastAgreedAt: minutesAgo(5), waiting: 95 })],
      NOW,
    )
    expect(said.text).toBe(
      'Cannot reach Back Counter. Last agreed 5 minutes ago. 95 changes still to reach it.',
    )
  })

  it('does not claim a time for a till that has never agreed', () => {
    const said = syncStatus([peer({ lastAgreedAt: null })], NOW)
    expect(said.text).toBe('Both tills have everything.')
  })

  it('says so plainly when an unreachable till has never agreed at all', () => {
    // A pairing that settled and then never managed a round: "last agreed
    // never" would be a sentence about nothing.
    const said = syncStatus([peer({ lastError: 'ECONNREFUSED', lastAgreedAt: null })], NOW)
    expect(said.text).toBe('Cannot reach Back Counter. It has never agreed with this one.')
  })

  it('falls back to a short device id when a till has no name', () => {
    const said = syncStatus([peer({ label: null, waiting: 2 })], NOW)
    expect(said.text).toBe('2 changes still to pass on to till 1111aaaa.')
  })

  describe('more than two tills', () => {
    it('speaks about all of them at once', () => {
      const said = syncStatus(
        [peer({ lastAgreedAt: minutesAgo(3) }), peer({ deviceId: 'b', label: 'Front', lastAgreedAt: minutesAgo(9) })],
        NOW,
      )
      // The oldest of them, because the claim covers all of them.
      expect(said.text).toBe('Every till has everything. Checked 9 minutes ago.')
    })

    it('counts the silent ones and dates the worst', () => {
      const said = syncStatus(
        [
          peer({ label: 'Front', lastError: 'x', lastAgreedAt: minutesAgo(5) }),
          peer({ deviceId: 'b', label: 'Back', lastError: 'x', lastAgreedAt: minutesAgo(200) }),
        ],
        NOW,
      )
      expect(said.text).toBe('Cannot reach 2 tills. Last agreed 3 hours ago.')
    })

    it('adds up what is owed across every till it cannot reach', () => {
      const said = syncStatus(
        [
          peer({ label: 'Front', lastError: 'x', lastAgreedAt: minutesAgo(5), waiting: 12 }),
          peer({ deviceId: 'b', label: 'Back', lastError: 'x', lastAgreedAt: minutesAgo(6), waiting: 30 }),
        ],
        NOW,
      )
      expect(said.text).toContain('42 changes still to reach it.')
    })

    it('one silent till outranks two healthy ones', () => {
      const said = syncStatus(
        [peer(), peer({ deviceId: 'b', label: 'Front' }), peer({ deviceId: 'c', label: 'Store', lastError: 'x' })],
        NOW,
      )
      expect(said.tone).toBe('warn')
      expect(said.text).toContain('Cannot reach Store.')
    })
  })
})

/**
 * The other direction, which nothing could say before migration 044.
 *
 * `waiting` is what this till owes; `behind` is what it is owed. Printing one
 * when the other is true sends somebody to the wrong machine — and printing
 * neither is how a report came to be short by the back counter's bills while
 * the screen said every till had everything.
 */
describe('what this till is short of', () => {
  it('says which till has it and how much', () => {
    const said = syncStatus([peer({ behind: 95 })], NOW)
    expect(said.tone).toBe('warn')
    expect(said.text).toBe('Back Counter has 95 changes this till has not seen.')
  })

  it('warns, because a total short by somebody else’s bills is wrong', () => {
    /* Changes waiting to leave here are on their way and read as plain. Changes
       that have not arrived are already showing up as a wrong figure on the tax
       tab, which is filed. */
    expect(syncStatus([peer({ waiting: 95 })], NOW).tone).toBe('plain')
    expect(syncStatus([peer({ behind: 95 })], NOW).tone).toBe('warn')
  })

  it('adds up across tills and names how many', () => {
    const said = syncStatus(
      [peer({ behind: 40 }), peer({ deviceId: 'b', label: 'Store', behind: 55 })],
      NOW,
    )
    expect(said.text).toBe('2 tills have 95 changes between them this till has not seen.')
  })

  it('says nothing about a till that has never said', () => {
    /* Null is not zero. A peer on a build from before 044 sends no head, and
       claiming the two are level would be an invention. */
    const said = syncStatus([peer({ behind: null })], NOW)
    expect(said.tone).toBe('ok')
    expect(said.text).toContain('everything')
  })

  it('is outranked by a till nobody can reach', () => {
    // Being unreachable explains being behind. Saying both would be two
    // sentences about one fault.
    const said = syncStatus([peer({ behind: 95, lastError: 'ECONNREFUSED' })], NOW)
    expect(said.text).toContain('Cannot reach')
  })

  it('is outranked by changes still to leave here', () => {
    /* Deliberate: what this machine has not passed on is the thing a person
       standing at it can do something about, by leaving it switched on. */
    const said = syncStatus([peer({ behind: 95, waiting: 3 })], NOW)
    expect(said.text).toBe('3 changes still to pass on to Back Counter.')
  })
})

describe('two clocks drifting apart', () => {
  it('says so before the tills stop talking', () => {
    /* The five-minute wall arrives all at once and reads as `STALE`. Half of it
       is a warning somebody can act on in a minute. */
    const said = syncStatus([peer({ clockSkewMs: 3 * 60_000 })], NOW)
    expect(said.tone).toBe('warn')
    expect(said.text).toContain('disagree about the time by about 3 minutes')
  })

  it('does not care which way round it is', () => {
    expect(syncStatus([peer({ clockSkewMs: -3 * 60_000 })], NOW).text)
      .toContain('3 minutes')
  })

  it('stays quiet about a drift nobody can do anything with', () => {
    const said = syncStatus([peer({ clockSkewMs: 40_000 })], NOW)
    expect(said.tone).toBe('ok')
  })

  it('outranks changes waiting to be sent', () => {
    /* Deliberate, and it is the one ranking here that is not about urgency: a
       till that is behind will catch up, and a till with the wrong clock is
       losing edits while it does. */
    const said = syncStatus([peer({ clockSkewMs: 3 * 60_000, waiting: 20 })], NOW)
    expect(said.text).toContain('disagree about the time')
  })

  it('is outranked by a till that cannot be reached at all', () => {
    const said = syncStatus([peer({ clockSkewMs: 3 * 60_000, lastError: 'ECONNREFUSED' })], NOW)
    expect(said.text).toContain('Cannot reach')
  })
})
