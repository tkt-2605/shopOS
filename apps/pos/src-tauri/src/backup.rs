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
#[tauri::command]
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
    let copy = archive::Temp(work.join(DB_FILE));
    paths::remove_if_present(&copy.0)?;
    db.get()?.vacuum_into(&copy.0)?;

    let version = app.package_info().version.to_string();
    let photos = paths::attachments_dir(&app)?;
    archive::write(&target, &work, &copy.0, &version, &now, &photos, &attachments)
}

/// Copies a backup somewhere the shopkeeper chose — a USB stick, or a folder that
/// a drive client syncs off the machine. That is offsite backup without this
/// program ever opening a network connection.
#[tauri::command]
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
    std::fs::copy(&source, &target).map_err(|e| format!("Could not copy to {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/// Async so the picker never runs on the UI thread — a modal opened from there
/// deadlocks against the window it is modal to.
#[tauri::command]
pub async fn choose_folder(app: tauri::AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder();
    picked.map(|p| p.to_string())
}
