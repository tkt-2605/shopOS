import { describe, it, expect } from 'vitest'
import { syncNotice } from '../src/core/syncNotice'
import type { LoopReport, LoopRound } from '../src/core/syncLoop'

/**
 * What the till says after somebody presses "catch up now".
 *
 * The bug this covers: `runOnce` returns an empty report list for three
 * situations that have nothing to do with each other, and the card treated all
 * of them as agreement. A shop with one till — most shops — pressed the button
 * and was told "Both tills agree", which is a sentence about a second till it
 * does not have. Somebody halfway through setting up their back counter would
 * have read that as done.
 */

const round = (over: Partial<LoopRound> = {}): LoopRound => ({
  peers: 0, skipped: false, reports: [], ...over,
})

const report = (over: Partial<LoopReport> = {}): LoopReport => ({
  peer: 'back-counter', ok: true, received: 0, sent: 0, contested: 0, ...over,
})

describe('after a catch-up', () => {
  it('does not claim two tills agree when there is only one', () => {
    expect(syncNotice(round({ peers: 0 })))
      .toEqual({ kind: 'notice', text: 'Nothing to sync with yet — pair a second till below.' })
  })

  it('says so when a round is already running underneath', () => {
    /* The loop runs every 45 seconds whether or not this screen is open, so
       pressing the button during one is ordinary, not an error. It is also not
       agreement: this call did not ask anybody anything. */
    expect(syncNotice(round({ skipped: true })))
      .toEqual({ kind: 'notice', text: 'A catch-up is already running.' })
  })

  it('claims agreement only after a till actually answered', () => {
    expect(syncNotice(round({ peers: 1, reports: [report({ received: 3, sent: 1 })] })))
      .toEqual({ kind: 'notice', text: 'Both tills agree.' })
  })

  it('stays quiet when the peer could not be reached and did not say why', () => {
    /* `every(contested === 0)` is true of an unreachable till exactly as it is
       true of an agreeing one, which is how the old version came to announce
       agreement with a counter that was switched off. The per-peer health on
       the card says when it was last reached; a cheerful sentence over the top
       of it would be the wrong half of the story. */
    expect(syncNotice(round({ peers: 1, reports: [report({ ok: false })] })))
      .toEqual({ kind: 'silent' })
  })

  it('shows a refusal ahead of anything else', () => {
    const reports = [report({ ok: false, error: 'SCHEMA_MISMATCH' }), report()]

    /* A schema mismatch does not get better by being left alone — somebody has
       to update a till — so it outranks the good news from the other peer. */
    expect(syncNotice(round({ peers: 2, reports })))
      .toEqual({ kind: 'error', code: 'SCHEMA_MISMATCH' })
  })

  it('says nothing when a real disagreement was found', () => {
    /* The card lists the contested rows itself, underneath. */
    expect(syncNotice(round({ peers: 1, reports: [report({ contested: 2 })] })))
      .toEqual({ kind: 'silent' })
  })
})
