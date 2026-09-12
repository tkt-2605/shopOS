/// Where ShopOS keeps its files, and what a file from the webview is allowed to
/// be called.
///
/// Both live here rather than in `backup.rs` because restore needs the same
/// answers, and two copies of a name validator is how one of them ends up
/// accepting `shop.db-wal`.
use std::path::{Path, PathBuf};

use tauri::Manager;

pub const DB_FILE: &str = "shop.db";

pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the data folder: {e}"))
}

fn ensure(dir: PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ensure(data_dir(app)?.join("backups"))
}

/// Half-written files live here and nowhere else, so that clearing up after a
/// crash is one directory rather than a pattern match over the backups folder.
pub fn work_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ensure(data_dir(app)?.join("work"))
}

/// Removes whatever a previous run left behind. Called at startup, before
/// anything opens the database: VACUUM INTO refuses a target that already
/// exists, so a leftover temp would break the *next* backup rather than the one
/// that actually failed.
pub fn sweep_work_dir(dir: &Path) {
    let work = dir.join("work");
    if work.exists() {
        let _ = std::fs::remove_dir_all(&work);
    }
}

/// Deletes a file, and says so only when the file was there and would not go.
pub fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove {}: {e}", path.display())),
    }
}

/// A name from the webview names a file in a known folder, never a path.
///
/// The allow-list is exactly three shapes, and it is an allow-list rather than a
/// "no separators" check because relaxing the extension would let the webview
/// name `shop.db-wal` and have a backup command delete the live write-ahead log.
pub fn backup_kind(name: &str) -> Option<Kind> {
    if let Some(rest) = name.strip_prefix("shop-") {
        if let Some(date) = rest.strip_suffix(".db") {
            return is_date(date).then_some(Kind::Daily);
        }
        if let Some(date) = rest.strip_suffix(".zip") {
            return is_date(date).then_some(Kind::DailyZip);
        }
        return None;
    }
    if let Some(rest) = name.strip_prefix("before-restore-") {
        if let Some(stamp) = rest.strip_suffix(".db") {
            // yyyy-mm-dd-hhmm
            let (date, time) = stamp.split_at(stamp.len().min(10));
            return (is_date(date) && time.len() == 5 && time.starts_with('-')
                && time[1..].bytes().all(|b| b.is_ascii_digit()))
                .then_some(Kind::Safety);
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Daily,
    DailyZip,
    Safety,
}

fn is_date(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s.bytes().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

pub fn in_backups(dir: &Path, name: &str) -> Result<PathBuf, String> {
    match backup_kind(name) {
        Some(_) => Ok(dir.join(name)),
        None => Err(format!("\"{name}\" is not a backup file name")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allow-list is a boundary, not a convenience: everything here is a name
    /// the webview could send if something above it went wrong.
    #[test]
    fn accepts_only_the_three_shapes() {
        assert!(backup_kind("shop-2026-09-13.db").is_some());
        assert!(backup_kind("shop-2026-09-13.zip").is_some());
        assert!(backup_kind("before-restore-2026-09-13-0905.db").is_some());
    }

    #[test]
    fn refuses_anything_that_could_reach_the_live_database() {
        for name in [
            "shop.db",
            "shop.db-wal",
            "shop-2026-09-13.db-wal",
            "shop-2026-09-13.db-shm",
            "shop-2026-09-13.exe",
            "../shop.db",
            r"..\shop.db",
            "backups/shop-2026-09-13.db",
            r"C:\shop-2026-09-13.db",
            "shop-2026-9-13.db",
            "shop-2026-09-13.DB",
            "before-restore-2026-09-13.db",
            "before-restore-2026-09-13-09xx.db",
            "",
        ] {
            assert!(backup_kind(name).is_none(), "{name} should be refused");
        }
    }

    #[test]
    fn a_refused_name_never_becomes_a_path() {
        let dir = std::path::Path::new("backups");
        assert!(in_backups(dir, "../shop.db").is_err());
        assert!(in_backups(dir, "shop-2026-09-13.zip").is_ok());
    }
}
