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
  minted: boolean
}

let problem: string | null = null

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
    const identity = await invoke<DeviceIdentity>('device_identity')
    setDeviceId(identity.id)
    problem = null
    return identity
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    setDeviceId(null)
    console.error('Could not establish this machine\'s identity:', problem)
    return null
  }
}
