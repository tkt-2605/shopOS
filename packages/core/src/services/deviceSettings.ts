import type { SqlDriver } from '../db/driver.js'
import { getSetting, forgetSetting } from './settings.js'

/**
 * Moving a setting out of the shop's table and onto the machine it describes.
 *
 * The rule is the whole module: **store it on the machine first, and only then
 * remove the shared row.** The first version of this did it the other way round
 * — read-and-delete in one transaction, then write to the device — and the
 * device write is the one that can fail. `device.json` sits on a real disk that
 * can be full, read-only, or held open by an antivirus scanner, and the writes
 * return false rather than throwing on purpose, so that a till which cannot
 * record its own name can still sell.
 *
 * Put together, those two decisions lost data silently: a shop whose device.json
 * could not be written upgraded once and permanently lost its printer, its
 * backup command and which counter it was — and then fell back to the first
 * active register, so a second till began minting the first one's invoice
 * numbers. That is the exact failure the move was made to prevent.
 *
 * Done in this order the worst case is that the shared row survives one more
 * start and the next one tries again, which is not a failure at all.
 */

export interface DeviceStore {
  /** What this machine has already recorded for a key, or null. */
  has: (key: string) => string | null
  /** Records it. False means it could not be written and nothing was stored. */
  put: (key: string, value: string) => Promise<boolean>
}

export interface MoveResult {
  moved: string[]
  /** Keys still in the shared table because the machine could not take them. */
  stranded: string[]
}

export async function moveSettingsToDevice(
  db: SqlDriver,
  keys: readonly string[],
  device: DeviceStore,
): Promise<MoveResult> {
  const moved: string[] = []
  const stranded: string[] = []

  for (const key of keys) {
    const shared = await getSetting(db, key)
    if (shared === null) continue

    /* A machine that already has its own answer keeps it — the shared row is
       then just a leftover to clear, and the second till to be upgraded must not
       adopt the first one's printer. A blank shared value is nothing to carry,
       so it is cleared rather than stored as an empty string. */
    if (device.has(key) === null && shared.trim() !== '') {
      if (!(await device.put(key, shared))) {
        stranded.push(key)
        continue
      }
      moved.push(key)
    }

    await forgetSetting(db, key)
  }

  return { moved, stranded }
}
