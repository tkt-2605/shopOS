import { invoke } from '@tauri-apps/api/core'

/**
 * The webview's half of the log file.
 *
 * A React error on a shop PC used to exist in one place: a DevTools console
 * nobody has open, on a machine nobody can reach, until the window is closed
 * and it is gone. Everything here goes into the same file, in the same order,
 * as the Rust events around it — and the ordering is the point. "The backup
 * failed and then the screen went white" is a different bug from "the screen
 * went white and then the backup failed", and until now neither line existed.
 *
 * ## It must never be the thing that breaks
 *
 * Every call is fire-and-forget and every failure is swallowed. This is called
 * from an error handler, from a React error boundary, and from `catch` blocks
 * whose whole job is to keep the till serving customers — so a logger that can
 * throw would turn a handled problem into an unhandled one. There is no
 * `await` anywhere a caller can see.
 */

export type Level = 'info' | 'warn' | 'error'

/** Long enough for a stack, short enough that a loop cannot fill a disk. */
const MAX = 8000

export function logEvent(level: Level, source: string, message: string): void {
  try {
    /* Deliberately not awaited and deliberately not returned: a caller must
       not be able to make the till wait on a log write, and `.catch` is what
       stops a rejected promise becoming an unhandled rejection that this
       module's own handler would then try to log. */
    void invoke('log_event', { level, source, message: message.slice(0, MAX) })
      .catch(() => {})
  } catch {
    /* `.catch` covers a rejected promise and nothing else. `invoke` throws
       synchronously when there is no Tauri bridge at all — a webview opened in
       an ordinary browser — and this function is called from inside a React
       error boundary, where a throw is fatal: React unmounts the whole tree
       when `componentDidCatch` throws. So the logger would have taken the app
       down, on the one path where the app was already in trouble. */
  }
}

/** What a thrown thing was, when it may not be an Error at all. */
export function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`
  }
  try {
    return typeof err === 'string' ? err : JSON.stringify(err)
  } catch {
    // A circular object, or one whose getters throw. It was still an error.
    return String(err)
  }
}

let installed = false

/**
 * Catches what nobody caught.
 *
 * `window.onerror` covers a throw that escaped React, and
 * `unhandledrejection` covers the far commoner one: a `void somethingAsync()`
 * whose promise rejects, which in a browser is a red line in a console and
 * here is silence. Both are the errors most worth having, because an error
 * somebody wrote a `catch` for is one somebody was expecting.
 */
export function startLogging(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (e: ErrorEvent) => {
    logEvent('error', 'window', e.error ? describe(e.error) : `${e.message} (${e.filename}:${e.lineno})`)
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    logEvent('error', 'promise', describe(e.reason))
  })
}
