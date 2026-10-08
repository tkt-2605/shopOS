/// Backup files on disk.
///
/// Which backup to take and which to discard is decided in the TypeScript core,
/// where it is tested; this module only does what it is told, and refuses names
/// that are not backup files in the backups folder.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::archive;
use crate::db::DbState;
use crate::device;
use crate::files::{self, Temp};
use crate::paths::{self, DB_FILE};

#[derive(Serialize)]
pub struct BackupFile {
    name: String,
    size: u64,
}

#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupFile>, String> {
    list_in(&paths::backups_dir(&app)?)
}

/// The files in `dir` whose names ShopOS writes, and nothing else.
fn list_in(dir: &Path) -> Result<Vec<BackupFile>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;

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

/// A plain copy of the database taken before an upgrade touches it: before the
/// migrations run against a database older than this build, and before an
/// update is installed (`update-rollout.md`, step 8).
///
/// A bare `.db` rather than an archive, because it is taken at a moment that
/// must be quick -- the first is on the start path, ahead of everything -- and
/// because what it guards is the database, not the photographs, which an
/// upgrade never touches. Peer secrets come out of it as they do from an
/// archive. Written in the work folder and copied across durably, so a copy
/// that failed half-way never sits in the backups folder looking whole.
#[tauri::command(async)]
pub fn backup_write_safety(app: tauri::AppHandle, db: State<'_, DbState>, name: String) -> Result<(), String> {
    if !(name.starts_with("before-schema-") || name.starts_with("before-update-")) {
        return Err(format!("\"{name}\" is not a name for a copy taken before an upgrade"));
    }
    let dir = paths::backups_dir(&app)?;
    let target = paths::in_backups(&dir, &name)?;

    let work = paths::work_dir(&app)?;
    let copy = Temp(work.join("before-upgrade.db"));
    paths::remove_if_present(&copy.0)?;
    db.get()?.vacuum_into(&copy.0)?;
    without_peer_secrets(&copy.0)?;
    files::copy_durably(&copy.0, &target)
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
    let dest_dir = PathBuf::from(&destination);
    if !dest_dir.is_dir() {
        return Err(format!("{destination} is not a folder"));
    }
    copy_into(&app, &name, &dest_dir)
}

fn copy_into(app: &tauri::AppHandle, name: &str, dest_dir: &Path) -> Result<String, String> {
    let dir = paths::backups_dir(app)?;
    let source = paths::in_backups(&dir, name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let target = dest_dir.join(name);
    files::copy_durably(&source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

// ── The folder every backup is copied to ──────────────────────────────────

/// The device setting that names it. Must match `FOLDER_SETTING` in
/// `apps/pos/src/core/backupFolder.ts`.
const FOLDER_SETTING: &str = "backup_folder";

/// The folder chosen on this machine, read here and never taken from the
/// request -- the same rule as the backup hook. The commands below copy into
/// it and delete from it on a timer, and a delete is exactly the kind of thing
/// a webview must not be able to point somewhere else.
fn chosen_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = device::setting(&paths::data_dir(app)?, FOLDER_SETTING)?
        .map(PathBuf::from)
        .ok_or_else(|| "No folder is chosen to copy backups to.".to_string())?;
    if !dir.is_dir() {
        return Err(format!(
            "{} is not there. A USB stick that is not plugged in, or a Drive or OneDrive \
             folder whose app is not running, looks like this.",
            dir.display()
        ));
    }
    Ok(dir)
}

/// Copies one backup into the chosen folder, as soon as it is written.
///
/// This is what makes the folder an off-site copy rather than a button. Before
/// it, choosing a Google Drive folder meant a copy on the days somebody pressed
/// "Copy out" -- and the setup checklist ticked the step off all the same.
#[tauri::command(async)]
pub fn backup_copy_out(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let dest = chosen_folder(&app)?;
    copy_into(&app, &name, &dest)
}

/// The backups already in the chosen folder, so the core can prune them by the
/// same rule as the ones on this machine. A Drive account fills up, and the
/// copies there are kept for exactly as long as the ones here.
#[tauri::command(async)]
pub fn backup_folder_list(app: tauri::AppHandle) -> Result<Vec<BackupFile>, String> {
    list_in(&chosen_folder(&app)?)
}

/// Removes one daily backup from the chosen folder. Only a daily one: a copy
/// taken before a restore or an upgrade is never copied there, so one found
/// there was put there by a person and is theirs to delete.
#[tauri::command(async)]
pub fn backup_folder_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = chosen_folder(&app)?;
    match paths::backup_kind(&name) {
        Some(paths::Kind::Daily | paths::Kind::DailyZip) => paths::remove_if_present(&dir.join(&name)),
        _ => Err(format!("\"{name}\" is not a daily backup")),
    }
}

/// A folder some sync app already carries off this machine.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CloudFolder {
    /// "Google Drive" or "OneDrive", for the button.
    label: String,
    /// The app's own folder.
    root: String,
    /// Where backups go inside it: a folder of their own, so they are not
    /// loose among the shopkeeper's files.
    target: String,
}

