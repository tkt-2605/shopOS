# Phase 0 spec — Stop the bleeding

Source: plan *Phase 0 — Stop the bleeding*. One commit per row. Half a day.

## Scope

Seven small changes that each close a way a shop loses money or data. Nothing
here needs a decision; the only judgment calls are recorded below.

## Open decisions resolved here

- **Daily backup**: `backup.ts:139` says once-per-opening is by design, and the
  reasoning is right for a shop that switches off at night. The fix is *both*:
  keep the on-open run and add a timer that fires at the next 02:00 local and
  every 24 h after. Each till backs up its own machine and the hook is already
  per-machine, so two tills cannot prune each other's folders.
- **`synchronous = FULL`** applies to `db.rs` only. `node-driver.ts` stays
  `NORMAL`; tests are not durability tests.
- **Version string** comes from Rust (`app.package_info().version`), not from
  `package.json` at build time, so what Settings shows is what is running.

## File-level task list

| Task | Where | Mark |
|---|---|---|
| `PRAGMA synchronous = FULL` | `apps/pos/src-tauri/src/db.rs:92` | `[delegate: Sonnet/Haiku]` |
| `runHook` failure surfaced: keep the fire-and-forget, but store `{ok, code, output, at}` in device settings `last_hook_result` and show it on the Backup card, red when `ok === false` or `code !== 0` | `apps/pos/src/core/backup.ts:126`, `pages/Settings.tsx` backup card | `[delegate: Opus]` — the hook finishes after the screen has moved on; the result has to be stored, not returned |
| `runDailyBackup().error` shown: CoreProvider stores the `DailyResult`; the Backup card and a top-bar dot show it until the next success | `apps/pos/src/core/CoreProvider.tsx:214` | `[delegate: Sonnet/Haiku]` |
| `listBackups`/`describeBackups` throw instead of returning `[]`; the three callers show "could not read the backup folder: …" | `backup.ts:20-34` | `[delegate: Sonnet/Haiku]` |
| React error boundary around `PageBody`: the error text, a "copy details" button, a "back to Billing" button; logs through the Phase 3 logger once it exists, `console.error` until then | `apps/pos/src/App.tsx:305` | `[delegate: Sonnet/Haiku]` |
| `app_version` command returning `{version, schema}`; shown at the bottom of Settings and on `CouldNotStart` | `src-tauri/src/lib.rs`, `pages/Settings.tsx` | `[delegate: Sonnet/Haiku]` |
| Daily backup timer as decided above | `CoreProvider.tsx:214` | `[delegate: Sonnet/Haiku]` |
| `noUnusedLocals` + `noUnusedParameters` on; delete the symbols they surface (plan Phase 1d, "Genuinely dead"); no `_`-prefix suppressions | `tsconfig.base.json` | `[delegate: Sonnet/Haiku]` |

## Dependencies

None. This is done first and blocks nothing, except that the test bench
package is written under the stricter `tsconfig`.

## Verification

- [ ] `PRAGMA synchronous` read back through `Db::open` is `2` (FULL) — a Rust test
- [ ] Set `backup_hook` to `exit 1`; take a backup; the Backup card shows the failure with the exit code
- [ ] Rename the backup folder while the app runs; open Settings → Backups; the message names the folder rather than showing an empty list
- [ ] Throw inside a page render (a temporary `throw` in Dashboard); the sidebar stays, the boundary shows, "back to Billing" works
- [ ] Settings shows `0.1.0 · schema 27` and it matches `tauri.conf.json`
- [ ] Machine clock set to 01:59, wait two minutes: a backup is written; on-open backup still runs on the next launch
- [ ] `npm run typecheck` passes with both flags on and zero `_`-prefixed suppressions added
- [ ] Owner's real database: opened, billed once, backed up once, restarted — all on the same tree
