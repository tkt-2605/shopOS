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
use crate::db::Db;
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
    db: State<'_, Db>,
    name: String,
    safety_name: String,
    now: String,
    supported: i64,
) -> Result<(), String> {
    if db.has_open_transaction() {
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
    db.vacuum_into(&safety_path)?;

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
}
