import { invoke } from '@tauri-apps/api/core'

/**
 * Whether Rust managed to open the database at all, asked before anything else.
 *
 * `setup()` in `lib.rs` used to end in `Db::open(..)?`. A database that would
 * not open therefore made Tauri's setup return `Err`, so no window was ever
 * created — and `main.rs` sets `windows_subsystem = "windows"` in release, so
 * there was no console either. The entire symptom, for a shopkeeper at eight in
 * the morning, was an icon that does nothing when it is double-clicked: no
 * message, no log, nothing to read down a phone line, and no way to reach the
 * Restore button that would have fixed it.
 *
 * Rust now carries the failure into the app instead of dying of it, and this is
 * how the app asks. It has to be the *first* question, before the driver, before
 * migrations, because every one of those would otherwise fail with something
 * less true — a SQL error about a missing table, when the real answer is that
 * the file is a JPEG somebody renamed.
 */

/**
 * The three Rust can actually tell apart, from SQLite's own error codes.
 *
 * `schema_too_new` is not here and is not Rust's to decide: the expected schema
 * version lives in `packages/core/src/db/schemaVersion.ts` beside the migration
 * registry that checks it, and the webview raises `SchemaTooNewError` with that
 * number already in hand.
 */
/* Every kind `db.rs` can send. `restore_incomplete` and `invalid_shop` stop
   the start before anything is opened -- see `FailureKind` there. */
export type StartupFailureKind = 'corrupt' | 'locked' | 'io' | 'restore_incomplete' | 'invalid_shop'

export interface StartupFailure {
  /** A sentence for a shopkeeper, with the library's own words on the end. */
  message: string
  /** Named, because the next thing anybody does is go and look at the file. */
  dbPath: string
  kind: StartupFailureKind
}

export async function startupStatus(): Promise<StartupFailure | null> {
  try {
    return (await invoke<StartupFailure | null>('startup_status')) ?? null
  } catch {
    /* The command is missing, or there is no Tauri bridge at all. Neither is a
       reason to refuse to start: if the database really is broken the very next
       thing the caller does will fail anyway, and with a worse message than
       this one rather than none at all. Refusing here would turn "this build is
       older than that one" into a till that will not open. */
    return null
  }
}
