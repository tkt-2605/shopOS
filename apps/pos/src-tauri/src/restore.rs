/// Putting a backup back.
///
/// The whole design turns on one constraint: on Windows the live database cannot
/// be replaced while anything holds a handle to it, and under WAL it is three
/// files that must move together. So nothing is swapped while the app is running.
/// The chosen backup is staged beside the database, a marker is written, and the
/// app restarts; the replace happens in `setup()` before the database is opened,
/// which is the one moment in the program's life when no handle exists.
///
/// The marker is what makes it safe rather than merely convenient. It is written
/// last and deleting it is the commit, so a machine that loses power in the
/// middle either starts with the old database untouched, or finishes the job on
/// the next start. There is no state in between.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::archive;
use crate::db::DbState;
use crate::paths::{self, DB_FILE};

const MARKER: &str = "RESTORE.json";
const STAGED: &str = "pending.db";

/// Tables only ShopOS creates. A file with none of them is somebody's holiday
/// photographs renamed, not a backup.
const SENTINELS: [&str; 3] = ["bills", "products", "registers"];

fn restore_dir(dir: &Path) -> PathBuf {
    dir.join("restore")
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Marker {
    /// The backup this came from, for the message shown after the restart.
    pub source: String,
    /// Where the pre-restore state was parked, so the owner can undo it.
    pub safety: String,
    pub staged_at: String,
}

/// What the app did with a pending restore while it was starting. Held in state
/// rather than written anywhere, because it is a message for this run only.
#[derive(Serialize, Clone, Default)]
pub struct Report {
    pub restored: Option<Marker>,
    pub error: Option<String>,
}

pub struct LastRestore(pub Report);

// ── Inspecting a candidate ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Check {
    pub name: String,
    pub format: String,
    pub bytes: u64,
    pub schema: i64,
    pub supported: i64,
    pub ok: bool,
    /// Why it cannot be restored at all.
    pub problem: Option<String>,
    /// Something wrong with it that the shopkeeper should decide about rather
    /// than be refused over.
    pub warning: Option<String>,
    pub taken_at: Option<String>,
    /// Submitted bills inside it, and the date of the last one.
    ///
    /// The integrity result answers "is this file broken", which is a question
    /// a shopkeeper did not ask. These answer the one they did: is this the
    /// backup I want. "1,284 bills, last one 14 September" is a thing somebody
    /// can check against what they remember; "integrity_check: ok" is not.
    ///
    /// It also catches the quiet disaster that passes every other check here —
    /// a backup of an empty database. Perfectly sound, perfectly restorable,
    /// and it would wipe the shop.
    pub bills: i64,
    pub last_bill: Option<String>,
}

/// Unpacks a candidate if it needs unpacking, and hands back a plain database
/// file to check. A zip verifies its own CRC on the way out, so a truncated
/// archive fails here rather than after the swap.
fn materialise(source: &Path, into: &Path) -> Result<PathBuf, String> {
    if source.extension().and_then(|e| e.to_str()) == Some("zip") {
        archive::extract_database(source, into)?;
        Ok(into.to_path_buf())
    } else {
        Ok(source.to_path_buf())
    }
}

fn examine(file: &Path, supported: i64) -> Check {
    let mut check = Check {
        name: String::new(),
        format: String::new(),
        bytes: std::fs::metadata(file).map(|m| m.len()).unwrap_or(0),
        schema: 0,
        supported,
        ok: false,
        problem: None,
        warning: None,
        taken_at: None,
        bills: 0,
        last_bill: None,
    };

    let conn = match Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => {
            check.problem = Some(format!("That file is not a database ShopOS can open ({e})."));
            return check;
        }
    };

    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(result) if result == "ok" => {}
        Ok(result) => {
            check.problem = Some(format!("That backup is damaged: {result}"));
            return check;
        }
        Err(e) => {
            check.problem = Some(format!("That backup could not be checked ({e})."));
            return check;
        }
    }

    let all_present = SENTINELS.iter().all(|t| {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [t],
            |_| Ok(()),
        )
        .is_ok()
    });
    if !all_present {
        check.problem = Some("That file is a database, but not a ShopOS one.".into());
        return check;
    }

    check.schema = conn
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0);

    if check.schema > supported {
        check.problem = Some(format!(
            "That backup was written by a newer ShopOS (schema {}; this one understands {}). Update ShopOS before restoring it.",
            check.schema, supported
        ));
        return check;
    }
    if check.schema == 0 {
        check.problem = Some(
            "That backup has ShopOS tables but no schema version, so there is no safe way to tell which upgrades it has already had."
                .into(),
        );
        return check;
    }

    // VACUUM INTO does not validate foreign keys, so a backup taken from an
    // already-damaged database passes integrity_check and fails this. Refusing
    // outright would deny a shopkeeper the only copy they have, so it asks.
    if let Ok(mut stmt) = conn.prepare("PRAGMA foreign_key_check") {
        if let Ok(rows) = stmt.query_map([], |_| Ok(())) {
            let broken = rows.count();
            if broken > 0 {
                check.warning = Some(format!(
                    "{broken} row(s) in that backup point at something that is no longer there. It will restore, but those records may read oddly."
                ));
            }
        }
    }

    /* After the sentinel check, so `bills` is known to exist. Failures here are
       not failures of the backup: a schema old enough to have called this table
       something else still restores, and saying nothing about the count is
       better than refusing over it. */
    if let Ok((n, last)) = conn.query_row(
        "SELECT COUNT(*), MAX(posting_date) FROM bills WHERE docstatus = 1",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
    ) {
        check.bills = n;
        check.last_bill = last;
    }

    /* Sound, restorable, and empty. Every check above passes on a database with
       no rows in it, and restoring one over a working shop erases the shop. It
       is a warning rather than a refusal because there is one honest reason to
       see it -- a till that was backed up on the day it was set up -- and the
       shopkeeper is the only one who can tell that from the other reason. */
    if check.bills == 0 && check.warning.is_none() {
        check.warning = Some(
            "That backup has no bills in it at all. If this till has been trading, it is not the backup you want -- restoring it would leave you with an empty shop."
                .into(),
        );
    }

    check.ok = true;
    check
}

