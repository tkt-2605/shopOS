/**
 * What time this process thinks it is, in the one place that can be moved.
 *
 * Sync is the only part of the product where *two* clocks exist and can
 * disagree. A merge tiebreak, a ±5 minute signing window and a "last seen"
 * column are all decisions made by comparing one machine's idea of now against
 * another's — and the bugs in that class are invisible while both clocks are
 * this machine's, which is the only arrangement the tests have ever had.
 *
 * So the sync services read `clock.now()` and nothing else, and the test bench
 * hands the two tills clocks that are five minutes apart.
 *
 * ## Why not fake timers
 *
 * `vi.useFakeTimers()` replaces the clock for the whole process, so both sides
 * of a sync move together and stay in agreement — which is precisely the thing
 * that must not be assumed. It also cannot cross a process boundary, and Layer
 * 2 of the bench runs the two tills in separate containers. An injected
 * function works identically in-process, across processes and in the real app.
 *
 * ## What is deliberately *not* on this seam
 *
 * Billing and audit keep their own `ctx.now?.()`. A posting date is a fact
 * about a shop's trading day, decided by `businessDate()` against the till's
 * own wall clock; it is not a thing two machines negotiate. Moving it here
 * would let a test that skews a clock for sync reasons silently file a bill
 * against the wrong day — the exact bug class `businessDate()` exists to stop.
 */

const systemClock = (): number => Date.now()

let source: () => number = systemClock

/**
 * Replaces the clock for this process. `null` restores the system clock, which
 * is what a test teardown wants.
 *
 * The argument is a function rather than a fixed instant so that time still
 * moves: a frozen clock makes a retry-with-backoff test pass for the wrong
 * reason, because nothing ever becomes stale.
 */
export function setClock(fn: (() => number) | null): void {
  source = fn ?? systemClock
}

/**
 * An object rather than a bare exported function, so that every call site reads
 * `clock.now()`. A bare `now()` import is too easy to confuse with the `now`
 * parameters that billing and audit already pass around, and those must not be
 * moved onto this seam — see above.
 */
export const clock = {
  now: (): number => source(),
  /** The same instant as a `Date`, for the columns that store ISO strings. */
  date: (): Date => new Date(source()),
  /** What goes in a `TEXT` timestamp column. */
  iso: (): string => new Date(source()).toISOString(),
}
