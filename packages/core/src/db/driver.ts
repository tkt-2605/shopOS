export type SqlValue = string | number | bigint | Uint8Array | null
export type Row = Record<string, SqlValue>

export interface ExecResult {
  rowsAffected: number
}

export interface SqlDriver {
  query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>
  get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined>
  execute(sql: string, params?: SqlValue[]): Promise<ExecResult>
  /**
   * Runs fn inside BEGIN IMMEDIATE — commits when it resolves, rolls back when
   * it throws. BEGIN IMMEDIATE rather than DEFERRED so write contention fails at
   * the start instead of at commit, when half the work is already done.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>
  close(): Promise<void>
}

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