/// The folder backups go to inside a sync app's folder: one per shop, so two
/// companies on one machine do not write the same file name over each other.
fn target_in(root: &Path, shop: Option<&str>) -> PathBuf {
    let base = root.join("ShopOS backups");
    match shop {
        Some(name) => base.join(name),
        None => base,
    }
}

/// Google Drive and OneDrive folders on this machine, if their apps are
/// installed. The setup a shopkeeper can actually do is "install Drive, sign
/// in, press the button", and this is the button.
///
/// Google Drive for desktop shows up as a drive letter (`G:` unless taken)
/// holding `My Drive`; an older install mirrors into the profile. OneDrive
/// says where it is in the environment. Network drives are skipped without
/// being touched, because asking a disconnected one whether a folder exists
/// waits for the network to time out.
#[tauri::command(async)]
pub fn cloud_folders() -> Vec<CloudFolder> {
    let shop = paths::shop_slug().ok().flatten();
    let mut found: Vec<(&str, PathBuf)> = Vec::new();

    for letter in local_drive_letters() {
        found.push(("Google Drive", PathBuf::from(format!("{letter}:\\My Drive"))));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for sub in ["My Drive", "Google Drive"] {
            found.push(("Google Drive", home.join(sub)));
        }
    }
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(dir) = std::env::var_os(var) {
            found.push(("OneDrive", PathBuf::from(dir)));
        }
    }

    let mut out: Vec<CloudFolder> = Vec::new();
    for (label, root) in found {
        if !root.is_dir() {
            continue;
        }
        let root_s = root.to_string_lossy().to_string();
        if out.iter().any(|f| f.root.eq_ignore_ascii_case(&root_s)) {
            continue;
        }
        let target = target_in(&root, shop.as_deref()).to_string_lossy().to_string();
        out.push(CloudFolder { label: label.into(), root: root_s, target });
    }
    out
}

/// Makes the backups folder inside one of the folders `cloud_folders` found,
/// and answers its path for the screen to save.
///
/// Takes the root and matches it against a fresh detection rather than taking
/// a path to create: the webview can choose among the sync folders on this
/// machine, and cannot ask for a directory anywhere else.
#[tauri::command(async)]
pub fn make_cloud_folder(root: String) -> Result<String, String> {
    let found = cloud_folders()
        .into_iter()
        .find(|f| f.root == root)
        .ok_or_else(|| format!("{root} is no longer a Drive or OneDrive folder on this machine"))?;
    std::fs::create_dir_all(&found.target).map_err(|e| format!("Could not create {}: {e}", found.target))?;
    Ok(found.target)
}

/// Drive letters for fixed and removable disks, never network ones. A, B and C
/// are skipped: Drive for desktop never takes them.
#[cfg(windows)]
fn local_drive_letters() -> Vec<char> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    // DRIVE_REMOVABLE and DRIVE_FIXED. Not DRIVE_REMOTE (4) or DRIVE_CDROM (5).
    const LOCAL: [u32; 2] = [2, 3];
    let mask = unsafe { GetLogicalDrives() };
    (3..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| (b'A' + i) as char)
        .filter(|letter| {
            let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(Some(0)).collect();
            LOCAL.contains(&unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) })
        })
        .collect()
}

#[cfg(not(windows))]
fn local_drive_letters() -> Vec<char> {
    Vec::new()
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
    use super::{target_in, without_peer_secrets};

    #[test]
    fn each_shop_gets_its_own_folder_inside_the_drive() {
        let root = std::path::Path::new("G:\\My Drive");
        assert_eq!(target_in(root, None), root.join("ShopOS backups"));
        assert_eq!(target_in(root, Some("raja")), root.join("ShopOS backups").join("raja"));
    }

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
