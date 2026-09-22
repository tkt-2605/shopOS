import {
  canInstall, dueForCheck, updateWords, CHECK_EVERY_MS,
  type AvailableUpdate, type UpdateSource, type UpdateStage, type InstallRefusal,
} from '@shopos/core'
import type { SqlDriver } from '@shopos/core'
import { UPDATE_FEED_URL } from '@shopos/core/config'
import { logEvent } from './log'

/**
 * Keeping the till up to date, without ever getting in its way.
 *
 * The rules are in `packages/core/src/services/update.ts` and are tested
 * there. This is the part that has a platform under it: a source backed by
 * Tauri's updater plugin, and a loop that checks at start and once a day.
 *
 * ## The plugin is not wired yet, on purpose
 *
 * `tauri-plugin-updater` is not in `src-tauri/Cargo.toml` and
 * `tauri.conf.json` carries a placeholder endpoint and no public key, because
 * neither the signing keypair nor the GitHub owner/repo has been decided --
 * rows 2 and 3 of *Left that is not code* in `docs/specs/progress.md`. Until
 * they are, `tauriUpdateSource` reports "no update feed" rather than
 * pretending, and everything around it -- the state machine, the drawer
 * check, the words in the sidebar -- is real and tested.
 *
 * **To drop the real one in**, in this order:
 *
 * 1. `npm run portal -- keygen` is *not* this key. Run `npx tauri signer
 *    generate` for the updater's own keypair and back the private half up
 *    twice; it cannot be recovered and losing it means no till in the field
 *    can ever be updated again.
 * 2. Add `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml`, and
 *    `.plugin(tauri_plugin_updater::Builder::new().build())` in `lib.rs`.
 * 3. Put the public half in `tauri.conf.json` under `plugins.updater.pubkey`,
 *    and the release URL in `endpoints`.
 * 4. Set `UPDATE_FEED_URL` in `packages/core/src/config/licensing.ts`.
 * 5. At the call site, hand `tauriUpdateSource` the plugin and `relaunch`:
 *    `tauriUpdateSource(await import('@tauri-apps/plugin-updater'),
 *    (await import('@tauri-apps/plugin-process')).relaunch)`.
 *
 * Step 5 is one line and this file does not otherwise change, which is the
 * point of it being written this way.
 */

/** What the Tauri plugin exposes, narrowed to what this uses. */
interface UpdaterPlugin {
  check(): Promise<{
    version: string
    body?: string
    date?: string
    downloadAndInstall(onEvent?: (event: { event: string; data?: { chunkLength?: number; contentLength?: number } }) => void): Promise<void>
  } | null>
}

/**
 * The real source, once the plugin is there.
 *
 * Written against the plugin's shape rather than importing it, so that this
 * file compiles and the app bundles with the crate absent. The import becomes
 * real at step 5 above.
 */
export function tauriUpdateSource(
  plugin?: UpdaterPlugin,
  /** Supplied at step 2 as `tauri-plugin-process`'s `relaunch`. */
  relaunch: (() => Promise<void>) | null = null,
): UpdateSource {
  let pending: Awaited<ReturnType<UpdaterPlugin['check']>> = null

  return {
    async check(): Promise<AvailableUpdate | null> {
      if (plugin === undefined || UPDATE_FEED_URL === null) {
        /* Not an error and not shown to anybody. A build with no feed is a
           build that is never updated, which is exactly what an unsigned
           Sandbox build and every test run should be. */
        return null
      }

      const found = await plugin.check()
      pending = found
      if (found === null) return null

      return {
        version: found.version,
        notes: found.body ?? '',
        publishedAt: found.date ?? null,
      }
    },

    async download(_update, onProgress): Promise<void> {
      if (pending === null) throw new Error('nothing to download')

      let got = 0
      let total = 0
      await pending.downloadAndInstall((event) => {
        /* The plugin downloads and installs in one call, so "download" here
           finishes with the bytes on disk and the installer staged. The
           restart is what `install` triggers. */
        if (event.event === 'Started') total = event.data?.contentLength ?? 0
        if (event.event === 'Progress') {
          got += event.data?.chunkLength ?? 0
          if (total > 0) onProgress?.((got / total) * 100)
        }
        if (event.event === 'Finished') onProgress?.(100)
      })
    },

    /**
     * Restarts into the staged build.
     *
     * `downloadAndInstall` above has already written the installer; the
     * relaunch is what picks it up. `tauri-plugin-process` arrives with
     * `tauri-plugin-updater` at step 2, and until then there is nothing
     * staged to restart into, so this says so rather than reaching for a
     * module that is not installed.
     */
    async install(): Promise<void> {
      if (relaunch === null) throw new Error('the updater plugin is not wired in yet')
      await relaunch()
    },
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
}

export function createUpdater(opts: UpdaterOptions): Updater {
  const now = opts.now ?? (() => Date.now())
  let state: UpdateStage = { stage: 'idle', checkedAt: null }
  let refusal: InstallRefusal | undefined
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
