import { eq, lt } from 'drizzle-orm'
import type { SqlDriver } from '../../db/driver.js'
import { q, schema } from '../../db/q.js'
import { deviceId } from '../../device.js'
import { clock } from '../../clock.js'

/*
 * A till that has just been restored from a backup, taking up where the
 * machine it was left off.
 *
 * `restore.rs` gives the machine a new identity at the moment the restore
 * commits: with its old one the other tills' cursors sat above the restored
 * feed, so nothing it wrote afterwards was ever asked for, and the bills it had
 * rung up since the backup were never sent back. This is the database's half.
 */

export interface Adopted {
  /** Counters this machine held under its old identity, now held under the new. */
  counters: number
  /**
   * Peers the backup remembered. Their secrets are stripped from every backup,
   * so each has to be paired again, and their cursors describe a feed this
   * database no longer has -- so they go. Zero means a single-till shop, which
   * has nobody to catch up with.
   */
  peersForgotten: number
}

/**
 * Safe to run on every start until the till has caught up: the counters have
 * already moved the second time, and a peer paired since the restore has a
 * `created_at` after it and is kept.
 */
export async function adoptRestoredIdentity(
  db: SqlDriver,
  restore: { replaces: string; at: string },
): Promise<Adopted> {
  const me = deviceId()
  if (me === null || me === restore.replaces) return { counters: 0, peersForgotten: 0 }

  return db.transaction(async (tx) => {
    const at = clock.iso()
    /* The same machine at the same counter: the invoice series carries on
       rather than being handed to a ghost and taken back by a person. */
    const held = await q(tx)
      .select({ id: schema.registers.id })
      .from(schema.registers)
      .where(eq(schema.registers.claimedBy, restore.replaces))
    if (held.length > 0) {
      await q(tx).update(schema.registers)
        .set({ claimedBy: me, claimedAt: at, updatedAt: at })
        .where(eq(schema.registers.claimedBy, restore.replaces))
    }

    const stale = await q(tx)
      .select({ id: schema.syncPeers.deviceId })
      .from(schema.syncPeers)
      .where(lt(schema.syncPeers.createdAt, restore.at))
    if (stale.length > 0) {
      await q(tx).delete(schema.syncPeers)
        .where(lt(schema.syncPeers.createdAt, restore.at))
    }
    return { counters: held.length, peersForgotten: stale.length }
  })
}
