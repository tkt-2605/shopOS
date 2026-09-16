//! Everything a person needs to work out what went wrong, in one file a
//! shopkeeper can send.
//!
//! The shape of the problem: the shop is in Tiruchengode, the developer is not,
//! and the thing that went wrong happened four hours ago on a machine nobody
//! can reach. Asking a shopkeeper to find a log folder, read a version number
//! off a screen and describe what the database is doing is asking them to do a
//! developer's job over a phone line while customers wait.
//!
//! So: one button, one zip, sent over WhatsApp.
//!
//! ## It is designed to leave the building
//!
//! That is the whole point of it and it is also the danger. This file is going
//! to be attached to a message and forwarded to somebody, and once it has been
//! sent it cannot be unsent. Everything in here is chosen on the assumption
//! that it will end up somewhere the shop did not intend.
//!
//! Which is why the redaction is an **allowlist**. A denylist — "strip
//! `backup_hook`" — is correct today and silently wrong the day somebody adds
//! `cloud_token` to `DEVICE_LOCAL_KEYS` and does not think about this file. An
//! allowlist fails the other way: a new setting is withheld until a person
//! decides it is safe, and the worst outcome is a diagnostic that is slightly
//! less useful than it could have been.
//!
//! What is deliberately never read at all, rather than read and redacted:
//! `users.password_hash` and `sync_peers.secret`. A value that is never loaded
//! cannot be leaked by a formatting mistake later.
//!
//! Upload is Phase 6 and needs consent. This stays on the machine until a
//! person picks a folder and sends it themselves.

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value as Json};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::db::DbState;
use crate::paths::{self, DB_FILE};

/// Device settings whose values are safe to read in full.
///
/// Everything not on this list is reported as set-or-not with its length, which
/// is enough to answer "is a hook configured and roughly how long is it"
/// without carrying the value itself.
const SAFE_SETTINGS: [&str; 6] = [
    "thermal_printer",
    "backup_folder",
    "ui_density",
    "ui_theme",
    // When this machine last replayed the stock ledger, and what it found.
    // A date and a count; the sort of thing a support call opens with.
    "stock_checked_at",
    "stock_drift",
];

/// Audit rows carried. Enough to cover the morning a problem appeared, small
/// enough to stay sendable over a phone connection.
const AUDIT_ROWS: usize = 200;

#[derive(Serialize)]
struct Report {
    generated_at: String,
    app_version: String,
    schema_version: Option<i64>,
    os: String,
    database: DbFacts,
    device: Json,
    backups: Vec<BackupFile>,
    peers: Vec<Peer>,
    counts: Map<String, Json>,
    /// Anything that could not be collected, named rather than left as a gap.
    /// A bundle with three holes in it and a note saying so beats a bundle that
    /// quietly stops halfway.
    problems: Vec<String>,
}

#[derive(Serialize, Default)]
struct DbFacts {
    bytes: u64,
    journal_mode: Option<String>,
    synchronous: Option<i64>,
    page_count: Option<i64>,
    freelist_count: Option<i64>,
    page_size: Option<i64>,
    /// Whether a transaction was open when this was taken, which is worth
    /// knowing if the report was made because the till had stopped responding.
    transaction_open: bool,
}

#[derive(Serialize)]
struct BackupFile {
    name: String,
    bytes: u64,
}

/// What is in the backups folder, by name and size.
///
/// No contents and no paths outside the folder: the names carry their own dates
/// and the sizes say whether a run produced a real file or an empty one, which
/// between them answer "has this shop been backing up" without shipping any of
/// the shop's data inside a file meant for a developer.
fn list_backups(data: &Path) -> Vec<BackupFile> {
    let Ok(entries) = std::fs::read_dir(data.join("backups")) else {
        return Vec::new();
    };
    let mut files: Vec<BackupFile> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(BackupFile {
                name: e.file_name().to_str()?.to_string(),
                bytes: meta.len(),
            })
        })
        .collect();
    files.sort_by(|a, b| b.name.cmp(&a.name));
    files
}

/// A paired till, without the thing that makes it paired.
///
/// `sync_peers.secret` is not selected. It is the credential two tills
/// authenticate with, and a bundle that carried it would let anybody holding
/// the message impersonate a counter.
#[derive(Serialize)]
struct Peer {
    device_id: String,
    label: Option<String>,
    last_seen_at: Option<String>,
    last_error: Option<String>,
}

