import { invoke } from '@tauri-apps/api/core'
import { setDeviceId, type DeviceStore } from '@shopos/core'

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
let stranded: readonly string[] = []

export interface DeviceTrouble {
  /** Why the machine could not be identified, or null when it could. */
  problem: string | null
  /** Settings still in the shop's table because this machine could not take them. */
  stranded: readonly string[]
}

const watchers = new Set<(trouble: DeviceTrouble) => void>()

/**
 * What is wrong with this machine's record of itself, for a screen to say.
 *
 * A till that cannot name itself must still be able to sell — a shop losing a
 * Saturday evening because a JSON file went bad would be a far worse failure
 * than an unattributed bill. So nothing here throws and nothing here blocks: the
 * counter carries on, writing audit rows with no device against them, which is
 * exactly what every row written before migration 019 already looks like.
 *
 * But carrying on quietly is its own fault, and it was this one. When the file
 * cannot be read, **five other things change with it and none of them announces
 * itself**: the theme and density go back to their defaults, the receipt printer
 * falls back to whatever Windows calls default, and `backup_hook` reads as
 * nothing — so the nightly copy to the USB stick stops running. What the
 * shopkeeper sees is a till that changed colour, printed somewhere else and
 * stopped backing up, with nothing on any screen connecting the three. A desktop
 * app has no console for them to open.
 *
 * So the trouble is published, and `DeviceTroubleBanner` in `App.tsx` says it on
 * every screen until it is fixed.
 */
export function deviceTrouble(): DeviceTrouble {
  return { problem, stranded }
}

/** Why the machine could not be identified, or null when it could. */
export function deviceProblem(): string | null {
  return problem
}

/** Subscribe a screen to the above. Returns the unsubscribe. */
export function onDeviceTrouble(fn: (trouble: DeviceTrouble) => void): () => void {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

/**
 * The settings that could not be moved onto this machine and are still sitting
 * in the shop's table — see `moveSettingsToDevice`. Same failure as `problem`,
 * reported the same way.
 */
export function recordStranded(keys: readonly string[]): void {
  stranded = keys
  announce()
}

function announce(): void {
  const trouble = deviceTrouble()
  for (const fn of watchers) fn(trouble)
}

export async function establishDevice(): Promise<DeviceIdentity | null> {
  try {
    identity = await invoke<DeviceIdentity>('device_identity')
    adopt(identity)
    return identity
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    identity = null
    setDeviceId(null)
    console.error('Could not establish this machine\'s identity:', problem)
    announce()
    return null
  }
}

/**
 * Takes an answer from the Rust side as this machine's own.
 *
 * `setDeviceId` is the part that is easy to leave out of the later two callers,
 * and leaving it out is invisible: identification fails at startup, a person
 * then changes the printer on the Settings screen and the file writes perfectly
 * well — so the app knows which machine it is and core does not, and every audit
 * row for the rest of the session still carries no device. One function, so
 * there is one place for it.
 */
function adopt(got: DeviceIdentity): void {
  identity = got
  setDeviceId(got.id)
  problem = null
  announce()
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
    adopt(await invoke<DeviceIdentity>('device_set_register', { registerId }))
    return true
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err)
    console.error('Could not record which counter this machine is:', problem)
    announce()
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
 *
 * A new backup command is shown to a person in a Windows dialog first, and
 * Cancel also returns false -- but it is an answer, not a broken machine, so it
 * does not raise the banner that says this till cannot save what it knows.
 *
 * The same save asked twice while the first is still open is one save. Pressing
 * Test blurs the command field, and the blur and the test both save the new
 * command: without this that is two dialogs, one behind the other.
 */
export function setDeviceSetting(key: string, value: string | null): Promise<boolean> {
  const ask = JSON.stringify([key, value])
  const open = saving.get(ask)
  if (open) return open
  const save = writeSetting(key, value).finally(() => saving.delete(ask))
  saving.set(ask, save)
  return save
}

/** What Rust answers when the person pressed Cancel (`device.rs`). */
const DECLINED = 'DECLINED'
const saving = new Map<string, Promise<boolean>>()

async function writeSetting(key: string, value: string | null): Promise<boolean> {
  try {
    adopt(await invoke<DeviceIdentity>('device_set_setting', { key, value }))
    return true
  } catch (err) {
    if (err === DECLINED) return false
    problem = err instanceof Error ? err.message : String(err)
    console.error(`Could not record ${key} for this machine:`, problem)
    announce()
    return false
  }
}

/**
 * The two functions above, in the shape core asks for.
 *
 * Core takes a `DeviceStore` rather than importing this module, because
 * `packages/core` may not know what Tauri is. There are now three callers —
 * `moveSettingsToDevice` at startup, `witnessClock` beside it, and the licence
 * card — and the first two used to build the object literal inline. A named one
 * matters more than it looks: the card needs the *same* store the witness wrote
 * to, and two literals that drift apart would leave the clock warning reading a
 * key nobody had written.
 *
 * `DEVICE_LOCAL_KEYS` is not a gate on what may be stored here. It is the
 * one-time list of settings moved out of the shop's table; `device_set_setting`
 * on the Rust side takes any key at all.
 */
export function deviceStore(): DeviceStore {
  return { has: deviceSetting, put: setDeviceSetting }
}
