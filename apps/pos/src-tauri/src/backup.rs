/// Backup files on disk.
///
/// Which backup to take and which to discard is decided in the TypeScript core,
/// where it is tested; this module only does what it is told, and refuses names
/// that are not backup files in the backups folder.
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::archive;
use crate::db::DbState;
use crate::files::{self, Temp};
use crate::paths::{self, DB_FILE};

#[derive(Serialize)]
pub struct BackupFile {
    name: String,
    size: u64,
}

#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupFile>, String> {
    let dir = paths::backups_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        if let Some(name) = entry.file_name().to_str() {
            if paths::backup_kind(name).is_some() {
                files.push(BackupFile { name: name.to_string(), size: meta.len() });
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn backup_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let dir = paths::backups_dir(&app)?;
    Ok(paths::in_backups(&dir, &name)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn backup_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = paths::backups_dir(&app)?;
    paths::remove_if_present(&paths::in_backups(&dir, &name)?)
}

/// Writes an archive: the database, and the photographs attached to it.
///
/// Which photographs is decided by the core, where the window is a rule with a
/// test rather than a number buried in Rust. This end only reads the files it is
/// named and says in the manifest which of them it could not find.
///
/// The vacuumed copy is taken into the work folder first and removed on every
/// path out, including the failures, so a crash cannot leave a temp behind for
/// the next backup to trip over.
///
/// `async`: a VACUUM INTO, a compressor and a full `integrity_check` of what
/// came out are seconds on a shop a few years old, and as a plain command they
/// were seconds of a frozen window.
#[tauri::command(async)]
pub fn backup_write_zip(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    name: String,
    now: String,
    attachments: Vec<String>,
) -> Result<(), String> {
    let dir = paths::backups_dir(&app)?;
    let target = paths::in_backups(&dir, &name)?;
    if !name.ends_with(".zip") {
        return Err(format!("\"{name}\" is not an archive name"));
    }

    let work = paths::work_dir(&app)?;
    let copy = Temp(work.join(DB_FILE));
    paths::remove_if_present(&copy.0)?;
    db.get()?.vacuum_into(&copy.0)?;
    without_peer_secrets(&copy.0)?;

    let version = app.package_info().version.to_string();
    let photos = paths::attachments_dir(&app)?;
    archive::write(&target, &work, &copy.0, &version, &now, &photos, &attachments)
}

/// Copies a backup somewhere the shopkeeper chose — a USB stick, or a folder that
/// a drive client syncs off the machine. That is offsite backup without this
/// program ever opening a network connection.
///
/// Through a `.part` and a rename, flushed first, because the destination is
/// exactly the kind of disk that gets pulled out mid-copy. A plain copy to the
/// final name left a file called `shop-2026-09-13.zip` with half an archive in
/// it, on the one stick the shop keeps for the day the machine dies.
#[tauri::command(async)]
pub fn backup_copy(app: tauri::AppHandle, name: String, destination: String) -> Result<String, String> {
    let dir = paths::backups_dir(&app)?;
    let source = paths::in_backups(&dir, &name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let dest_dir = PathBuf::from(&destination);
    if !dest_dir.is_dir() {
        return Err(format!("{destination} is not a folder"));
    }

    let target = dest_dir.join(&name);
    files::copy_durably(&source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Async so the picker never runs on the UI thread — a modal opened from there
/// deadlocks against the window it is modal to.
#[tauri::command]
pub async fn choose_folder(app: tauri::AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder();
    picked.map(|p| p.to_string())
}

/// The copy that goes into an archive, with the other tills' shared secrets
/// taken out.
///
/// A backup travels: to a USB stick, to a folder a drive client syncs, to
/// wherever the backup hook sends it. `sync_peers.secret` is what lets a
/// machine sign requests as a paired till, and anybody holding an archive could
/// otherwise open it and do exactly that -- write bills into the shop's books
/// from the shop's wifi. This machine's own identity is already kept out of
/// backups (it lives in `device.json`); the secrets it shares are the same kind
/// of thing and now follow it.
///
/// The cost, said plainly: a till restored from an archive has to be paired
/// with its peers again before it syncs. Its books are all there; only the
/// handshake is not.
fn without_peer_secrets(copy: &std::path::Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open(copy).map_err(|e| format!("Could not open the copy: {e}"))?;
    let has_peers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_peers'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_peers > 0 {
        conn.execute("UPDATE sync_peers SET secret = NULL", [])
            .map_err(|e| format!("Could not clear the peer secrets from the copy: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::without_peer_secrets;

    #[test]
    fn a_backup_copy_carries_no_peer_secret() {
        let path = std::env::temp_dir().join(format!("shopos-peers-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sync_peers (device_id TEXT PRIMARY KEY, label TEXT, secret TEXT);
                 INSERT INTO sync_peers VALUES ('a', 'Front', 'deadbeef'), ('b', 'Back', 'cafe');",
            )
            .unwrap();
        }
        without_peer_secrets(&path).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_peers WHERE secret IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM sync_peers", [], |r| r.get(0)).unwrap();
        drop(conn);
        let _ = std::fs::remove_file(&path);
        assert_eq!((left, kept), (0, 2), "the peers stay, their secrets do not");
    }

    #[test]
    fn a_database_without_the_table_is_left_alone() {
        let path = std::env::temp_dir().join(format!("shopos-nopeers-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE t (x)").unwrap();
        assert!(without_peer_secrets(&path).is_ok());
        let _ = std::fs::remove_file(&path);
    }
}
