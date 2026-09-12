/// Backup files on disk.
///
/// Which backup to take and which to discard is decided in the TypeScript core,
/// where it is tested; this module only does what it is told, and refuses names
/// that are not plain files in the backups folder.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct BackupFile {
    name: String,
    size: u64,
}

fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the data folder: {e}"))?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A name from the webview names a file, never a path. Anything with a separator
/// or a parent reference would let a bug elsewhere write outside the folder.
fn in_dir(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || name.starts_with('.')
        || !name.ends_with(".db")
    {
        return Err(format!("\"{name}\" is not a backup file name"));
    }
    Ok(dir.join(name))
}

#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupFile>, String> {
    let dir = backups_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        if let Some(name) = entry.file_name().to_str() {
            if name.ends_with(".db") {
                files.push(BackupFile { name: name.to_string(), size: meta.len() });
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn backup_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let dir = backups_dir(&app)?;
    Ok(in_dir(&dir, &name)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn backup_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = backups_dir(&app)?;
    let path = in_dir(&dir, &name)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Could not remove {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Copies a backup somewhere the shopkeeper chose — a USB stick, or a folder that
/// a drive client syncs off the machine. That is offsite backup without this
/// program ever opening a network connection.
#[tauri::command]
pub fn backup_copy(app: tauri::AppHandle, name: String, destination: String) -> Result<String, String> {
    let dir = backups_dir(&app)?;
    let source = in_dir(&dir, &name)?;
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
