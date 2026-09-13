/**
 * How long ago the person at the keyboard last proved they are still themselves.
 *
 * Settings decides what every bill prints, which features the counter offers and
 * what happens when stock runs short; the permissions screen decides who may do
 * any of it. Being signed in is not a strong enough answer for those two, because
 * a till that is signed in and unattended is the ordinary state of a counter —
 * that is the whole point of a till.
 *
 * So those two screens ask for the password again, and then stay open for ten
 * minutes. Not per change: an owner setting up a shop would type their password
 * forty times and then turn the whole thing off, which is a worse outcome than
 * no gate at all.
 *
 * The unlock lives in memory and nowhere else. Written to disk it would survive
 * a restart, and an unlock that survives a restart is a back door with a timer
 * on it. A module-level value rather than context for the same reason
 * `modalStack.ts` is one — `App.tsx` reads it outside any provider of its own.
 */

export const UNLOCK_MINUTES = 10

/** Epoch milliseconds after which the gate closes again. */
let until = 0
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

export function isUnlocked(now: number = Date.now()): boolean {
  return until > now
}

/** Milliseconds left, for a screen that wants to say so. Zero when locked. */
export function unlockRemaining(now: number = Date.now()): number {
  return Math.max(0, until - now)
}

export function unlock(now: number = Date.now()): void {
  until = now + UNLOCK_MINUTES * 60_000
  announce()
}

/** Called when the gate is given up deliberately, and on every sign-out. */
export function lock(): void {
  if (until === 0) return
  until = 0
  announce()
}

export function onGateChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
