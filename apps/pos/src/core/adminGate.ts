/**
 * Whether the person at the keyboard has proved they are still themselves.
 *
 * Settings decides what every bill prints, which features the counter offers and
 * what happens when stock runs short; the permissions screen decides who may do
 * any of it. Being signed in is not a strong enough answer for those two, because
 * a till that is signed in and unattended is the ordinary state of a counter —
 * that is the whole point of a till.
 *
 * So those two screens ask for the password once, and then stay open until the
 * person signs out. Not per change, and not on a timer: an owner setting a shop
 * up would be asked over and over in the middle of the job, and a gate that gets
 * in the way of the work is a gate that gets switched off — which is a worse
 * outcome than no gate at all.
 *
 * The unlock lives in memory and nowhere else. Written to disk it would survive
 * a restart, and an unlock that survives a restart is a back door. A
 * module-level value rather than context for the same reason `modalStack.ts` is
 * one — `App.tsx` reads it outside any provider of its own.
 */

let open = false
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

export function isUnlocked(): boolean {
  return open
}

export function unlock(): void {
  if (open) return
  open = true
  announce()
}

/** Called when the gate is given up deliberately, and on every sign-out. */
export function lock(): void {
  if (!open) return
  open = false
  announce()
}

export function onGateChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
