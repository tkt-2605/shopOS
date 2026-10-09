import type { SqlDriver } from '../../db/driver.js'
import { EXPECTED_SCHEMA_VERSION } from '../../db/schemaVersion.js'
import { deviceId } from '../../device.js'
import { mayHandOutCopies } from '../sync/copy.js'
import { type SyncResponse, type SyncServerOptions, ok, refuse } from './wire.js'

/**
 * A copy of the shop, for a paired till that is joining it.
 *
 * Only from the main, because the main is what the joining till will sync
 * through, and the position the copy records is a position in the main's
 * feed. The bytes do not come back here: the answer is a token, and the host
 * serves the file against it (`/copy-part`, answered by the listener in the
 * app). See `sync/copy.ts`.
 */
export async function handleCopy(
  db: SqlDriver,
  them: string,
  opts: SyncServerOptions,
): Promise<SyncResponse> {
  if (!(await mayHandOutCopies(db, deviceId()))) return refuse(409, 'NOT_THE_MAIN')
  if (opts.copies === undefined) return refuse(501, 'NO_COPIES')
  const made = await opts.copies.make(them)
  return ok({ ...made, schemaVersion: EXPECTED_SCHEMA_VERSION })
}
