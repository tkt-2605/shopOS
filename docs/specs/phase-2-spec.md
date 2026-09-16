# Phase 2 spec — Foundations, while the installed base is zero

Source: plan *Phase 2* (2a, 2b, 2c). Architect pass §1 and §2.

## Scope

Typed queries (Drizzle) for the money paths first, a `SqlDriver` for Turso in
core only, and a migration classification that lets tills at N and N−1 sync.
The local engine does not change.

## Open decisions resolved here

- **Rollout by risk** (pass §2): parity test → `billing.ts` → `returns.ts` →
  `payments.ts` → `cash.ts` → `repos/reports.ts` → `stock.ts`/`stockEntry.ts`
  → the rest alphabetically. One service per commit; the diff touches that
  service, its test, and nothing else.
- **Drizzle never owns a transaction.** The proxy driver's `transaction()`
  sends bare `BEGIN`/`COMMIT` through the callback, which on the Tauri driver
  bypasses `sql_tx_begin`'s token and the watchdog. Callers keep
  `db.transaction(async (tx) => …)` and build the Drizzle handle from `tx`.
- **Rows come back as arrays, in SELECT order.** The proxy callback expects
  positional rows. `db.rs` builds `serde_json::Map`, which sorts keys unless
  `preserve_order` is on, so objects cannot be trusted for order. Add a
  positional query path rather than relying on a Cargo feature nobody will
  remember.
- **The schema file is generated once, then owned.** `drizzle-kit pull`
  against a copy of the owner's migrated database seeds `schema.ts`;
  `Money`/`Qty` brands and `exactOptionalPropertyTypes` fixes are applied by
  hand; after that every migration edits `schema.ts` by hand and the parity
  test catches drift. `drizzle-kit generate`/`push` are never run.

## File-level task list

### 2a. Drizzle

- `packages/core/src/db/driver.ts` — add
  `queryValues(sql, params?): Promise<SqlValue[][]>` to `SqlDriver`.
  `node-driver.ts`: `stmt.raw(true).all()`. `tauri-driver.ts`: new commands
  `sql_query_values` / `sql_tx_query_values`; `db.rs` returns
  `Vec<Vec<Json>>` from the same `run_query` path. `[delegate: Opus]`
- `packages/core/src/db/schema.ts` — generated then owned, as above. Column
  helpers in `db/columns.ts`:
  ```ts
  export const money = customType<{ data: Money; driverData: number }>({
    dataType: () => 'integer', fromDriver: (v) => v as Money, toDriver: (v) => v,
  })
  export const qty = customType<{ data: Qty; driverData: number }>({ /* same shape */ })
  ```
  `[delegate: Opus]` for the first pass; `[delegate: Sonnet/Haiku]` for
  later migrations' edits.
- `packages/core/src/db/q.ts`:
  ```ts
  const handles = new WeakMap<SqlDriver, DrizzleDb>()
  export function q(driver: SqlDriver): DrizzleDb {
    let h = handles.get(driver)
    if (!h) {
      h = drizzle(async (sql, params, method) => {
        if (method === 'run') { await driver.execute(sql, params as SqlValue[]); return { rows: [] } }
        const rows = await driver.queryValues(sql, params as SqlValue[])
        return { rows: method === 'get' ? (rows[0] ?? []) : rows }
      }, { schema })
      handles.set(driver, h)
    }
    return h
  }
  ```
  A `TxDriver` is a distinct object per transaction, so the WeakMap gives a
  distinct handle per transaction for free. `[delegate: Opus]`
- `packages/core/test/schemaParity.test.ts` — for every table in `schema.ts`,
  `PRAGMA table_info` must match name, affinity, notnull, default and pk of
  every column; every non-`sqlite_` table in the database must appear in
  `schema.ts`; every row of `PRAGMA foreign_key_list` must be declared.
  Modelled on `replicaShape.test.ts`. `[delegate: Opus]`
- The service rewrites, in the order above. Each: replace hand-written SQL
  with `q(db)` queries; keep raw SQL only where Drizzle cannot express it
  (window functions, `ON CONFLICT … max()`), marked `// raw: <reason>`.
  `[delegate: Opus]` for billing, returns, payments, cash, reports;
  `[delegate: Sonnet/Haiku]` for everything after stock.

### 2b. A `SqlDriver` for Turso

- `packages/core/src/db/libsql-driver.ts` — `@libsql/client`
  (`createClient({url, authToken})`); `query`/`get`/`execute`/`queryValues`
  over `client.execute`; `transaction()` via `client.transaction('write')`,
  nesting joins as the node driver does. Only the headless till imports it.
  `[delegate: Opus]`
- No Rust change. `rusqlite` stays.

### 2c. Migrations that can be rolled out

- `packages/core/src/db/migrations.ts` — entries become
  `[version, file, 'additive' | 'breaking']`; classify all 28 (001 breaking
  by definition; every `ADD COLUMN` with a default, new table, new index, new
  trigger is additive; anything that renames, drops, tightens a CHECK or
  rewrites rows into a new shape is breaking). Export
  `MIN_PEER_SCHEMA_VERSION`: the version after the last breaking migration.
  `[delegate: Opus]`
- `services/sync.ts` handshake: exchange `{schema, minPeer}`; accept when
  `peer.schema >= mine.minPeer && mine.schema >= peer.minPeer`. `applyBatch`
  filters each record's columns to the local table's `PRAGMA table_info`
  (cached per table per process) and skips tables it does not have, counting
  both into the round report as `ignoredColumns`/`ignoredTables` so the newer
  till can say "the other till is behind". `[delegate: Opus]`
- `tools/pull-shop-db` (copies the owner's `shop.db` to a gitignored
  `tools/fixtures/real-shop.db`) and `tools/seed-large` (a synthetic shop:
  2,000 products, 500 customers, 20,000 bills over two fiscal years) for CI.
  `[delegate: Sonnet/Haiku]`
- `test/migrationReplay.test.ts` — for each fixture present: copy, replay
  from its recorded version to head, assert `integrity_check = ok`,
  `foreign_key_check` empty, and per-table row counts unchanged except where
  a migration writes. `[delegate: Sonnet/Haiku]`

## Dependencies

- 2a starts only after Phase 1a–1c are merged.
- 2c's handshake change un-skips the bench's `schema-skew.test.ts` in the
  same commit.
- 2b needs nothing and blocks nothing until Phase 6.

## Verification

- [ ] `schemaParity.test.ts` passes against `tools/fixtures/real-shop.db` migrated to head, and fails when one column is renamed in `schema.ts` (prove it, then revert)
- [ ] Column-order test: selecting `(b, a)` from a table declared `(a, b)` returns `[b, a]` through both drivers
- [ ] A Drizzle query inside `db.transaction` on the Tauri driver goes through `sql_tx_query_values` (assert on the invoke log in a jsdom test)
- [ ] After each service commit: the whole suite green, and a grep for `db.query|db.get|db.execute` in that service finds only `// raw:` lines
- [ ] `migrationReplay.test.ts` green on the real copy and on the synthetic shop
- [ ] Bench: a till at 28 and a till at 27 sync when 28 is additive; a deliberately breaking test migration flips it to `SCHEMA_MISMATCH`
- [ ] The customer-buckets rehearsal is not run here; it is Phase 5's proof of this phase