#[tauri::command]
pub fn restore_inspect(app: tauri::AppHandle, name: String, supported: i64) -> Result<Check, String> {
    let backups = paths::backups_dir(&app)?;
    let source = paths::in_backups(&backups, &name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let work = paths::work_dir(&app)?;
    let scratch = archive::Temp(work.join("inspect.db"));
    paths::remove_if_present(&scratch.0)?;

    let file = materialise(&source, &scratch.0)?;
    let mut check = examine(&file, supported);
    check.name = name.clone();
    check.format = if name.ends_with(".zip") { "zip".into() } else { "db".into() };
    // The size worth showing is the backup's own, not the database unpacked out
    // of it.
    check.bytes = std::fs::metadata(&source).map(|m| m.len()).unwrap_or(check.bytes);
    check.taken_at = archive::read_manifest(&source)
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("taken_at").and_then(|t| t.as_str().map(str::to_owned)));

    Ok(check)
}

// ── Staging one, and finishing it on the next start ────────────────────────

/// Validates, parks a copy of the current data, stages the replacement and
/// restarts. Everything before the marker is written is undone by doing nothing;
/// everything after it is finished by the next start.
#[tauri::command]
pub fn restore_begin(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    name: String,
    safety_name: String,
    now: String,
    supported: i64,
) -> Result<(), String> {
    if db.get()?.has_open_transaction() {
        return Err("A bill is being saved right now. Try again in a moment.".into());
    }

    let dir = paths::data_dir(&app)?;
    let backups = paths::backups_dir(&app)?;
    let source = paths::in_backups(&backups, &name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }
    let safety_path = paths::in_backups(&backups, &safety_name)?;

    let work = paths::work_dir(&app)?;
    let staging = restore_dir(&dir);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Could not create {}: {e}", staging.display()))?;

    let staged = staging.join(STAGED);
    paths::remove_if_present(&staged)?;

    let scratch = archive::Temp(work.join("restore.db"));
    paths::remove_if_present(&scratch.0)?;
    let candidate = materialise(&source, &scratch.0)?;

    // Checked here as well as in the dialog. The file could have changed since,
    // and this is the call that actually destroys something.
    let check = examine(&candidate, supported);
    if !check.ok {
        return Err(check.problem.unwrap_or_else(|| "That backup cannot be restored.".into()));
    }

    // The pre-restore copy is itself a VACUUM INTO, not a file copy: under WAL
    // the main file alone is stale by whatever the log still holds, and this is
    // the only copy the owner has if the restore turns out to be the wrong one.
    paths::remove_if_present(&safety_path)?;
    db.get()?.vacuum_into(&safety_path)?;

    // Photographs go in before the database, and outside the marker, because they
    // are content-addressed and additive: writing them twice is the same as
    // writing them once, and a set that only half arrived is a subset rather than
    // a corruption. The database landing last is what makes the marker
    // unambiguous — it means "the swap has not happened yet".
    if source.extension().and_then(|e| e.to_str()) == Some("zip") {
        let photos = paths::attachments_dir(&app)?;
        archive::extract_attachments(&source, &photos)?;
    }

    std::fs::copy(&candidate, &staged).map_err(|e| format!("Could not stage the restore: {e}"))?;

    let marker = Marker { source: name, safety: safety_name, staged_at: now };
    let json = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    // Written last. Until this exists, nothing above has changed the live data.
    std::fs::write(staging.join(MARKER), json)
        .map_err(|e| format!("Could not record the restore: {e}"))?;

    drop(scratch);
    app.restart()
}

