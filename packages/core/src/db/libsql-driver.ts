import { type SqlDriver, type SqlValue, type Row, type ExecResult, SqlError } from './driver.js'

/**
 * The same `SqlDriver`, against a database that is not on this machine.
 *
 * Everything else in ShopOS talks to SQLite through a file on the counter. This
 * talks to libSQL — Turso — over the network, for the one deployment that has
 * no counter to put a file on: the headless till of Phase 6, which answers a
 * shop's own app when the shop is not in the shop.
 *
 * Nothing in `services/` or `repos/` knows the difference, and that is the
 * point of the interface. What changes is only what is true about the
 * connection, and two of those things matter enough to be written down:
 *
 * **A statement costs a round trip.** On the counter a query is microseconds
 * and a loop of four hundred of them is a blink. Here each one is a network
 * hop, and the same loop is a minute. Nothing in core loops like that on a path
 * a person waits for -- the merge is the one that comes closest, and it is
 * already one transaction -- but a new one written without this in mind would
 * be fine locally and unusable here.
 *
 * **A transaction holds a connection open across the network.** The watchdog
 * that protects the Tauri driver does not exist here; what protects this is
 * that `transaction()` is the only way to get one and it always ends.
 *
 * ## The client is passed in, not imported
 *
 * `@libsql/client` is deliberately not a dependency of this package. One
 * deployment out of three needs it, it carries native binaries, and core is the
 * package every test in the product builds. The shape this driver uses is
 * written out below -- three methods and a result -- and Phase 6's till hands
 * in `createClient({ url, authToken })`, which satisfies it structurally.
 *
 * The client must be created with libSQL's default integer mode, which returns
 * integers as JavaScript numbers. `intMode: 'bigint'` is handled below rather
 * than refused, because money in this product is an integer number of paise and
 * a `bigint` arriving where a `number` is expected does not fail -- it makes
 * every total `NaN` two functions later.
 */

/** What this driver uses of `@libsql/client`, and nothing more. */
export interface LibsqlClient {
  execute(statement: LibsqlStatement): Promise<LibsqlResult>
  transaction(mode: 'write'): Promise<LibsqlTransaction>
  close(): void
}

export interface LibsqlStatement {
  sql: string
  args: SqlValue[]
}

export interface LibsqlResult {
  /** Column names, in the order the SELECT named them. */
  columns: string[]
  /** One array of values per row, in that same order. */
  rows: unknown[][]
  rowsAffected: number
}

export interface LibsqlTransaction {
  execute(statement: LibsqlStatement): Promise<LibsqlResult>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export function libsqlDriver(client: LibsqlClient): SqlDriver {
  return new LibsqlDriver(client)
}

class LibsqlDriver implements SqlDriver {
  constructor(private readonly client: LibsqlClient | LibsqlTransaction) {}

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.run(sql, params)
    return result.rows.map((row) => asObject(result.columns, row)) as T[]
  }

  async get<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const result = await this.run(sql, params)
    const first = result.rows[0]
    return first === undefined ? undefined : (asObject(result.columns, first) as T)
  }

  async queryValues(sql: string, params: SqlValue[] = []): Promise<SqlValue[][]> {
    const result = await this.run(sql, params)
    return result.rows.map((row) => row.map(plain))
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<ExecResult> {
    const result = await this.run(sql, params)
    return { rowsAffected: result.rowsAffected }
  }

  /**
   * `TxOptions` is accepted and ignored, as in the node driver. The budget is a
   * Tauri thing: it is what the watchdog there uses to roll back a transaction
   * a crashed webview left open on the one local connection. libSQL ends a
   * transaction when this function returns either way, and a request that never
   * returns is the host's timeout to enforce, not this driver's.
   *
   * A nested call joins the transaction already open rather than starting a
   * second one, which is what the node driver does and what every service in
   * `services/` is written against: `submitBill` calls `postMovement`, and both
   * are written as though they own the transaction.
   */
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (isTransaction(this.client)) return fn(this)

    const tx = await this.client.transaction('write')
    try {
      const result = await fn(new LibsqlDriver(tx))
      await tx.commit()
      return result
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        // The transaction is already gone; surface the original failure.
      }
      throw err
    }
  }

  async close(): Promise<void> {
    /* A transaction does not own the connection it borrowed. Closing here would
       shut the client for every other caller holding the same driver. */
    if (!isTransaction(this.client)) this.client.close()
  }

  private async run(sql: string, args: SqlValue[]): Promise<LibsqlResult> {
    try {
      return await this.client.execute({ sql, args })
    } catch (cause) {
      throw new SqlError(describe(cause), sql, cause)
    }
  }
}

/**
 * A row as the rest of the product reads one.
 *
 * Built from the column names the server sent rather than from anything this
 * side assumed, so it cannot be out of step with the statement. `queryValues`
 * skips this entirely, which is why the typed queries do not depend on it.
 */
function asObject(columns: string[], row: unknown[]): Row {
  const out: Row = {}
  columns.forEach((name, i) => { out[name] = plain(row[i]) })
  return out
}

/**
 * One value, as a `SqlValue`.
 *
 * The conversion that matters is `bigint`. A client created with
 * `intMode: 'bigint'` returns every integer as one, and a `bigint` where a
 * `number` is expected does not throw -- it propagates, and the first
 * arithmetic that mixes it with a number throws `TypeError` somewhere else
 * entirely, or worse, `Number(x)` quietly rounds it. Converted here, where the
 * value is still next to the statement that produced it, and refused loudly
 * when it is too large to be a `number` rather than silently rounded.
 */
function plain(value: unknown): SqlValue {
  if (typeof value === 'bigint') {
    if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
      throw new RangeError(`${value} is too large to read as a number`)
    }
    return Number(value)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value as SqlValue
}

function isTransaction(client: LibsqlClient | LibsqlTransaction): client is LibsqlTransaction {
  return 'commit' in client
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
