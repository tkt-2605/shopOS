import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  Backup, pairedPeers, httpTransport, takeCopy, requestCopy, mainTill, SyncHttpError,
  type CopyHost, type CopyMaker, type SelfAddress, type SqlDriver,
} from '@shopos/core'
import { SCHEMA_VERSION } from './migrations'
import { syncFetch } from './syncFetch'

/**
 * The app's half of a copy of the shop: Rust takes it, serves it, fetches it
 * and installs it, and core says what is asked and checked. See
 * `packages/core/src/services/sync/copy.ts` and `src-tauri/src/shop_copy.rs`.
 */

/** On the main: a `VACUUM INTO`, with what is only the main's taken out. */
export const copyMaker: CopyMaker = {
  make: (forPeer) => invoke('sync_copy_prepare', { forPeer }),
}

/** On the joining till: fetch the bytes, then stage them and restart. */
export const copyHost: CopyHost = {
  async download(copy, baseUrl) {
    await invoke('sync_copy_download', {
      // `host` rather than `hostname`: Rust opens a socket, and wants the port on it.
      address: new URL(baseUrl).host,
      token: copy.token,
      bytes: copy.bytes,
      sha256: copy.sha256,
    })
    // Rust keeps it in one place and installs it from there; nothing names it.
    return 'joining-copy.db'
  },
  async install(_path, plan) {
    const now = new Date()
    await invoke('copy_install', {
      mainDevice: plan.mainDevice,
      feedHead: plan.feedHead,
      safetyName: Backup.safetyName(now),
      now: now.toISOString(),
      supported: SCHEMA_VERSION,
    })
  },
}

export interface CopyProgress { done: number; total: number }

/** Follows a copy arriving. Returns the unsubscribe. */
export async function onCopyProgress(fn: (p: CopyProgress) => void): Promise<() => void> {
  return listen<CopyProgress>('copy-progress', (e) => fn(e.payload))
}

/**
 * A copy of the main's database, rather than the shop through the feed.
 *
 * The feed is for what changed since two tills last agreed; a whole shop
 * through it is thousands of rounds, and seeding it re-sends the shop to
 * every till the main already has. So a joining till asks for a copy, which
 * Rust fetches and installs with this till's own pairing carried across, and
 * the app restarts into it. `sync/copy.ts` in core says what is checked.
 *
 * Returns false only for a main too old to hand one out: it ignored the
 * request to skip seeding, so the feed carries the shop as it always did.
 */
export async function takeACopy(db: SqlDriver, self: SelfAddress): Promise<boolean> {
  const peer = (await pairedPeers(db))[0]
  if (peer === undefined) return false
  try {
    const taken = await takeCopy(
      db, { deviceId: peer.deviceId, baseUrl: peer.baseUrl },
      async () => httpTransport(peer, syncFetch, self).hello(await mainTill(db)),
      () => requestCopy(peer, syncFetch, self),
      copyHost,
    )
    if (taken.ok) return true
    throw new Error(taken.code === 'VERSION_DIFFERS'
      ? 'The main till is on a different version of ShopOS. Update the older one, then join again.'
      : 'This till holds work the main till has not received, so it cannot take a copy yet.')
  } catch (err) {
    if (err instanceof SyncHttpError && err.code === 'NO_SUCH_REQUEST') return false
    throw err
  }
}
