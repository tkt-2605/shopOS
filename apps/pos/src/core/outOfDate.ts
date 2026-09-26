import { onTillAhead, EXPECTED_SCHEMA_VERSION, type TillAhead } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'

/**
 * Whether this till has been found running a ShopOS too old for the rest of the
 * shop, kept on the machine so the banner is up from the first screen after a
 * restart rather than only once the other till has been heard from again.
 *
 * Keyed to the build that found it. An update is a new build, and a record
 * from before it says nothing about the till now running -- so updating clears
 * the banner without anybody having to, and if the gap is still there the next
 * contact says so again.
 */

export const AHEAD_SETTING = 'till_ahead'

export interface OutOfDate extends TillAhead {
  /** When this till first found out, for "out of sync since". */
  since: string
}

const listeners = new Set<(gap: OutOfDate | null) => void>()

/** The gap this build is behind, or null. */
export function outOfDate(): OutOfDate | null {
  const raw = deviceSetting(AHEAD_SETTING)
  if (raw === null) return null
  try {
    const gap = JSON.parse(raw) as OutOfDate
    return gap.mine === EXPECTED_SCHEMA_VERSION ? gap : null
  } catch {
    return null
  }
}

export function onOutOfDate(fn: (gap: OutOfDate | null) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function tell(): void {
  const gap = outOfDate()
  for (const fn of listeners) fn(gap)
}

/** Records what core hears. Written once per gap, not on every hello. */
export function watchForTillsAhead(): () => void {
  return onTillAhead((ahead) => {
    const held = outOfDate()
    if (held !== null && held.peer === ahead.peer && held.theirs === ahead.theirs) return
    const gap: OutOfDate = { ...ahead, since: held?.since ?? new Date().toISOString() }
    void setDeviceSetting(AHEAD_SETTING, JSON.stringify(gap)).then(tell)
  })
}

/** A round with that till worked, so whatever was recorded about it is over. */
export async function caughtUpWith(peer: string): Promise<void> {
  if (outOfDate()?.peer !== peer) return
  await setDeviceSetting(AHEAD_SETTING, null)
  tell()
}
