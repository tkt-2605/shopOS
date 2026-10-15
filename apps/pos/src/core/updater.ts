import {
  canInstall, dueForCheck, updateWords, CHECK_EVERY_MS,
  type AvailableUpdate, type UpdateSource, type UpdateStage, type InstallRefusal,
} from '@shopos/core'
import { getSetting, readTarget, releaseDecision, type SqlDriver } from '@shopos/core'
import { invoke } from '@tauri-apps/api/core'
import { logEvent } from './log'

/**
 * Keeping the till up to date, without ever getting in its way.
 *
 * The rules are in `packages/core/src/services/update.ts` and are tested
 * there. This is the part that has a platform under it: a source backed by
 * Tauri's updater plugin, and a loop that checks at start and once a day.
 *
 * ## Only a release build updates itself
 *
 * The feed and the key that checks it are not in `tauri.conf.json`. They are
 * merged in by `release.yml` from the repository's settings, so the one place
 * to change them is there, and a build made anywhere else -- `tauri dev`, CI,
 * an installer made by hand for a Sandbox -- has no feed at all. Rust registers
 * the plugin only when it was given one and answers `updates_enabled`;
 * `updateSourceForThisBuild` asks that before it loads the plugin, and a build
 * that says no gets `noUpdates()`, which is also what every test gets.
 */

/** What the Tauri plugin exposes, narrowed to what this uses. */
interface UpdaterPlugin {
  check(): Promise<{
    version: string
    body?: string
    date?: string
    /** The whole `latest.json`, which is where the release's `shops` field is. */
    rawJson?: Record<string, unknown>
    /* Download and install as two calls, never `downloadAndInstall`. On
       Windows installing runs the installer and the app exits there and then,
       so a combined call made in the background -- which is when a download
       happens -- would close the till in the middle of a sale, past every
       check `apply` makes about whether now is a safe moment. */
    download(onEvent?: (event: { event: string; data?: { chunkLength?: number; contentLength?: number } }) => void): Promise<void>
    install(): Promise<void>
  } | null>
}

/**
 * The source backed by the plugin.
 *
 * Written against the plugin's shape rather than importing it, so the tests
 * can hand it a stand-in and a build without the plugin never loads it.
 */
export function tauriUpdateSource(
  plugin: UpdaterPlugin,
  relaunch: () => Promise<void>,
): UpdateSource {
  let pending: Awaited<ReturnType<UpdaterPlugin['check']>> = null

  return {
    async check(): Promise<AvailableUpdate | null> {
      const found = await plugin.check()
      pending = found
      if (found === null) return null

      return {
        version: found.version,
        notes: found.body ?? '',
        publishedAt: found.date ?? null,
        shops: found.rawJson?.['shops'],
      }
    },

    async download(_update, onProgress): Promise<void> {
      if (pending === null) throw new Error('nothing to download')

      let got = 0
      let total = 0
      await pending.download((event) => {
        /* Only the bytes: "download" finishes with the installer on disk
           and nothing run. Running it, and the restart after, is `install`,
           which only `apply` reaches, after checking no bill is open. */
        if (event.event === 'Started') total = event.data?.contentLength ?? 0
        if (event.event === 'Progress') {
          got += event.data?.chunkLength ?? 0
          if (total > 0) onProgress?.((got / total) * 100)
        }
        if (event.event === 'Finished') onProgress?.(100)
      })
    },

    /**
     * Runs the downloaded installer, then restarts into the new build.
     *
     * On Windows the installer usually closes the app itself; the relaunch
     * is for when it does not.
     */
    async install(): Promise<void> {
      if (pending === null) throw new Error('nothing downloaded to install')
      // Only here, which `apply` reaches after it has checked no bill is open.
      /* The installer closes the app without the window's usual exit, and a
         run that stops for an update is not a crash (`faults.rs`). */
      try { await invoke('faults_ending') } catch { /* never in the way of an update */ }
      await pending.install()
      await relaunch()
    },
  }
}

/**
 * The source for whatever build this is.
 *
 * Anything that goes wrong asking -- no Tauri under the page, a command this
 * binary does not have -- is a build that does not update, never an error on
 * a screen: a till that cannot update is a till that is working.
 */
export async function updateSourceForThisBuild(): Promise<UpdateSource> {
  try {
    if (!(await invoke<boolean>('updates_enabled'))) return noUpdates()
    const [plugin, process] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ])
    return tauriUpdateSource(plugin, process.relaunch)
  } catch (cause) {
    logEvent('info', 'updater', `no update source: ${String(cause)}`)
    return noUpdates()
  }
}

