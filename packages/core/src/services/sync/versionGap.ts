import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'

/**
 * A till in this shop running a ShopOS too new for this one to talk to.
 *
 * The two refuse each other before a row moves, which is safe and was silent:
 * the refusal was one line on the Other tills screen, and it said to update
 * *both*. The till that is behind went on billing with stock, takings and
 * credit that no longer counted the other counter's work, and nothing on its
 * screens said so.
 *
 * The owner's rule (see `docs/specs/update-rollout.md`, "Mixed versions"):
 * the till that is behind keeps billing -- a counter never stops taking money,
 * and its bills merge in once it is updated, as after a day with the network
 * down -- but it says, on every screen, that it is out of sync until it is
 * updated, and it stops asking the newer till, because only an update on this
 * machine can change the answer.
 *
 * Learned from both ends, because either till may be the one that dials:
 * this till's own round finding the other's floor above it, or a newer till's
 * `hello` saying so when this till is the one being asked.
 */

export interface TillAhead {
  /** The newer till's device id. */
  peer: string
  /** Its schema version, and the lowest it can still talk to. */
  theirs: number
  theirFloor: number
  /** This build's schema version when it was found. After an update it is a
   *  different build, and a record from before says nothing about it. */
  mine: number
}

const listeners = new Set<(ahead: TillAhead) => void>()

/** Whether a till whose lowest partner is `theirFloor` is out of this build's reach. */
export function isAheadOfUs(theirFloor: number): boolean {
  return EXPECTED_SCHEMA_VERSION < theirFloor
}

/** Says so to whoever is listening. Called by the round and by `hello`. */
export function noteTillAhead(peer: string, theirs: number, theirFloor: number): void {
  const ahead: TillAhead = { peer, theirs, theirFloor, mine: EXPECTED_SCHEMA_VERSION }
  for (const fn of listeners) fn(ahead)
}

/** Told each time a till in this shop turns out to be ahead of this one. */
export function onTillAhead(fn: (ahead: TillAhead) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
