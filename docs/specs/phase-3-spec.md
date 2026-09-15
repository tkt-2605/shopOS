# Phase 3 spec — A shop must not be able to lose data

Source: plan *Phase 3*. Architect pass *Also found to be guesses*
(`quick_check`, daily backup).

## Scope

Startup failure that reaches a screen, backups that are proven after they are
written, a log file and a diagnostics bundle, and the scale and timeout fixes
the audit found. All of it lands before Phase 4 ships a build to anyone.

## Open decisions resolved here

- **`quick_check` at start, `integrity_check` at backup and weekly.** A full
  check on a large file blocks the one connection for seconds on a shop PC at
  opening time. The weekly one runs from the 02:00 timer and its date is kept
  in `device.json` (per machine, not per shop).
- **Reads are allowed while a transaction is open; writes are not.**
  `sql_query` may run during a long merge so the screen keeps working;
  `sql_execute` outside the token is refused with "a transaction is open",
  because a write that silently joins one is the bug the audit named.
- **The transaction budget is per transaction.** `sql_tx_begin` takes
  `budgetMs` (default 15 000; the merge passes 90 000). The watchdog reads the
  budget off `ActiveTx`, so a legitimate 60 s merge is never rolled back under
  the JavaScript and a stuck bill is still cleared in 15 s.
- **Diagnostics stay local by default.** The bundle is a zip the shopkeeper
  can send by WhatsApp; upload is Phase 6, cloud tier, consent once.
- **`backup_hook` is redacted** from the bundle: it can hold an rclone remote
  with a token.

## File-level task list

- `src-tauri/src/lib.rs` — `setup()` never `?`s the database open. The `Db`
  state becomes `DbState(Mutex<Result<Db, StartupFailure>>)`; every `sql_*`
  command maps `Err` to a `"DB_NOT_OPEN: <message>"` string; a new command
  `startup_status() -> Option<StartupFailure {message, dbPath, kind:
  'corrupt' | 'locked' | 'io' | 'schema_too_new'}>`. `main.rs` keeps
  `windows_subsystem = "windows"`; the panic hook below writes to the log.
  `App.tsx` calls `startup_status` before anything else and routes to
  `CouldNotStart`, whose `RestorePanel` already exists. `[delegate: Opus]`
- `db.rs` — `quick_check` after `configure()`; a failure is
  `StartupFailure {kind: 'corrupt'}`. `[delegate: Sonnet/Haiku]`
- `archive.rs:68` — after the zip is closed: reopen it, extract `shop.db` to a
  temp file, `PRAGMA integrity_check` through rusqlite, compare
  `PRAGMA page_count` with the source at snapshot time; on any failure delete
  the zip and return `Err` so the Phase 0 card turns red. `[delegate: Opus]`
- `restore.rs` — `backup_inspect(name)` command running `restore_inspect`'s
  checks without staging; a "Check this backup" button per row on the Backups
  card showing bill count, last bill date and the integrity result.
  `[delegate: Sonnet/Haiku]`
- `restore.rs` tests — end to end: write a zip from a seeded database, stage
  it, `apply_pending`, open the result, count bills. `[delegate: Sonnet/Haiku]`
- `src-tauri/src/log.rs` — a rolling file `logs/shopos.log`, 5 × 1 MiB, in
  the app data dir; `std::panic::set_hook` writes the panic and backtrace;
  `log_event(level, source, message)` command for the webview; `setup()`,
  migrations, backup outcome and every sync refusal log through it.
  `apps/pos/src/core/log.ts` — `window.onerror`, `unhandledrejection` and the
  Phase 0 boundary forward to `log_event`. `[delegate: Opus]`
- `diagnostics_bundle()` command — a zip of the logs, `app_version`, the
  schema version, `device.json` with `backup_hook` redacted,
  `PRAGMA journal_mode/synchronous/page_count/freelist_count`, and the last
  200 audit rows; saved to a folder the user picks. Button on Settings →
  Support. `[delegate: Sonnet/Haiku]`
- `services/stock.ts` — `recomputeStock(db, productIds?: string[])`; when
  given, replays only those products. `sync.ts:328` passes the ids in the
  batch. The Dashboard stops calling it on mount and reads `product_stock`.
  `[delegate: Opus]` — the unbounded replay is also what fixes drift, so a
  weekly full replay stays on the 02:00 timer.
- Migration 029 (additive) — indexes `audit_log(actor_id)`,
  `bills(kind, docstatus, posting_date)`,
  `stock_ledger(product_id, posting_date, created_at)`. `[delegate: Sonnet/Haiku]`
- `payments.ts` — `totalOutstandingAll(db)` as one `SUM` over the open-bill
  query; the Credit page uses it for "Total outstanding" and keeps the
  500-row list for display only. `[delegate: Sonnet/Haiku]`
- `db.rs` — `budgetMs` on `sql_tx_begin`; `sql_execute` refused while a
  transaction is open; `sql_query` allowed. `tauri-driver.ts` passes the
  budget; `sync.ts` requests 90 000 for the merge. `[delegate: Opus]`

## Dependencies

- Phase 0's Backup card and `app_version`; this phase fills them.
- The log file should exist before Phase 4's first outside install. Nothing
  else here blocks Phase 4, and Phase 3 runs in parallel with Phase 1 and 2.

## Verification

- [ ] Overwrite `shop.db` with random bytes; launch: the window opens on `CouldNotStart` with the reason, and `logs/shopos.log` has the same line
- [ ] Lock `shop.db` from another process; launch: `kind: 'locked'`, the message names the file
- [ ] Flip one byte inside a backup zip's database; "Check this backup" says so; the daily backup of a healthy database says ok with a bill count matching the Bills page
- [ ] Break the rclone token; the next backup shows the card red with the hook's output
- [ ] `restore.rs` end-to-end test green; restore into a Windows Sandbox and raise a bill from the restored data
- [ ] The diagnostics bundle opened by hand: no token in `device.json`, log present, version present
- [ ] On the synthetic 20,000-bill shop: a Dashboard mount runs zero `stock_ledger` full scans (`EXPLAIN QUERY PLAN` in a test); a sync round carrying one ledger row replays one product
- [ ] Credit page "Total outstanding" equals the `SUM` over all customers on a shop with 600 customers
- [ ] A merge of 500 changes on the synthetic shop completes without the watchdog firing; a bill left open in a test is rolled back at 15 s
- [ ] Power cut on a VM during a burst of 50 bills; on restart every bill whose submit returned is present (Layer 3 procedure)
