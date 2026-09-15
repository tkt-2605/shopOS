/**
 * How long to leave a till alone after it could not be reached.
 *
 * Extracted from `syncLoop.ts` so that it can be asserted without a Tauri app
 * around it. The loop still owns *when* to sync; this owns only the arithmetic,
 * which is the part with a rule in it.
 *
 * ## Why an unreachable till is not a refused one
 *
 * The two look the same on a screen and must not be treated the same. A refusal
 * — `SCHEMA_MISMATCH`, `SAME_REGISTER` — is an answer: the other till is up,
 * it understood, and it said no. Backing off from an answer would be wrong,
 * because nothing about waiting fixes it; somebody has to update a till or
 * change a counter, and until they do, saying so every round is the correct
 * amount of noise.
 *
 * Unreachable is not an answer. The till is off, asleep, unplugged, or on the
 * other side of a switch somebody kicked. Retrying every ninety seconds all day
 * achieves nothing and fills the conflict log, so the gap grows — but it is
 * capped, because the till *will* come back and the shop should not then wait
 * an hour for its bills.
 */

/** First wait after a till stops answering. */
export const BACKOFF_START_MS = 60_000

/** However long it has been away, try at least this often. */
export const BACKOFF_MAX_MS = 10 * 60_000

/**
 * The next wait, given the last one. Zero — meaning the peer was answering —
 * starts the sequence.
 */
export function nextBackoff(previousMs: number): number {
  if (previousMs <= 0) return BACKOFF_START_MS
  return Math.min(previousMs * 2, BACKOFF_MAX_MS)
}