/** A source that finds nothing, for a build with no feed and for tests. */
export function noUpdates(): UpdateSource {
  return {
    async check() { return null },
    async download() { throw new Error('nothing to download') },
    async install() { throw new Error('nothing to install') },
  }
}

export interface Updater {
  state(): UpdateStage
  /** The sentence for the sidebar, or an empty string. */
  words(): string
  /** Asks the feed, if it is time. `force` asks regardless. */
  poll(force?: boolean): Promise<UpdateStage>
  /** Fetches an available update. Safe at any time; never blocks a sale. */
  fetch(): Promise<UpdateStage>
  /** Installs, if the drawer is closed. Does not return on success. */
  apply(): Promise<InstallRefusal | void>
  /** Told whenever the stage changes, for a React state hook. */
  onChange(listener: (state: UpdateStage) => void): () => void
  stop(): void
}

export interface UpdaterOptions {
  db: SqlDriver
  source: UpdateSource
  now?: () => number
  /** Off in tests, which drive `poll` by hand. */
  interval?: boolean
  /**
   * Takes a copy of the database before installing, answering why it failed
   * or null. A failure refuses the first press with the reason; the second
   * press installs anyway (`update-rollout.md`, step 7).
   */
  backupFirst?: () => Promise<string | null>
  /**
   * This shop's id, for a release made for some shops only. Defaults to the
   * one in the shop's settings; a till without one is offered only releases
   * meant for every shop.
   */
  shopId?: () => Promise<string | null>
}

export function createUpdater(opts: UpdaterOptions): Updater {
  const now = opts.now ?? (() => Date.now())
  let state: UpdateStage = { stage: 'idle', checkedAt: null }
  let refusal: InstallRefusal | undefined
  // Set once a person has been told the copy failed, so pressing again goes ahead.
  let backupWaived = false
  const listeners = new Set<(state: UpdateStage) => void>()

  const move = (next: UpdateStage): UpdateStage => {
    state = next
    for (const listener of listeners) listener(next)
    return next
  }

  const poll = async (force = false): Promise<UpdateStage> => {
    if (!force && !dueForCheck(state, now())) return state

    move({ stage: 'checking' })
    try {
      const found = await opts.source.check()
      if (found !== null && found.shops !== undefined) {
        const shopId = await (opts.shopId ?? (() => getSetting(opts.db, 'shop_id')))().catch(() => null)
        const decision = releaseDecision(shopId, found.version, readTarget(found.shops))
        if (!decision.offer) {
          /* Not for this shop yet. To the shop it is exactly as if there
             were nothing new; the log says why, for a support call. */
          logEvent('info', 'updater', `${found.version} is not offered to this shop yet (${decision.why})`)
          return move({ stage: 'idle', checkedAt: now() })
        }
      }
      return move(found === null
        ? { stage: 'idle', checkedAt: now() }
        : { stage: 'available', update: found })
    } catch (cause) {
      /* A till that cannot reach GitHub is a till that is working. Logged,
         because a support call wants to know, and not shown. */
      logEvent('info', 'updater', `check failed: ${String(cause)}`)
      return move({ stage: 'failed', why: String(cause), checkedAt: now() })
    }
  }

  const timer = opts.interval === false
    ? null
    : setInterval(() => { void poll() }, CHECK_EVERY_MS)

  return {
    state: () => state,
    words: () => updateWords(state, refusal),

    poll,

    async fetch(): Promise<UpdateStage> {
      if (state.stage !== 'available') return state
      const update = state.update

      move({ stage: 'downloading', update, percent: 0 })
      try {
        await opts.source.download(update, (percent) => {
          if (state.stage === 'downloading') move({ stage: 'downloading', update, percent })
        })
        return move({ stage: 'ready', update })
      } catch (cause) {
        logEvent('info', 'updater', `download failed: ${String(cause)}`)
        return move({ stage: 'failed', why: String(cause), checkedAt: now() })
      }
    },

    async apply(): Promise<InstallRefusal | void> {
      const allowed = await canInstall(opts.db, state)
      if (!allowed.ok) {
        refusal = allowed
        /* Re-announced so the sidebar's sentence changes from "ready to
           install" to "close the drawer at Counter 2 first" without the
           stage moving. */
        move(state)
        return allowed
      }

      refusal = undefined
      if (state.stage !== 'ready') return
      if (opts.backupFirst && !backupWaived) {
        const failed = await opts.backupFirst()
        if (failed !== null) {
          backupWaived = true
          refusal = { ok: false, code: 'BACKUP_FAILED', detail: failed }
          move(state)
          return refusal
        }
      }
      move({ stage: 'installing', update: state.update })
      await opts.source.install()
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    stop() {
      if (timer !== null) clearInterval(timer)
      listeners.clear()
    },
  }
}
