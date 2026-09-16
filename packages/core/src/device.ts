/**
 * Which machine this process is.
 *
 * Process-level rather than an argument, because a device is a property of the
 * program that is running and not of the thing it happens to be doing. Threading
 * it through forty service signatures to reach one INSERT would be the kind of
 * churn that gets half-finished, and a provenance column that is right for
 * two-thirds of writes is worse than one that is empty — it looks trustworthy.
 *
 * The value itself is minted outside the database and handed in at startup
 * (`apps/pos/src-tauri/src/device.rs` says why outside matters). Core never
 * mints it: a library that invented its own machine identity would hand a fresh
 * one to every test run and to every process a server starts.
 *
 * `AuditContext.deviceId` overrides this where a caller genuinely knows better —
 * a sync applying another till's changes has to record the till they came from,
 * not the one doing the applying. That day is not here yet; the seam is.
 */

let current: string | null = null
let source: (() => string | null) | null = null

/** Called once at startup by the host. Passing null unsets it, which is what a sign-out and a test teardown both want. */
export function setDeviceId(id: string | null): void {
  current = id === null ? null : (id.trim() || null)
}

/**
 * For a host that runs more than one till in one process — the test bench, and
 * later the cloud peer, which serves several shops from one supervisor.
 *
 * The comment above says a device is a property of the program that is running,
 * and that is true of the app: one window, one machine, one identity for the
 * life of the process. It stops being true the moment two tills share a
 * process, which is exactly what `tools/virtual-till` does so that a sync can
 * be asserted from both ends on one PC. A module-global there means the second
 * till overwrites the first, and every row either of them writes is attributed
 * to whichever called `setDeviceId` last — silently, and in a way that would
 * make the provenance tests pass while proving nothing.
 *
 * A resolver rather than moving this to `AsyncLocalStorage` here: `node:async_hooks`
 * does not exist in the webview, and core has to run in both. The bench owns the
 * per-till context and hands in a function that reads it; the app never calls
 * this and its path is unchanged.
 */
export function setDeviceIdSource(fn: (() => string | null) | null): void {
  source = fn
}

export function deviceId(): string | null {
  return source ? source() : current
}
