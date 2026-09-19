import type { Row, SqlDriver, SqlValue, ExecResult, TxOptions } from '@shopos/core'

/**
 * The driver, with a tap on the shoulder after every write.
 *
 * A till used to tell the other one about a sale when the loop next came round,
 * which is up to forty-five seconds of somebody standing at the far counter
 * waiting for a bill that has already been rung up. The loop is right as a
 * floor and wrong as a pace.
 *
 * Hooked here rather than at the call sites because "after every change" has to
 * mean every change. Annotating the services that matter would cover billing on
 * the day it was written and miss the next thing somebody adds -- and the ones
 * it missed would be exactly the quiet kind, a price edited or a customer's
 * phone number corrected, that nobody notices is stale until it matters.
 *
 * Only writes. A read is most of what the app does and none of it is news.
 *
 * The merge writes through this driver too, and those writes are the other
 * till's rows rather than this one's news. `nudgeSync` is what tells them apart:
 * a round is running for the whole of a merge, so those land as one deferred
 * nudge at the end rather than one per row.
 */
export function nudgingDriver(inner: SqlDriver, wrote: () => void): SqlDriver {
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
    async execute(sql: string, params?: SqlValue[]): Promise<ExecResult> {
      const result = await inner.execute(sql, params)
      wrote()
      return result
    },
    async transaction<T>(fn: (tx: SqlDriver) => Promise<T>, opts?: TxOptions): Promise<T> {
      /* After it resolves, which is after the commit. A transaction that threw
         wrote nothing, and telling the other till about a rollback would be a
         round that carries an empty batch and a wrong impression. */
      const result = await inner.transaction(fn, opts)
      wrote()
      return result
    },
    close(): Promise<void> {
      return inner.close()
    },
  }
}
