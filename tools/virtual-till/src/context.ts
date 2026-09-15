import { AsyncLocalStorage } from 'node:async_hooks'
import { setClock, setDeviceIdSource, setServingRegisterSource } from '@shopos/core'

/**
 * Which till the code currently running belongs to.
 *
 * ## The problem this solves
 *
 * Core keeps three things as module-level state: which machine this is
 * (`device.ts`), which counter this till serves (`syncServer.ts`), and what
 * time it is (`clock.ts`). Every one of those is correct for the app, where a
 * process is a window is a machine — and every one of them is wrong the moment
 * two tills share a process, which is exactly what this package does so that a
 * sync can be asserted from both ends on one PC.
 *
 * The existing HTTP test works around it with set-restore around each call:
 *
 * ```ts
 * const before = deviceId(); setDeviceId(id)
 * try { await work() } finally { setDeviceId(before) }
 * ```
 *
 * That holds only while nothing interleaves. It is not a sound base for the
 * scenarios here, which deliberately run two tills concurrently — a partition
 * healing while the other side retries, a reply dropped after the far side has
 * committed. Under any of those, one till's `await` yields to the other's and
 * the "restore" puts back a value that is already stale. The rows would then be
 * attributed to the wrong till *silently*, and a provenance assertion would
 * pass while proving nothing. That is the same shape as the bug the bench
 * exists to catch, so it may not be in the bench itself.
 *
 * ## Why AsyncLocalStorage
 *
 * It follows the await chain. Anything a till starts — including an HTTP
 * handler and everything it awaits — sees that till's identity, and two tills
 * interleaving cannot see each other's. It is the only mechanism in Node that
 * gets this right without threading a context argument through forty service
 * signatures, which is the churn `device.ts` already argued against.
 *
 * It lives here and not in core because `node:async_hooks` does not exist in
 * the webview. Core exposes three resolver seams; this package is the only
 * caller of them, and the app's path is untouched.
 *
 * ## Why not one process per till
 *
 * The specification's own phrasing is "two processes disagreeing", and Layer 2
 * does run one container per till — the CLI in `cli.ts` is that process, and
 * it shares every line below. But Layer 1 has to run inside `npm test` in under
 * a minute, and `Till.db` has to be a real driver so scenarios can assert on
 * the stored rows of both tills. Spawning a process per till buys real
 * isolation at the cost of an IPC layer between every assertion and the rows it
 * is about, on Windows, six scenarios at a time. Injected clocks give the same
 * assertion; the containers give the same isolation. Confidence: high for the
 * clock, and the register/device seams are exercised by `same-register` and
 * `host-initiates`, which fail loudly if the context leaks.
 */
export interface TillContext {
  deviceId: string
  registerId: string | null
  clock: () => number
}

const storage = new AsyncLocalStorage<TillContext>()

let installed = false

/**
 * Points core's three seams at whichever till is running. Idempotent, because
 * every `startTill` calls it and a test file starts several.
 *
 * Outside any till — a test's own setup, say — the resolvers answer as they did
 * before: no device, no serving register, the system clock. Nothing that is not
 * inside `asTill` changes behaviour.
 */
export function installTillContext(): void {
  if (installed) return
  installed = true
  setDeviceIdSource(() => storage.getStore()?.deviceId ?? null)
  setServingRegisterSource(() => storage.getStore()?.registerId ?? null)
  setClock(() => storage.getStore()?.clock() ?? Date.now())
}

/** Undoes the above. A test teardown wants this so one file cannot leak into the next. */
export function removeTillContext(): void {
  installed = false
  setDeviceIdSource(null)
  setServingRegisterSource(null)
  setClock(null)
}

/** Runs `fn` as this till, including everything it awaits. */
export function asTill<T>(context: TillContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The till currently running, or null outside one. For assertions, not logic. */
export function currentTill(): TillContext | null {
  return storage.getStore() ?? null
}