/// Writes the bundle into `destination` and returns the path it wrote.
#[tauri::command]
pub fn diagnostics_bundle(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    destination: String,
    now: String,
) -> Result<String, String> {
    let data = paths::data_dir(&app)?;
    let version = app.package_info().version.to_string();
    build(&data, Path::new(&destination), &now, &version, db.get().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// The whole of it, in terms of paths rather than a running app.
///
/// Split out so the finished zip can be opened in a test and checked for the
/// thing it must never contain. The phase asks for that to be done by hand
/// once; a test does it on every run, and the failure it guards against — a
/// token reaching a file the shop is about to forward — is not one to find out
/// about by inspection.
pub fn build(
    data: &Path,
    dir: &Path,
    now: &str,
    app_version: &str,
    db: Option<&crate::db::Db>,
) -> Result<PathBuf, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }

    let mut problems: Vec<String> = Vec::new();

    let mut report = Report {
        generated_at: now.to_string(),
        app_version: app_version.to_string(),
        schema_version: None,
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        database: DbFacts::default(),
        device: redacted_device(data, &mut problems),
        backups: list_backups(data),
        peers: Vec::new(),
        counts: Map::new(),
        problems: Vec::new(),
    };
    let mut audit = Vec::new();

    /* The database half is skipped rather than fatal. The most likely reason
       somebody is making one of these is that the database would not open, and
       a bundle that refuses to be made in exactly that case is useless. */
    match db {
        Some(handle) => {
            let open = handle.has_open_transaction();
            match handle.read_with(|conn| collect(conn, open)) {
                Ok((facts, schema, peers, counts, rows)) => {
                    report.database = facts;
                    report.schema_version = schema;
                    report.peers = peers;
                    report.counts = counts;
                    audit = rows;
                }
                Err(e) => problems.push(format!("Could not read the database: {e}")),
            }
        }
        None => problems.push("The database is not open on this machine.".into()),
    }
    report.database.bytes = std::fs::metadata(data.join(DB_FILE)).map(|m| m.len()).unwrap_or(0);
    report.problems = problems;

    // ── write it ──────────────────────────────────────────────────────────
    let name = format!("shopos-diagnostics-{}.zip", stamp_for_name(now));
    let target = dir.join(&name);
    let file = std::fs::File::create(&target)
        .map_err(|e| format!("Could not create {}: {e}", target.display()))?;
    let mut zip = zip::ZipWriter::new(file);

    let report_json = serde_json::to_vec_pretty(&report)
        .map_err(|e| format!("Could not write the report: {e}"))?;
    add(&mut zip, "report.json", &report_json)?;

    let audit_json = serde_json::to_vec_pretty(&audit)
        .map_err(|e| format!("Could not write the history: {e}"))?;
    add(&mut zip, "audit.json", &audit_json)?;

    for path in crate::log::log_paths(data) {
        let Some(base) = path.file_name().and_then(|n| n.to_str()) else { continue };
        match std::fs::read(&path) {
            Ok(bytes) => add(&mut zip, &format!("logs/{base}"), &bytes)?,
            Err(e) => {
                let note = format!("Could not read {base}: {e}");
                add(&mut zip, &format!("logs/{base}.missing.txt"), note.as_bytes())?;
            }
        }
    }

    zip.finish().map_err(|e| format!("Could not finish the bundle: {e}"))?;
    Ok(target)
}

type Collected = (DbFacts, Option<i64>, Vec<Peer>, Map<String, Json>, Vec<Json>);

fn collect(conn: &Connection, transaction_open: bool) -> Collected {
    let text = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, String>(0)).ok();
    let int = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).ok();

    let facts = DbFacts {
        bytes: 0, // filled in by the caller, which can see the file
        journal_mode: text("PRAGMA journal_mode"),
        synchronous: int("PRAGMA synchronous"),
        page_count: int("PRAGMA page_count"),
        freelist_count: int("PRAGMA freelist_count"),
        page_size: int("PRAGMA page_size"),
        transaction_open,
    };

    let mut counts = Map::new();
    for table in ["bills", "bill_items", "products", "customers", "sales_returns", "audit_log"] {
        if let Some(n) = int(&format!("SELECT COUNT(*) FROM {table}")) {
            counts.insert(table.to_string(), json!(n));
        }
    }

    (
        facts,
        int("PRAGMA user_version"),
        peers(conn),
        counts,
        recent_audit(conn),
    )
}