/// Finishes a staged restore. Called from `setup()` before the database is
/// opened — the one point in the program with no handle on it.
pub fn apply_pending(dir: &Path) -> Report {
    let staging = restore_dir(dir);

    let Ok(text) = std::fs::read_to_string(staging.join(MARKER)) else {
        // No marker means nothing was ever committed, so whatever else is in
        // there is rubbish from an abandoned attempt.
        if staging.exists() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        return Report::default();
    };

    let marker: Marker = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Report {
                restored: None,
                error: Some(format!(
                    "A restore was interrupted and could not be finished ({e}). Nothing was changed."
                )),
            };
        }
    };

    let staged = staging.join(STAGED);
    if !staged.exists() {
        let _ = std::fs::remove_dir_all(&staging);
        return Report {
            restored: None,
            error: Some(
                "A restore was interrupted before the backup was ready. Nothing was changed.".into(),
            ),
        };
    }

    // The write-ahead log and the shared-memory file belong to the database being
    // replaced. Leaving either beside a different database corrupts it.
    for suffix in ["", "-wal", "-shm"] {
        let path = dir.join(format!("{DB_FILE}{suffix}"));
        if let Err(e) = paths::remove_if_present(&path) {
            return Report {
                restored: None,
                error: Some(format!(
                    "{e} — the restore has not been applied. Close anything else using ShopOS and start it again."
                )),
            };
        }
    }

    if let Err(e) = std::fs::rename(&staged, dir.join(DB_FILE)) {
        return Report {
            restored: None,
            error: Some(format!(
                "The backup could not be put in place ({e}). Your data from before the restore is in your backups as {}.",
                marker.safety
            )),
        };
    }

    // Deleting the marker is the commit.
    let _ = std::fs::remove_dir_all(&staging);
    Report { restored: Some(marker), error: None }
}

/// What happened on the way in, so the Settings screen can say so.
#[tauri::command]
pub fn restore_report(state: State<'_, LastRestore>) -> Report {
    state.0.clone()
}

