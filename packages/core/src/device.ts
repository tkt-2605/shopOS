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

/** Called once at startup by the host. Passing null unsets it, which is what a sign-out and a test teardown both want. */
export function setDeviceId(id: string | null): void {
  current = id === null ? null : (id.trim() || null)
}

export function deviceId(): string | null {
  return current
}
