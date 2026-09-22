/// Where ShopOS keeps its files, and what a file from the webview is allowed to
/// be called.
///
/// Both live here rather than in `backup.rs` because restore needs the same
/// answers, and two copies of a name validator is how one of them ends up
/// accepting `shop.db-wal`.
use std::path::{Path, PathBuf};

use tauri::Manager;

pub const DB_FILE: &str = "shop.db";

/// Where a named shop's files sit, under the app's own folder.
const SHOPS_DIR: &str = "shops";

/// The switch and the environment variable that name one.
const SHOP_FLAG: &str = "--shop";
const SHOP_ENV: &str = "SHOPOS_SHOP";

/// The longest a slug may be. A directory name, not a display name.
const SLUG_MAX: usize = 40;

/// Which shop this process is running, or `None` for the original one.
///
/// ## Two companies, two databases. Never a `company_id` column
///
/// A second company is a second set of books: its own GSTIN, its own invoice
/// series, its own stock, its own GST returns. Under GST a separate
/// registration is a separate registrant, and nothing about the two is shared.
///
/// So they are separate SQLite files, and `packages/core` never learns the
/// word. `docs/multi-device.md` settled this for the cloud and the argument is
/// stronger here: a `company_id` column would touch all forty-five tables, and
/// every global unique constraint the schema already relies on --
/// `bills.doc_no`, `registers.prefix`, `users.username`, `customers.code`,
/// `product_barcodes.barcode` -- would turn from correct into a cross-company
/// collision. A separate file is a wrong connection string away; a shared
/// schema is one forgotten `WHERE` away, and only one of those is easy to
/// prove you have not done.
///
/// ## The default must not move
///
/// **`None` resolves to exactly the folder this app has always used.** Every
/// till already in the field has its database there, and a build that started
/// looking one directory deeper would find nothing, conclude it was a new
/// machine, and bootstrap an empty shop over the top of a working one --
/// `host-contract.md` calls that "the single most expensive mistake available
/// to a new host, and it looks like it worked".
///
/// A named shop, and only a named shop, goes in a sub-folder. So this feature
/// cannot affect anybody who does not ask for it.
///
/// ## Why a launch switch rather than a picker that restarts
///
/// Two instances can run at once, one per company, which is what a counter
/// with two businesses on one machine actually needs. A remembered "current
/// shop" would be shared mutable state that two instances fight over, and the
/// loser would open the wrong company's books.
pub fn shop_slug() -> Option<String> {
    let from_args = std::env::args()
        .skip_while(|a| a != SHOP_FLAG)
        .nth(1)
        .or_else(|| {
            std::env::args().find_map(|a| {
                a.strip_prefix(&format!("{SHOP_FLAG}="))
                    .map(str::to_owned)
            })
        });

    let raw = from_args.or_else(|| std::env::var(SHOP_ENV).ok())?;
    slug(&raw)
}

/// A slug that is safe to use as a directory name, or nothing.
///
/// Deliberately a tiny allowlist. This string becomes a path segment, so the
/// question is not "is it tidy" but "can it escape the folder" -- and the only
/// answer worth relying on is a set of characters that cannot. Rejected rather
/// than sanitised: silently turning `../../etc` into `etc` gives somebody a
/// shop they did not ask for, under a name they will not recognise.
pub fn slug(raw: &str) -> Option<String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > SLUG_MAX {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    // `.` is not in the set above, so `.` and `..` cannot reach here; this is
    // belt as well as braces, and it is free.
    if trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed)
}

pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the data folder: {e}"))?;

    match shop_slug() {
        None => Ok(root),
        Some(name) => ensure(root.join(SHOPS_DIR).join(name)),
    }
}