/// Throws away a staged restore that has not been applied yet. Reachable from
/// the failure screen, which is where someone who staged the wrong file lands.
#[tauri::command]
pub fn restore_abandon(app: tauri::AppHandle) -> Result<(), String> {
    let staging = restore_dir(&paths::data_dir(&app)?);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data directory with a live database and its write-ahead log beside it,
    /// which is the shape restore actually has to deal with.
    fn a_shop(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-restore-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DB_FILE), b"the live database").unwrap();
        std::fs::write(dir.join(format!("{DB_FILE}-wal")), b"log").unwrap();
        std::fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm").unwrap();
        dir
    }

    fn stage(dir: &Path, contents: &[u8], marker: bool) {
        let staging = restore_dir(dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join(STAGED), contents).unwrap();
        if marker {
            let m = Marker {
                source: "shop-2026-09-12.zip".into(),
                safety: "before-restore-2026-09-13-0905.db".into(),
                staged_at: "2026-09-13T09:05:00Z".into(),
            };
            std::fs::write(staging.join(MARKER), serde_json::to_vec(&m).unwrap()).unwrap();
        }
    }

    #[test]
    fn an_ordinary_start_does_nothing() {
        let dir = a_shop("ordinary");
        let report = apply_pending(&dir);
        assert!(report.restored.is_none() && report.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
    }

    #[test]
    fn a_staged_restore_replaces_the_database_and_clears_the_log() {
        let dir = a_shop("staged");
        stage(&dir, b"the backup", true);

        let report = apply_pending(&dir);
        assert!(report.error.is_none());
        assert_eq!(report.restored.unwrap().source, "shop-2026-09-12.zip");
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
        // A write-ahead log belonging to the replaced database would corrupt the
        // one that took its place.
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
        assert!(!restore_dir(&dir).exists());
    }

    /* The marker is written last, so a crash before it must leave the shop
       exactly as it was. */
    #[test]
    fn a_crash_before_the_marker_changes_nothing() {
        let dir = a_shop("no-marker");
        stage(&dir, b"the backup", false);

        let report = apply_pending(&dir);
        assert!(report.restored.is_none() && report.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(!restore_dir(&dir).exists());
    }

    #[test]
    fn a_marker_with_nothing_staged_refuses_rather_than_guessing() {
        let dir = a_shop("marker-only");
        stage(&dir, b"", true);
        std::fs::remove_file(restore_dir(&dir).join(STAGED)).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(!restore_dir(&dir).exists());
    }

    #[test]
    fn an_unreadable_marker_changes_nothing() {
        let dir = a_shop("bad-marker");
        stage(&dir, b"the backup", true);
        std::fs::write(restore_dir(&dir).join(MARKER), b"{ not json").unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
    }

    /* The whole point of the marker: finishing the job is idempotent, so a
       machine that loses power mid-restore finishes it on the next start and a
       machine that finishes it does not repeat it. */
    #[test]
    fn applying_twice_is_the_same_as_applying_once() {
        let dir = a_shop("twice");
        stage(&dir, b"the backup", true);

        assert!(apply_pending(&dir).restored.is_some());
        let again = apply_pending(&dir);
        assert!(again.restored.is_none() && again.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
    }

    // ── The whole way round, with a real database ──────────────────────────

    /// A shop with bills in it, as a database rather than as the word "backup".
    fn a_shop_that_has_been_trading(path: &Path, bills: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE bills (id TEXT PRIMARY KEY, docstatus INTEGER, posting_date TEXT);
             CREATE TABLE bill_items (id TEXT PRIMARY KEY);
             CREATE TABLE products (id TEXT PRIMARY KEY);
             CREATE TABLE registers (id TEXT PRIMARY KEY);
             CREATE TABLE users (id TEXT PRIMARY KEY);
             PRAGMA user_version = 33;",
        )
        .unwrap();
        for i in 1..=bills {
            conn.execute(
                "INSERT INTO bills (id, docstatus, posting_date) VALUES (?1, 1, ?2)",
                rusqlite::params![format!("bill-{i}"), format!("2026-09-{:02}", (i % 28) + 1)],
            )
            .unwrap();
        }
    }

    /// Backup to restored shop, without stubs anywhere in the middle.
    ///
    /// Every other test here uses the bytes "the backup" and proves the file
    /// dance — which is the part most likely to go wrong, and not the part a
    /// shopkeeper is trusting. This one writes a real archive from a real
    /// database, checks it the way the Backups card does, stages it, applies it
    /// the way `setup()` does, and then opens what came out and counts the
    /// bills. If any link in that chain stopped working, nothing else in this
    /// file would notice.
    #[test]
    fn a_backup_becomes_a_working_shop_again() {
        let dir = a_shop("end-to-end");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();

        let source = work.join("source.db");
        a_shop_that_has_been_trading(&source, 12);

        let zip = dir.join("shop-2026-09-16.zip");
        archive::write(&zip, &work, &source, "0.1.0", "2026-09-16T03:00:00Z", &work, &[]).unwrap();

        // What "Check this backup" shows, before anything is replaced.
        let unpacked = work.join("inspect.db");
        let file = materialise(&zip, &unpacked).unwrap();
        let check = examine(&file, 33);
        assert!(check.ok, "the archive we just wrote must inspect cleanly: {:?}", check.problem);
        assert_eq!(check.bills, 12);
        assert_eq!(check.schema, 33);
        assert!(check.last_bill.is_some());

        // Stage it the way `restore_begin` does, then finish it the way the next
        // start does.
        let staged = work.join("staged.db");
        archive::extract_database(&zip, &staged).unwrap();
        let staging = restore_dir(&dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::rename(&staged, staging.join(STAGED)).unwrap();
        let marker = Marker {
            source: "shop-2026-09-16.zip".into(),
            safety: "before-restore-2026-09-16-0905.db".into(),
            staged_at: "2026-09-16T09:05:00Z".into(),
        };
        std::fs::write(staging.join(MARKER), serde_json::to_vec(&marker).unwrap()).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_none(), "{:?}", report.error);
        assert!(report.restored.is_some());

        /* The point of the whole exercise: open what is now the shop's database
           and find the shop in it. */
        let live = Connection::open_with_flags(dir.join(DB_FILE), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let count: i64 = live
            .query_row("SELECT COUNT(*) FROM bills WHERE docstatus = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 12, "every bill that went into the backup has to come out of it");

        let version: i64 = live.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 33, "restoring must not lose which migrations have run");

        // And the replaced database's log is gone, or it would corrupt this one.
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
    }

    /// Sound, restorable, and empty — which every other check passes.
    #[test]
    fn a_backup_with_no_bills_in_it_says_so_before_it_is_restored() {
        let dir = a_shop("empty-backup");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();

        let source = work.join("empty.db");
        a_shop_that_has_been_trading(&source, 0);

        let check = examine(&source, 33);

        /* Not a refusal: a till backed up on the day it was set up honestly has
           no bills, and only the shopkeeper can tell that from the other case.
           But restoring this over a trading shop erases the shop, so it cannot
           pass in silence. */
        assert!(check.ok);
        assert_eq!(check.bills, 0);
        let said = check.warning.expect("an empty backup must warn");
        assert!(said.contains("no bills"), "{said}");
        assert!(said.contains("empty shop"), "{said}");
    }
}
