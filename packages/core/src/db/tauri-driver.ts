import {
  type SqlDriver, type SqlValue, type Row, type ExecResult, type TxOptions, SqlError,
} from './driver.js'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Talks to the Rust command layer. The transaction is held open in Rust across
 * several IPC calls, so `transaction()` must end it on every path — Rust also
 * runs a watchdog, but that is the backstop, not the plan.
 */
export function createTauriDriver(invoke: Invoke): SqlDriver {
  return new TauriDriver(invoke)
}

class TauriDriver implements SqlDriver {
  constructor(private readonly invoke: Invoke) {}

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.call<T[]>('sql_query', { sql, params }, sql)
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params)
    return rows[0]
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<ExecResult> {
    return this.call<ExecResult>('sql_execute', { sql, params }, sql)
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    /* The budget goes with the transaction rather than being a constant in
       Rust, because a bill and a merge want different numbers and one constant
       cannot be both. `driver.ts` carries which breaks at which setting.

       Undefined rather than a number when the caller said nothing, so the
       default lives in one place — in Rust, next to the watchdog that reads
       it — instead of being written down twice. */
    const token = await this.call<string>(
      'sql_tx_begin', { budgetMs: opts.budgetMs }, 'BEGIN IMMEDIATE',
    )
    const tx = new TxDriver(this.invoke, token)
    let committed = false
    try {
      const result = await fn(tx)
      await this.call<void>('sql_tx_end', { token, commit: true }, 'COMMIT')
      committed = true
      return result
    } finally {
      if (!committed) {
        try {
          await this.call<void>('sql_tx_end', { token, commit: false }, 'ROLLBACK')
        } catch {
          // The watchdog will have cleared it; the original error is what matters.
        }
      }
    }
  }

  async close(): Promise<void> {
    // The connection lives for the life of the process, owned by Rust.
  }

  protected async call<T>(cmd: string, args: Record<string, unknown>, sql: string): Promise<T> {
    try {
      return (await this.invoke(cmd, args)) as T
    } catch (cause) {
      throw new SqlError(typeof cause === 'string' ? cause : String(cause), sql, cause)
    }
  }
}

class TxDriver extends TauriDriver {
  constructor(
    invoke: Invoke,
    private readonly token: string,
  ) {
    super(invoke)
  }

  override async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.call<T[]>('sql_tx_query', { token: this.token, sql, params }, sql)
  }

  override async execute(sql: string, params: SqlValue[] = []): Promise<ExecResult> {
    return this.call<ExecResult>('sql_tx_execute', { token: this.token, sql, params }, sql)
  }

  /**
   * Nested calls join the transaction already open rather than starting another.
   *
   * A budget passed here is ignored, and deliberately so: the transaction is
   * already running under the budget the outermost caller set, and there is
   * nothing to re-negotiate. Honouring it would mean a helper deep inside a
   * merge could quietly shorten the merge's own deadline.
   */
  override async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

export async function backupDatabase(invoke: Invoke, target: string): Promise<void> {
  await invoke('backup_database', { target })
}
