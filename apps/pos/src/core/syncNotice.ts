import type { LoopRound } from './syncLoop'

/**
 * What to say after somebody presses "catch up now".
 *
 * Its own module, and a pure function, because the thing it decides is easy to
 * get wrong and was wrong: three unrelated situations all produce an empty
 * report list, and the screen used to treat every one of them as agreement.
 *
 *   - a shop that has never paired a second till   → no peers, no reports
 *   - a round already in flight underneath this one → skipped, no reports
 *   - a round that reached every till and found nothing new → no reports
 *
 * Only the third of those is "Both tills agree", and the first is most shops.
 * Telling a shopkeeper who has not finished setting this up that their two
 * tills agree is worse than saying nothing: they stop setting it up.
 *
 * Extracted here so it can be tested without a window, a port or a second
 * machine — `syncLoop` itself reaches for the device file and the listening
 * socket, and neither of those is what was broken.
 */
export type SyncNotice =
  | { kind: 'error'; code: string }
  | { kind: 'notice'; text: string }
  | { kind: 'silent' }

export function syncNotice(round: LoopRound): SyncNotice {
  /* A refusal outranks everything else. It is the one outcome a person has to
     act on — a schema mismatch, a till on the same counter — and it does not
     get better by being left alone. */
  const refused = round.reports.find((r) => !r.ok)
  if (refused?.error) return { kind: 'error', code: refused.error }

  if (round.skipped) return { kind: 'notice', text: 'A catch-up is already running.' }

  if (round.peers === 0) {
    return { kind: 'notice', text: 'Nothing to sync with yet — pair a second till below.' }
  }

  /* `some(ok)` is the part that makes this a claim about a conversation rather
     than about an array. A round where every peer was unreachable and none of
     them said why would otherwise pass the `every(contested === 0)` test, which
     is true of nothing just as much as it is true of agreement. */
  if (round.reports.some((r) => r.ok) && round.reports.every((r) => r.contested === 0)) {
    return { kind: 'notice', text: 'Both tills agree.' }
  }

  /* Reached somebody and something is contested, or reached nobody and could
     not say why. The card is already showing the conflicts and the per-peer
     health, so a sentence here would only be in the way. */
  return { kind: 'silent' }
}