fn peers(conn: &Connection) -> Vec<Peer> {
    // Columns named one by one, never `SELECT *`: `secret` lives in this table
    // and a star would carry it into a file the shop is about to send someone.
    let Ok(mut stmt) = conn.prepare(
        "SELECT device_id, label, last_seen_at, last_error FROM sync_peers ORDER BY device_id",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(Peer {
            device_id: r.get(0)?,
            label: r.get(1).ok(),
            last_seen_at: r.get(2).ok(),
            last_error: r.get(3).ok(),
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

fn recent_audit(conn: &Connection) -> Vec<Json> {
    /* The username rather than the id, because "admin cancelled INV/26-27/0041"
       is a sentence and a UUID is not. `password_hash` is not selected. */
    let sql = format!(
        "SELECT a.at, a.entity, a.entity_id, a.action,
                COALESCE(u.username, a.actor_id) AS actor,
                a.docstatus_from, a.docstatus_to, a.diff
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.at DESC
          LIMIT {AUDIT_ROWS}"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "at": r.get::<_, String>(0)?,
            "entity": r.get::<_, String>(1)?,
            "entity_id": r.get::<_, String>(2)?,
            "action": r.get::<_, String>(3)?,
            "actor": r.get::<_, Option<String>>(4)?,
            "docstatus_from": r.get::<_, Option<i64>>(5)?,
            "docstatus_to": r.get::<_, Option<i64>>(6)?,
            "diff": r.get::<_, Option<String>>(7)?,
        }))
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// `device.json`, with every setting not known to be safe reduced to its shape.
///
/// `backup_hook` is the one that matters today: it is a command line, and a shop
/// following the Settings hint has put an rclone remote in it, which carries a
/// token that grants write access to their cloud drive. The bundle says a hook
/// is configured and how long it is, which is all a support call needs.
pub fn redacted_device(data: &Path, problems: &mut Vec<String>) -> Json {
    let path = data.join("device.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            problems.push(format!("Could not read device.json: {e}"));
            return Json::Null;
        }
    };
    let mut value: Json = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            problems.push(format!("device.json is not readable JSON: {e}"));
            return Json::Null;
        }
    };

    if let Some(settings) = value.get_mut("settings").and_then(|s| s.as_object_mut()) {
        for (key, entry) in settings.iter_mut() {
            if SAFE_SETTINGS.contains(&key.as_str()) {
                continue;
            }
            let shape = match entry.as_str() {
                Some("") | None => "<redacted, empty>".to_string(),
                Some(s) => format!("<redacted, {} characters>", s.chars().count()),
            };
            *entry = Json::String(shape);
        }
    }
    value
}

fn add<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    zip.start_file(
        name,
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .map_err(|e| format!("Could not add {name}: {e}"))?;
    zip.write_all(bytes).map_err(|e| format!("Could not write {name}: {e}"))
}

