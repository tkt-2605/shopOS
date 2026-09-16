export type SqlValue = string | number | bigint | Uint8Array | null
export type Row = Record<string, SqlValue>

export interface ExecResult {
  rowsAffected: number
}

/** How long a piece of work believes it is worth waiting for. */
export interface TxOptions {
  /**
   * How long this transaction may run before a watchdog rolls it back.
   *
   * Omitted means the default, which is sized for a bill: fifteen seconds, so a
   * counter stranded by a JavaScript exception is usable again before the
   * customer has finished looking up.
   *
   * A merge is the other kind of work. Taking in a few hundred changes from
   * another till is one transaction on purpose — half a merge is not a state
   * any reconciliation rule can describe — and on a till that has been offline
   * a week it can legitimately run for a minute. Under a bill's budget the
   * watchdog rolls that back, the next round starts again from the beginning,
   * and a till far enough behind never catches up. So the merge asks for
   * longer, rather than everything being given it.
   *
   * Honoured by the Tauri driver, where the transaction is held across IPC and
   * the watchdog is real. The node driver has no watchdog and ignores it.
   */
  budgetMs?: number
}

export interface SqlDriver {
  query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>
  get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined>
  /**
   * A write that is not part of any transaction.
   *
   * Refused by the Tauri driver while one is open, with "a transaction is
   * open". There is one connection, so a statement sent outside the token would
   * otherwise silently *join* the transaction that is running and share its
   * fate — a setting saved during a merge that rolls back is gone, with the
   * screen having already said it was saved.
   */
  execute(sql: string, params?: SqlValue[]): Promise<ExecResult>
  /**
   * Runs fn inside BEGIN IMMEDIATE — commits when it resolves, rolls back when
   * it throws. BEGIN IMMEDIATE rather than DEFERRED so write contention fails at
   * the start instead of at commit, when half the work is already done.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>, opts?: TxOptions): Promise<T>
  close(): Promise<void>
}

/** What a merge asks for. Ninety seconds, and the Rust side caps it at five minutes. */
export const MERGE_BUDGET_MS = 90_000

export class SqlError extends Error {
  constructor(
    message: string,
    readonly sql: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SqlError'
  }
}
