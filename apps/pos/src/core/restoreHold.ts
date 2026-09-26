import { adoptRestoredIdentity, setReplacedDevice, type SqlDriver } from '@shopos/core'
import { deviceSetting, setDeviceSetting } from './device'

/**
 * A till restored from a backup, until it has caught up with the shop.
 *
 * `restore.rs` gives the machine a new identity when a restore commits and
 * leaves this setting behind: which identity it replaced, and when. The bills
 * this till rang up between the backup and the restore are on the other tills
 * and nowhere here -- so until they come back, the number series here is
 * behind the numbers already printed, and the next bill can be handed an
 * invoice number a customer is already holding. Billing is held until a sync
 * has brought them back, or until a person who knows nothing was rung up here
 * since the backup says to go on.
 */

export const RESTORE_SETTING = 'restore'

interface Restore {
  replaces: string
  at: string
  /** The database has taken up the new identity. See `adoptRestoredIdentity`. */
  adopted?: boolean
  /** A person chose to bill before catching up. */
  billAnyway?: boolean
}

const listeners = new Set<(hold: RestoreHold | null) => void>()

export interface RestoreHold {
  /** When the restore happened. */
  since: string
}

function held(): Restore | null {
  const raw = deviceSetting(RESTORE_SETTING)
  if (raw === null) return null
  try {
    const it = JSON.parse(raw) as Restore
    return typeof it.replaces === 'string' && typeof it.at === 'string' ? it : null
  } catch {
    return null
  }
}

async function save(value: Restore | null): Promise<void> {
  await setDeviceSetting(RESTORE_SETTING, value === null ? null : JSON.stringify(value))
  const hold = restoreHold()
  for (const fn of listeners) fn(hold)
}

/** Whether billing is held, and since when. */
export function restoreHold(): RestoreHold | null {
  const it = held()
  return it === null || it.billAnyway === true ? null : { since: it.at }
}

export function onRestoreHold(fn: (hold: RestoreHold | null) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * At startup, after the migrations. Moves the counter to the new identity,
 * forgets the peers the backup remembered, and tells core whose place this
 * till is taking so the next pairing says so. A shop with no other till has
 * nothing to catch up with, and the hold is lifted there and then.
 */
export async function settleRestore(db: SqlDriver): Promise<void> {
  const it = held()
  if (it === null) return
  setReplacedDevice(it.replaces)
  if (it.adopted === true) return

  const adopted = await adoptRestoredIdentity(db, { replaces: it.replaces, at: it.at })
  if (adopted.peersForgotten === 0) {
    setReplacedDevice(null)
    await save(null)
    return
  }
  await save({ ...it, adopted: true })
}

/** A person's word that nothing was rung up here since the backup. */
export async function billAnywayAfterRestore(): Promise<void> {
  const it = held()
  if (it !== null) await save({ ...it, billAnyway: true })
}

/** A sync that finished with nothing more waiting. The till is in step. */
export async function caughtUpAfterRestore(): Promise<void> {
  if (held() === null) return
  setReplacedDevice(null)
  await save(null)
}

export function restoreHoldMessage(hold: RestoreHold): string {
  const since = new Date(hold.since).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
  return `This till was restored from a backup on ${since} and has not caught up with the other tills yet. `
    + 'Bills rung up here after that backup are on the other tills, and until they come back this till '
    + 'can give out an invoice number a customer already has. Pair it with the other till and let it sync, '
    + 'or choose "Bill anyway" if nothing was rung up here since the backup.'
}