/// `2026-09-16T17:04:11.000Z` becomes `2026-09-16-1704`.
///
/// A file name a person can sort and read out loud. Anything that is not a
/// digit is dropped rather than translated, so a malformed timestamp produces a
/// short name instead of a path separator.
fn stamp_for_name(iso: &str) -> String {
    let digits: String = iso.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 12 {
        return "unknown".into();
    }
    format!("{}-{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8], &digits[8..12])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-diagnostics-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn a_device_file(dir: &Path, hook: &str) {
        std::fs::write(
            dir.join("device.json"),
            serde_json::to_vec_pretty(&json!({
                "id": "till-one",
                "label": "Front counter",
                "register_id": "reg-1",
                "settings": {
                    "backup_hook": hook,
                    "backup_folder": "D:\\\\backups",
                    "ui_theme": "khata",
                },
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// The one that matters. A shop following the Settings hint has put an
    /// rclone remote in `backup_hook`, and that carries a token with write
    /// access to their cloud drive.
    #[test]
    fn the_rclone_token_never_leaves_the_machine() {
        let dir = scratch("redaction");
        a_device_file(&dir, "rclone copy {file} gdrive:shopos --drive-token=SECRET-TOKEN-1234");

        let mut problems = Vec::new();
        let device = redacted_device(&dir, &mut problems);
        let text = serde_json::to_string(&device).unwrap();

        assert!(!text.contains("SECRET-TOKEN-1234"), "the token is in the bundle: {text}");
        assert!(!text.contains("gdrive"), "the remote is in the bundle: {text}");
        assert!(problems.is_empty());
    }

    /// Redacted, not removed. "Is a hook configured at all" is the first
    /// question when a backup is not reaching the cloud, and a key that
    /// vanished cannot answer it.
    #[test]
    fn it_still_says_a_hook_is_there_and_how_long() {
        let dir = scratch("shape");
        let hook_command = "rclone copy {file} gdrive:x";
        a_device_file(&dir, hook_command);

        let device = redacted_device(&dir, &mut Vec::new());
        let hook = device["settings"]["backup_hook"].as_str().unwrap();

        assert!(hook.starts_with("<redacted"), "{hook}");
        assert!(
            hook.contains(&format!("{} characters", hook_command.chars().count())),
            "{hook}"
        );
    }

    #[test]
    fn an_empty_hook_says_so_rather_than_looking_like_a_secret() {
        let dir = scratch("empty");
        a_device_file(&dir, "");

        let device = redacted_device(&dir, &mut Vec::new());
        assert_eq!(device["settings"]["backup_hook"], "<redacted, empty>");
    }

    /// The settings that are safe stay readable, or the bundle is no use.
    #[test]
    fn the_harmless_settings_are_still_legible() {
        let dir = scratch("safe");
        a_device_file(&dir, "x");

        let device = redacted_device(&dir, &mut Vec::new());
        assert_eq!(device["settings"]["ui_theme"], "khata");
        assert!(device["settings"]["backup_folder"].as_str().unwrap().contains("backups"));
        // And the identity, which is what says which till this report is from.
        assert_eq!(device["label"], "Front counter");
    }

    /// An allowlist, so a setting nobody has thought about is withheld.
    ///
    /// The failure this prevents: somebody adds `cloud_token` to
    /// `DEVICE_LOCAL_KEYS` next year, does not think about this file, and the
    /// bundle starts carrying it. With a denylist that is silent; with this it
    /// is a redaction somebody has to deliberately undo.
    #[test]
    fn a_setting_nobody_has_considered_is_withheld_by_default() {
        let dir = scratch("unknown-key");
        std::fs::write(
            dir.join("device.json"),
            serde_json::to_vec(&json!({
                "settings": { "cloud_token": "ey.a.token.from.the.future" },
            }))
            .unwrap(),
        )
        .unwrap();

        let device = redacted_device(&dir, &mut Vec::new());
        let text = serde_json::to_string(&device).unwrap();
        assert!(!text.contains("ey.a.token"), "{text}");
    }

    #[test]
    fn a_missing_device_file_is_a_note_rather_than_a_failure() {
        let dir = scratch("absent");
        let mut problems = Vec::new();

        /* A bundle with a hole in it and a line saying why beats no bundle.
           The person making one is usually making it because things are already
           broken. */
        assert_eq!(redacted_device(&dir, &mut problems), Json::Null);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("device.json"));
    }

    /// The finished zip, opened and read, which is the check the phase asks a
    /// person to do by hand once.
    ///
    /// Doing it here instead means it happens on every run. The failure it
    /// guards against -- a cloud token reaching a file the shop is about to
    /// forward to somebody -- is not one to find out about by inspection, and
    /// it is one an innocent-looking edit two files away could reintroduce.
    #[test]
    fn the_finished_bundle_carries_no_secret_and_everything_else() {
        let data = scratch("bundle-data");
        let out = scratch("bundle-out");

        a_device_file(&data, "rclone copy {file} gdrive:shopos --token=SECRET-TOKEN-1234");

        std::fs::create_dir_all(data.join("logs")).unwrap();
        std::fs::write(data.join("logs").join("shopos.log"), b"2026-09-16T03:00:00Z INFO backup    wrote it
").unwrap();
        std::fs::create_dir_all(data.join("backups")).unwrap();
        std::fs::write(data.join("backups").join("shop-2026-09-16.zip"), b"pretend").unwrap();

        // A database with a secret in it, so the peer query can be caught
        // carrying one.
        let db = crate::db::Db::open(&data.join(DB_FILE)).unwrap();
        db.read_with(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT);
                 INSERT INTO users VALUES ('u1', 'admin', 'BCRYPT-HASH-SHOULD-NOT-APPEAR');
                 CREATE TABLE sync_peers (device_id TEXT PRIMARY KEY, label TEXT, secret TEXT,
                                          last_seen_at TEXT, last_error TEXT);
                 INSERT INTO sync_peers VALUES ('till-2', 'Back counter', 'PEER-SECRET-SHOULD-NOT-APPEAR', NULL, NULL);
                 CREATE TABLE bills (id TEXT PRIMARY KEY);
                 CREATE TABLE audit_log (id TEXT PRIMARY KEY, entity TEXT, entity_id TEXT,
                                         action TEXT, actor_id TEXT, docstatus_from INTEGER,
                                         docstatus_to INTEGER, diff TEXT, at TEXT);
                 INSERT INTO audit_log VALUES ('a1','bills','b1','cancel','u1',1,2,'{}','2026-09-16T04:00:00Z');
                 PRAGMA user_version = 33;",
            )
            .unwrap();
        })
        .unwrap();

        let written = build(&data, &out, "2026-09-16T17:04:11.000Z", "0.4.0", Some(&db)).unwrap();
        assert!(written.exists());

        // Read every entry back out, exactly as whoever receives it would.
        let file = std::fs::File::open(&written).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut names = Vec::new();
        let mut all = String::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).unwrap();
            names.push(entry.name().to_string());
            let mut text = String::new();
            use std::io::Read;
            let _ = entry.read_to_string(&mut text);
            all.push_str(&text);
        }

        // ── the three things that must never be in it ──────────────────────
        assert!(!all.contains("SECRET-TOKEN-1234"), "the rclone token is in the bundle");
        assert!(!all.contains("PEER-SECRET-SHOULD-NOT-APPEAR"), "a peer secret is in the bundle");
        assert!(!all.contains("BCRYPT-HASH-SHOULD-NOT-APPEAR"), "a password hash is in the bundle");

        // ── and the things that must ───────────────────────────────────────
        assert!(names.iter().any(|n| n == "report.json"), "{names:?}");
        assert!(names.iter().any(|n| n == "audit.json"), "{names:?}");
        assert!(names.iter().any(|n| n == "logs/shopos.log"), "{names:?}");
        assert!(all.contains("0.4.0"), "the version has to be in it");
        assert!(all.contains("\"schema_version\": 33"), "the schema version has to be in it");
        assert!(all.contains("wrote it"), "the log contents have to be in it");
        assert!(all.contains("shop-2026-09-16.zip"), "the backups listing has to be in it");
        // The peer is still reported -- redacted means without its secret, not
        // missing, or "are these two tills paired at all" has no answer.
        assert!(all.contains("Back counter"), "the peer has to be listed");
        assert!(all.contains("<redacted"), "the hook has to be shown as set");

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&out);
    }

    /// The bundle is most wanted when the database will not open.
    #[test]
    fn it_is_still_written_when_there_is_no_database() {
        let data = scratch("bundle-nodb");
        let out = scratch("bundle-nodb-out");
        std::fs::create_dir_all(data.join("logs")).unwrap();

        let written = build(&data, &out, "2026-09-16T17:04:11.000Z", "0.4.0", None).unwrap();

        let file = std::fs::File::open(&written).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut report = String::new();
        use std::io::Read;
        zip.by_name("report.json").unwrap().read_to_string(&mut report).unwrap();

        /* A hole with a line saying why, rather than no bundle. Refusing to
           make one in exactly the case it is most needed would be absurd. */
        assert!(report.contains("The database is not open"), "{report}");
        assert!(report.contains("0.4.0"));

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn the_file_name_sorts_and_can_be_read_aloud() {
        assert_eq!(stamp_for_name("2026-09-16T17:04:11.000Z"), "2026-09-16-1704");
        // Nothing that is not a digit survives, so no separator can get in.
        assert_eq!(stamp_for_name("../../etc"), "unknown");
        assert_eq!(stamp_for_name(""), "unknown");
    }
}