/// The named shops this machine has, for a screen that lists them.
///
/// The original shop is not in here and has no name: it is whatever is in the
/// app folder itself, and giving it one would imply it could be renamed.
pub fn named_shops(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the data folder: {e}"))?
        .join(SHOPS_DIR);

    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut found: Vec<String> = std::fs::read_dir(&root)
        .map_err(|e| format!("Could not read {}: {e}", root.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join(DB_FILE).is_file())
        .filter_map(|entry| entry.file_name().to_str().and_then(slug))
        .collect();

    found.sort();
    Ok(found)
}

fn ensure(dir: PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ensure(data_dir(app)?.join("backups"))
}

/// Photographs and documents kept against a bill or a stock entry. Files are
/// named by their own hash, so the same screenshot pasted onto two bills is one
/// file and a backup carries it once.
pub fn attachments_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ensure(data_dir(app)?.join("attachments"))
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

/// A stored attachment path from the webview, which is only ever
/// `<first two hex>/<sha256>.<ext>` and never anything else.
///
/// The shape is generated by `attachments.rs` and stored in the database, so a
/// value arriving here that does not match it did not come from us. Validated
/// rather than trusted for the same reason as `backup_kind`: these names reach
/// a delete.
pub fn stored_rel(name: &str) -> Option<PathBuf> {
    let (shard, file) = name.split_once('/')?;
    if shard.len() != 2 || !shard.bytes().all(is_lower_hex) {
        return None;
    }
    let (digest, ext) = file.rsplit_once('.')?;
    if digest.len() != 64 || !digest.bytes().all(is_lower_hex) || !digest.starts_with(shard) {
        return None;
    }
    if !matches!(ext, "jpg" | "png" | "webp" | "heic" | "pdf") {
        return None;
    }
    Some(PathBuf::from(shard).join(file))
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

pub fn in_attachments(dir: &Path, name: &str) -> Result<PathBuf, String> {
    match stored_rel(name) {
        Some(rel) => Ok(dir.join(rel)),
        None => Err(format!("\"{name}\" is not an attachment")),
    }
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
    fn an_attachment_path_is_a_hash_and_nothing_else() {
        let good = format!("ab/{}.jpg", "ab".to_string() + &"c".repeat(62));
        assert!(stored_rel(&good).is_some());

        let digest = "ab".to_string() + &"c".repeat(62);
        for name in [
            format!("ab/{digest}.exe"),
            format!("ab/{digest}"),
            // The shard has to be the digest's own first two characters, or a
            // caller could scatter files across folders that never get swept.
            format!("cd/{digest}.jpg"),
            format!("../{digest}.jpg"),
            format!("ab/../../{digest}.jpg"),
            format!("AB/{}.jpg", digest.to_uppercase()),
            format!("ab/{}.jpg", &digest[..10]),
            "shop.db".to_string(),
            String::new(),
        ] {
            assert!(stored_rel(&name).is_none(), "{name} should be refused");
        }
    }

    #[test]
    fn a_refused_name_never_becomes_a_path() {
        let dir = std::path::Path::new("backups");
        assert!(in_backups(dir, "../shop.db").is_err());
        assert!(in_backups(dir, "shop-2026-09-13.zip").is_ok());
    }

    /* ── which company's books this window has open ────────────────────── */

    #[test]
    fn a_shop_name_is_a_directory_name_and_is_treated_like_one() {
        for good in ["acme", "acme-stores", "shop_2", "A1"] {
            assert!(slug(good).is_some(), "{good} should be accepted");
        }

        /* Lower-cased and trimmed, so two desktop shortcuts differing only in
           case or a stray space are one shop -- rather than one shop on a
           case-insensitive filesystem and two on a case-sensitive one, which
           is a difference nobody would find until the books disagreed. */
        assert_eq!(slug("Acme"), Some("acme".to_string()));
        assert_eq!(slug("  acme  "), Some("acme".to_string()));
    }

    #[test]
    fn a_shop_name_that_could_escape_the_folder_is_refused_rather_than_cleaned() {
        /* Rejected, not sanitised. Silently turning `../../etc` into `etc`
           hands somebody a shop they did not ask for, under a name they will
           not recognise -- and the next time, possibly a different one. */
        let bad = [
            "..",
            ".",
            "../other",
            "a/b",
            "a\\b",
            "C:\\shops\\x",
            "sh op",
            "sh.op",
            "",
            "   ",
            "shop;rm",
            "\u{00e9}quipe",
            "shop\u{0000}",
        ];
        for name in bad {
            assert!(slug(name).is_none(), "{name:?} should be refused");
        }
    }

    #[test]
    fn a_shop_name_has_a_length_a_filesystem_will_take() {
        assert!(slug(&"a".repeat(SLUG_MAX)).is_some());
        assert!(slug(&"a".repeat(SLUG_MAX + 1)).is_none());
    }
}
