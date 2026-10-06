import { syncUntilDone, collectChanges, applyBatch, changedHere } from '../src/services/sync.js'
import type { SyncTransport } from '../src/services/sync.js'
import { setDeviceId, deviceId } from '../src/device.js'
import { EXPECTED_SCHEMA_VERSION } from '../src/db/schemaVersion.js'
import { getSetting } from '../src/services/bootstrap.js'
import type { SqlDriver } from '../src/db/driver.js'

/*
 * Two tills in one process, syncing a chosen number of records at a time.
 * The device id is process-wide, so each side's work runs as that side --
 * see `sync.test.ts`, whose harness this is a smaller copy of.
 */

export const TILL_A = '1111aaaa-1111-4111-8111-111111111111'
export const TILL_B = '2222bbbb-2222-4222-8222-222222222222'

export interface Till { id: string; db: SqlDriver }

export async function as<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = deviceId()
  setDeviceId(id)
  try { return await fn() } finally { setDeviceId(before) }
}

/** The far till in process, sending `limit` records a batch. */
export function wire(peer: Till, me: Till, limit: number): SyncTransport {
  return {
    async hello() {
      const cursor = await peer.db.get<{ c: number }>(
        `SELECT their_cursor AS c FROM sync_peers WHERE device_id = ?`, [me.id])
      return {
        deviceId: peer.id, label: peer.id.slice(0, 4), schemaVersion: EXPECTED_SCHEMA_VERSION,
        shopId: await getSetting(peer.db, 'shop_id'), yourCursorWithThem: cursor?.c ?? 0,
      }
    },
    async fetch(since) { return as(peer.id, () => collectChanges(peer.db, since, limit, me.id)) },
    async offer(batch) {
      return as(peer.id, async () => {
        await applyBatch(peer.db, batch, await changedHere(peer.db, 0, batch.records))
        await peer.db.execute(
          `INSERT INTO sync_peers (device_id, their_cursor, created_at) VALUES (?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET their_cursor = excluded.their_cursor`,
          [batch.fromDevice, batch.upTo, new Date().toISOString()])
        return { upTo: batch.upTo }
      })
    },
  }
}

/** `me` syncs with `from` until neither has anything left to say. */
export const pull = (me: Till, from: Till, limit = 200) =>
  as(me.id, () => syncUntilDone(me.db, wire(from, me, limit), 5000))
