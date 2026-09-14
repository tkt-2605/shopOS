import { invoke } from '@tauri-apps/api/core'
import { setDeviceId } from '@shopos/core'

/**
 * Establishes which machine this is, before anything can write a row.
 *
 * The identity is minted and kept by the Rust side, outside the database —
 * `src-tauri/src/device.rs` carries the reasoning. This module's only job is to
 * fetch it and hand it to core, early enough that the first audit row of the
 * session already carries it.
 */

export interface DeviceIdentity {
  id: string
  label: string
  /** Which counter this machine bills on, or null if it has never been asked. */
  registerId: string | null
  /** Settings that describe this machine rather than the shop. */
  settings: Record<string, string>
  minted: boolean
}

/**
 * The settings that were in the shop's `settings` table and never belonged to
 * the shop. Each one differs from counter to counter, and sharing them means the
 * second till prints on the first till's printer and fires its backup command.
 *
 * They are moved across once, on the first start after this change, so a shop
 * already running keeps the printer it had.
 */
export const DEVICE_LOCAL_KEYS = [
  'thermal_printer',
  'backup_hook',
  'backup_folder',
  'ui_density',
  'ui_theme',
] as const

let problem: string | null = null
let identity: DeviceIdentity | null = null

/**
 * Why the machine could not be identified, or null when it could.
 *
 * A till that cannot name itself must still be able to sell — a shop losing a
 * Saturday evening because a JSON file went bad would be a far worse failure
 * than an unattributed bill. So this records the reason and the counter carries
 * on, writing audit rows with no device against them, which is exactly what
 * every row written before migration 019 already looks like.
 */
export function deviceProblem(): string | null {
  return problem
}

export async function establishDevice(): Promise<DeviceIdentity | null> {
  try {
    identity = await invoke<DeviceIdentity>('device_identity')
    setDeviceId(identity.id)
    problem = null
    return identity
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    identity = null
    setDeviceId(null)
    console.error('Could not establish this machine\'s identity:', problem)
    return null
  }
}

export function thisDevice(): DeviceIdentity | null {
  return identity
}

/**
 * The counter this machine chose, as it chose it — not as the database would
 * have it. `resolveDeviceRegister` is what turns this into a counter that still
 * exists; this is only what was picked.
 */
export function chosenRegister(): string | null {
  return identity?.registerId ?? null
}

/**
 * Records the counter on the machine rather than in the shop's database.
 *
 * A till that cannot write the file keeps billing on whatever it resolved to
 * this session and says so, because the alternative — refusing the choice — is
 * a counter that cannot be set up at all.
 */
export async function chooseRegister(registerId: string | null): Promise<boolean> {
  try {
    identity = await invoke<DeviceIdentity>('device_set_register', { registerId })
    problem = null
    return true
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    console.error('Could not record which counter this machine is:', problem)
    return false
  }
}

/** What this machine has recorded for a setting of its own. */
export function deviceSetting(key: string): string | null {
  const value = identity?.settings?.[key]
  return value === undefined || value === '' ? null : value
}

/**
 * Records a setting about this machine. A blank value forgets it rather than
 * storing an empty string, which would read as "set to nothing".
 *
 * Returns false when the file could not be written, so a screen can say the
 * choice will not survive a restart instead of pretending it was saved.
 */
export async function setDeviceSetting(key: string, value: string | null): Promise<boolean> {
  try {
    identity = await invoke<DeviceIdentity>('device_set_setting', { key, value })
    problem = null
    return true
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    console.error(`Could not record ${key} for this machine:`, problem)
    return false
  }
}
