import { describe, it, expect } from 'vitest'
import type { PeerHealth } from '@shopos/core'
import { completeness } from '../src/core/completeness'

/**
 * Whether a figure adding up the shop is adding up the shop.
 *
 * Kept apart from `syncStatus` because the two questions come apart in both
 * directions: every till talking still leaves this machine short of the last
 * forty-five seconds of the back counter, and a till that is switched off but
 * had nothing to say is costing this total nothing.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
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

describe('what a total is a total of', () => {
  it('says nothing at all in a one-till shop', () => {
    /* Not a case being dodged: one till has everything by definition, and a
       line on every screen saying so is what teaches people to stop reading
       the line. */
    expect(completeness([], NOW)).toBeNull()
  })

  it('says so when everything is in', () => {
    const said = completeness([peer()], NOW)
    expect(said?.complete).toBe(true)
    expect(said?.text).toBe('Everything from every till, as of 1 minute ago.')
  })

  it('says how much is missing, and whose', () => {
    const said = completeness([peer({ behind: 95 })], NOW)
    expect(said?.complete).toBe(false)
    expect(said?.text).toBe(
      'Short by 95 changes from Back Counter. This total does not include them.',
    )
  })

  it('adds up what is missing across tills', () => {
    const said = completeness(
      [peer({ behind: 40 }), peer({ deviceId: 'b', label: 'Store', behind: 55 })],
      NOW,
    )
    expect(said?.text).toContain('Short by 95 changes from 2 other tills')
  })

  it('says since when, for a till it cannot ask', () => {
    /* No number, because the number is on the machine that cannot be reached.
       Saying "short by 0" there would be the most confident kind of wrong. */
    const said = completeness(
      [peer({ lastError: 'ECONNREFUSED', lastAgreedAt: minutesAgo(90) })],
      NOW,
    )
    expect(said?.complete).toBe(false)
    expect(said?.text).toBe(
      'Back Counter has not been reached since 2 hours ago — out of touch. '
      + 'Anything rung up there since is not in this.',
    )
  })

  it('tells a refusal from a silence', () => {
    const said = completeness([peer({ lastError: 'SAME_REGISTER' })], NOW)
    expect(said?.text).toContain('refusing')
  })

  it('will not claim completeness it cannot check', () => {
    /* A peer on a build from before 044 sends no head. Null is not zero, and
       printing "everything from every till" off a peer that has never said is
       exactly the invention this line exists to stop. */
    const said = completeness([peer({ behind: null })], NOW)
    expect(said?.complete).toBe(false)
    expect(said?.text).toContain('cannot tell whether it has everything')
  })

  it('counts a known shortfall ahead of an unreachable till', () => {
    // A number beats a "since". Both are true; only one can be acted on.
    const said = completeness(
      [peer({ behind: 12 }), peer({ deviceId: 'b', label: 'Store', lastError: 'x' })],
      NOW,
    )
    expect(said?.text).toContain('Short by 12')
  })

  it('does not call a total incomplete over changes waiting to leave here', () => {
    /* `waiting` is what this till owes the others. It is already in this total
       — it was rung up here. */
    const said = completeness([peer({ waiting: 300 })], NOW)
    expect(said?.complete).toBe(true)
  })
})
