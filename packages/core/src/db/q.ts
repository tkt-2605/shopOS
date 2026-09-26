import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { SqlDriver, SqlValue } from './driver.js'
import * as schema from './schema.js'

type DrizzleDb = ReturnType<typeof make>

/**
 * Typed queries over a driver ShopOS already has.
 *
 * Drizzle's proxy dialect is the only one that fits: the database lives in
 * Rust, reached over IPC, and the transaction is held open across several
 * calls behind a token. A driver that owned its own connection would have to
 * be taught all of that, and would still not be the connection the watchdog is
 * watching.
 *
 * ## Drizzle never owns a transaction
 *
 * There is deliberately no `q(db).transaction(...)`. The proxy's own
 * implementation sends bare `BEGIN` and `COMMIT` through this callback, which
 * on the Tauri driver means `sql_execute` -- outside the token, refused while a
 * transaction is open, and invisible to the watchdog that would otherwise roll
 * a stranded transaction back. Callers keep `db.transaction(async (tx) => …)`
 * and build the handle from `tx`, so the typed queries go out through
 * `sql_tx_query_values` inside the token like every other statement.
 *
 * A `TxDriver` is a distinct object per transaction, so the WeakMap below gives
 * a distinct handle per transaction without anything having to arrange it, and
 * drops both when the transaction is collected.
 */
const handles = new WeakMap<SqlDriver, DrizzleDb>()

export function q(driver: SqlDriver): DrizzleDb {
  let handle = handles.get(driver)
  if (!handle) {
    handle = make(driver)
    handles.set(driver, handle)
  }
  return handle
}

function make(driver: SqlDriver) {
  return drizzle(
    async (sql, params, method) => {
      /* `run` is a write and has no rows to give back. Everything else is a
         read, and comes back positionally -- see `queryValues` in driver.ts for
         why rows as objects cannot be trusted for order here. */
      if (method === 'run') {
        await driver.execute(sql, params as SqlValue[])
        return { rows: [] }
      }

      const rows = await driver.queryValues(sql, params as SqlValue[])

      /* `get` wants the single row itself, not a list holding it. A query that
         matched nothing gives back an empty row rather than `undefined`, which
         is what the proxy dialect expects and reads as "no result". */
      return { rows: method === 'get' ? (rows[0] ?? []) : rows }
    },
    { schema },
  )
}

export { schema }
