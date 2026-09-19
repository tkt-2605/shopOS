import { MERGE_BUDGET_MS, type Row, type SqlDriver, type SqlValue, type ExecResult, type TxOptions } from '@shopos/core'

/**
 * One writer at a time, waiting rather than being turned away.
 *
 * SQLite here is one connection with one transaction on it, and `Db::begin` in
 * `db.rs` refuses a second outright — no wait, no retry, an error string. That
 * refusal is right as a backstop and was doing a job nothing else was doing: the
 * webview had two independent sources of writes and no idea the other existed.
 *
 * `runOnce` in `syncLoop.ts` guards itself with a `running` flag, which covers
 * the rounds *this* till starts and nothing else. Inbound requests arrive as
 * `sync-request` events and `syncHost.answer` fires one `handleSyncRequest` per
 * event with no lock at all. Both tills nudge on every write, so two counters
 * ringing up a sale at the same moment each post `/offer` into the middle of the
 * other's merge. One of them loses, and what it gets back is a 500 that the
 * asking side reports as "The other till refused" on a shop where nothing is
 * wrong. With one hub and several tills it stops being occasional.
 *
 * The worse half is not sync at all. A merge may legitimately hold the
 * connection for `MERGE_BUDGET_MS`, and a cashier submitting a bill inside that
 * window met the same refusal — mid-queue, with a raw string for a message.
 *
 * So the gate goes on the driver rather than inside sync. Billing, the merge,
 * the settings screen and the backup all open transactions through one object,
 * and putting the queue anywhere narrower would leave whichever pair nobody
 * thought about. `nudgingDriver` is hooked here for the same reason and says so.
 *
 * **Reads are not gated.** `Db::query` allows them during a transaction
 * deliberately — a merge can hold the connection for a minute and a counter that
 * cannot read is a counter that has stopped. Gating them here would undo that.
 */

/**
 * How long a write waits for the one in front of it before giving up.
 *
 * Above `MERGE_BUDGET_MS`, because that is the longest anything ahead may
 * legitimately hold the connection, and a write that failed sooner would be one
 * the queue could have served. So in practice this never fires: it is here to
 * turn a genuine deadlock into an error somebody can read, rather than a till
 * that hangs with no way to tell what it is waiting for.
 *
 * That leaves a real question this file does not answer — whether a bill should
 * wait a minute or fail fast and let the cashier retry. It could not be asked
 * before, because the only behaviour available was to fail immediately. It can
 * be asked now, and the answer is one constant.
 */
export const WRITE_WAIT_MS = MERGE_BUDGET_MS + 15_000

export const TILL_IS_BUSY =
  'This till is busy taking in changes from the other counter. Try again in a moment.'

/** A FIFO queue of one. Its own function so the ordering can be tested alone. */
export function oneAtATime(waitMs: number = WRITE_WAIT_MS) {
  let tail: Promise<void> = Promise.resolve()

  return async function take<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })

    /* Queued before waiting, so the order writes arrive in is the order they
       run in. A gate that raced for the lock on release would let a burst of
       nudges starve the bill somebody is standing at the counter for. */
    const ahead = tail
    tail = ahead.then(() => mine, () => mine)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ahead,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(TILL_IS_BUSY)), waitMs)
        }),
      ])
    } catch (err) {
      /* Give up the wait, not the place in the queue. Whoever is ahead is still
         holding the connection, so releasing now would let the next waiter start
         underneath them — which is the exact thing this exists to prevent. The
         slot resolves when they actually finish. */
      void ahead.then(release, release)
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    try {
      return await work()
    } finally {
      release()
    }
  }
}

/**
 * The driver, with writes queued instead of colliding.
 *
 * Wraps `transaction` and the top-level `execute`, which are the two things
 * `db.rs` refuses to have two of. A transaction's own handle is not wrapped:
 * statements inside it go to `TxDriver` against a token that is already holding
 * the connection, so gating them again would be a queue waiting on itself.
 */
export function serializingDriver(inner: SqlDriver, waitMs?: number): SqlDriver {
  const take = oneAtATime(waitMs)

  return {
    query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]> {
      return inner.query<T>(sql, params)
    },
    get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
      return inner.get<T>(sql, params)
    },
    queryValues(sql: string, params?: SqlValue[]): Promise<SqlValue[][]> {
      return inner.queryValues(sql, params)
    },
    execute(sql: string, params?: SqlValue[]): Promise<ExecResult> {
      return take(() => inner.execute(sql, params))
    },
    transaction<T>(fn: (tx: SqlDriver) => Promise<T>, opts?: TxOptions): Promise<T> {
      return take(() => inner.transaction(fn, opts))
    },
    close(): Promise<void> {
      return inner.close()
    },
  }
}
