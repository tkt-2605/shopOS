//! The shop's health, sent to its supplier: why a sync stalled, why a licence
//! will not verify, what the app's own checks have flagged, what the logs say.
//!
//! It goes out on its own every day, so it is held to a stricter rule than the
//! diagnostics bundle a shopkeeper chooses to send: it carries **no customer,
//! no amount of money and no credential**. Records are counted, never read;
//! sync problems are reported by table, row id and reason, never by the
//! record's contents; settings by key and length, never by value; and the
//! device file through `diagnostics::redacted_device`, which withholds every
//! setting not known to be safe. `users.password_hash` and `sync_peers.secret`
//! are never selected.
//!
//! What the app's checks found (licence state, discrepancies, the last sync
//! round) is gathered by the webview from core and arrives as `app.json`,
//! already reduced to the same rule by `core/health.ts`.

use std::io::{Cursor, Write};
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value as Json};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::db::DbState;
use crate::{diagnostics, paths, report_out};

/// Rows of any one list. Enough to see a pattern, small enough for a poor line.
const LIST_ROWS: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSent {
    name: String,
    bytes: usize,
    mail: &'static str,
    mail_error: Option<String>,
    telegram: &'static str,
    telegram_error: Option<String>,
}

/// Builds the health zip and sends it the way reports go, to whoever this
/// machine's settings name. `label` is only for the file name and subject.
#[tauri::command(async)]
pub fn health_send(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    now: String,
    label: String,
    summary: String,
    extra: Json,
) -> Result<HealthSent, String> {
    let data = paths::data_dir(&app)?;
    let version = app.package_info().version.to_string();
    let bytes = health_zip(&data, &now, &version, db.get().ok(), &extra)?;

    let stamp: String = now.chars().filter(char::is_ascii_digit).take(12).collect();
    let label: String = label
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '(' | ')' | '-'))
        .take(60)
        .collect();
    let name = format!("health {} {stamp}.zip", label.trim());
    let subject = format!("ShopOS health - {}", label.trim());
    // Names no customer, so the vendor's baked-in bot may carry it.
    let sent = report_out::send_out(&app, &name, &bytes, &subject, &summary, true)?;
    Ok(HealthSent {
        name,
        bytes: bytes.len(),
        mail: sent.mail,
        mail_error: sent.mail_error,
        telegram: sent.telegram,
        telegram_error: sent.telegram_error,
    })
}

/// The zip, from paths rather than a running app, so a test can open it and
/// look for what must never be there.
pub fn health_zip(
    data: &Path,
    now: &str,
    app_version: &str,
    db: Option<&crate::db::Db>,
    extra: &Json,
) -> Result<Vec<u8>, String> {
    let mut problems: Vec<String> = Vec::new();
    let device = diagnostics::redacted_device(data, &mut problems);
    let backups = diagnostics::list_backups(data);

    let checks = match db {
        Some(handle) => {
            let open = handle.has_open_transaction();
            match handle.read_with(|conn| checks(conn, open)) {
                Ok(found) => found,
                Err(e) => {
                    problems.push(format!("Could not read the database: {e}"));
                    Json::Null
                }
            }
        }
        None => {
            problems.push("The database is not open on this machine.".into());
            Json::Null
        }
    };

    let report = json!({
        "generated_at": now,
        "app_version": app_version,
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "database_bytes": std::fs::metadata(data.join(paths::DB_FILE)).map(|m| m.len()).unwrap_or(0),
        "device": device,
        "backups": backups,
        "problems": problems,
    });

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    add(&mut zip, "health.json", &pretty(&report)?)?;
    add(&mut zip, "checks.json", &pretty(&checks)?)?;
    if !extra.is_null() {
        add(&mut zip, "app.json", &pretty(extra)?)?;
    }
    for path in crate::log::log_paths(data) {
        let Some(base) = path.file_name().and_then(|n| n.to_str()) else { continue };
        match std::fs::read(&path) {
            Ok(bytes) => add(&mut zip, &format!("logs/{base}"), &bytes)?,
            Err(e) => add(&mut zip, &format!("logs/{base}.missing.txt"), format!("{e}").as_bytes())?,
        }
    }
    Ok(zip.finish().map_err(|e| format!("Could not finish the health report: {e}"))?.into_inner())
}

fn pretty(value: &Json) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|e| format!("Could not write the health report: {e}"))
}

fn add(zip: &mut zip::ZipWriter<Cursor<Vec<u8>>>, name: &str, bytes: &[u8]) -> Result<(), String> {
    zip.start_file(name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))
        .map_err(|e| format!("Could not add {name}: {e}"))?;
    zip.write_all(bytes).map_err(|e| format!("Could not write {name}: {e}"))
}

/// Every row of a fixed query as JSON objects, or why it could not be asked.
/// A table that does not exist on an older schema is a note, not a failure.
fn rows(conn: &Connection, sql: &str) -> Json {
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => return json!({ "unavailable": e.to_string() }),
    };
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mapped = stmt.query_map([], |r| {
        let mut row = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match r.get_ref(i)? {
                ValueRef::Null => Json::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                ValueRef::Blob(b) => json!(format!("<{} bytes>", b.len())),
            };
            row.insert(name.clone(), value);
        }
        Ok(Json::Object(row))
    });
    match mapped {
        Ok(found) => Json::Array(found.filter_map(Result::ok).take(LIST_ROWS).collect()),
        Err(e) => json!({ "unavailable": e.to_string() }),
    }
}

/// The questions, all fixed, all naming their columns. None selects a name,
/// a phone, an amount or a secret.
fn checks(conn: &Connection, transaction_open: bool) -> Json {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|it| it.filter_map(Result::ok).collect()))
        .unwrap_or_default();
    let mut counts = Map::new();
    for table in &tables {
        let quoted = table.replace('"', "\"\"");
        if let Ok(n) = conn.query_row(&format!("SELECT COUNT(*) FROM \"{quoted}\""), [], |r| r.get::<_, i64>(0)) {
            counts.insert(table.clone(), json!(n));
        }
    }

    let foreign_keys = rows(conn, "PRAGMA foreign_key_check");
    let foreign_key_problems = foreign_keys.as_array().map(Vec::len);

    json!({
        "transaction_open": transaction_open,
        "schema_version": conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).ok(),
        "database": rows(conn, "SELECT (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
                                       (SELECT page_count FROM pragma_page_count) AS page_count,
                                       (SELECT freelist_count FROM pragma_freelist_count) AS freelist_count,
                                       (SELECT page_size FROM pragma_page_size) AS page_size"),
        "integrity": rows(conn, "PRAGMA quick_check"),
        "foreign_key_problems": foreign_key_problems,
        "row_counts": counts,
        // Counters and their prefixes: two tills that made the same one apart
        // is the first thing to look for when bills stop crossing.
        "registers": rows(conn, "SELECT r.id, r.name, r.prefix, r.is_active, r.claimed_by, r.claimed_at,
                                        r.created_at, r.origin_id,
                                        (SELECT COUNT(*) FROM bills b WHERE b.register_id = r.id) AS bills
                                   FROM registers r ORDER BY r.created_at"),
        "sync": {
            "peers": rows(conn, "SELECT device_id, label, reach, address, their_cursor, my_cursor, their_head,
                                        last_agreed_at, last_tried_at, last_error, clock_skew_ms, head_said_at,
                                        created_at, secret IS NOT NULL AS paired
                                   FROM sync_peers ORDER BY device_id"),
            "state": rows(conn, "SELECT applying, pruned_through, ledger_filled FROM sync_state"),
            "feed": rows(conn, "SELECT COUNT(*) AS rows, MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM change_feed"),
            "feed_by_origin": rows(conn, "SELECT origin_device, COUNT(*) AS rows, MAX(seq) AS last_seq
                                            FROM change_feed GROUP BY origin_device"),
            // The record itself is never read: it is a customer, a bill, a user.
            "set_aside": rows(conn, &format!(
                "SELECT at, peer_device, table_name, row_id, op, reason, acknowledged, length(record) AS record_bytes
                   FROM sync_quarantine ORDER BY at DESC LIMIT {LIST_ROWS}")),
            "conflicts": rows(conn, &format!(
                "SELECT at, peer_device, table_name, row_id, winner, acknowledged
                   FROM sync_conflicts ORDER BY at DESC LIMIT {LIST_ROWS}")),
        },
        "documents": {
            "bills_by_status": rows(conn, "SELECT docstatus, COUNT(*) AS n FROM bills GROUP BY docstatus"),
            "documents_by_status": rows(conn, "SELECT docstatus, COUNT(*) AS n FROM documents GROUP BY docstatus"),
            "returns_by_status": rows(conn, "SELECT docstatus, COUNT(*) AS n FROM sales_returns GROUP BY docstatus"),
            "submitted_bills_without_books": rows(conn,
                "SELECT COUNT(*) AS n FROM bills b WHERE b.docstatus = 1
                    AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.voucher_id = b.id)"),
        },
        "stock": rows(conn, "SELECT COUNT(*) AS products_below_zero FROM product_stock WHERE qty_on_hand < 0"),
        "sign_ins": rows(conn, "SELECT COUNT(*) AS sessions, SUM(failed_logins) AS failed_logins FROM user_sessions"),
        // Which settings exist and when they changed; never what they say.
        "settings": rows(conn, "SELECT key, length(value) AS bytes, updated_at FROM settings ORDER BY key"),
        "seen_discrepancies": rows(conn, "SELECT key, seen_at FROM discrepancies_seen ORDER BY seen_at DESC LIMIT 200"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("shopos-health-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn everything_in(bytes: Vec<u8>) -> (Vec<String>, String) {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut names = Vec::new();
        let mut all = String::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).unwrap();
            names.push(entry.name().to_string());
            let mut text = String::new();
            let _ = entry.read_to_string(&mut text);
            all.push_str(&text);
        }
        (names, all)
    }

    #[test]
    fn it_says_why_sync_failed_without_carrying_a_customer_or_a_secret() {
        let data = scratch("private");
        std::fs::write(
            data.join("device.json"),
            r#"{"device_id":"till-1","label":"Front","settings":{"tg_token":"123:BOT-TOKEN-SHOULD-NOT-APPEAR","mail_password":"MAIL-PASSWORD-SHOULD-NOT-APPEAR","ui_theme":"khata"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(data.join("logs")).unwrap();
        std::fs::write(data.join("logs").join("shopos.log"), b"2026-10-12T00:00:00Z WARN sync timed out\n").unwrap();

        let db = crate::db::Db::open(&data.join(paths::DB_FILE)).unwrap();
        db.read_with(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT);
                 INSERT INTO users VALUES ('u1', 'admin', 'HASH-SHOULD-NOT-APPEAR');
                 CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, phone TEXT);
                 INSERT INTO customers VALUES ('c1', 'CUSTOMER-NAME-SHOULD-NOT-APPEAR', '9999988888');
                 CREATE TABLE sync_peers (device_id TEXT PRIMARY KEY, label TEXT, reach TEXT, address TEXT,
                    their_cursor INTEGER, my_cursor INTEGER, their_head INTEGER, last_agreed_at TEXT,
                    last_tried_at TEXT, last_error TEXT, clock_skew_ms INTEGER, head_said_at TEXT,
                    created_at TEXT, secret TEXT);
                 INSERT INTO sync_peers VALUES ('till-2', 'Back', 'lan', '192.168.31.237:7801', 4, 9, 12,
                    NULL, '2026-10-12', 'connection timed out', 0, NULL, '2026-10-09', 'PEER-SECRET-SHOULD-NOT-APPEAR');
                 CREATE TABLE sync_quarantine (id TEXT PRIMARY KEY, at TEXT, peer_device TEXT, table_name TEXT,
                    row_id TEXT, op TEXT, reason TEXT, record TEXT, acknowledged INTEGER);
                 INSERT INTO sync_quarantine VALUES ('q1', '2026-10-09T18:19:00Z', 'till-2', 'registers', 'r2',
                    'upsert', 'UNIQUE constraint failed: registers.prefix',
                    '{\"name\":\"RECORD-CONTENTS-SHOULD-NOT-APPEAR\"}', 0);
                 CREATE TABLE registers (id TEXT PRIMARY KEY, name TEXT, prefix TEXT, is_active INTEGER,
                    claimed_by TEXT, claimed_at TEXT, created_at TEXT, origin_id TEXT);
                 INSERT INTO registers VALUES ('r1', 'counter1', 'CR1', 1, NULL, NULL, '2026-10-09', NULL);
                 CREATE TABLE bills (id TEXT PRIMARY KEY, register_id TEXT, docstatus INTEGER);
                 INSERT INTO bills VALUES ('b1', 'r1', 1);
                 CREATE TABLE gl_entries (id TEXT PRIMARY KEY, voucher_id TEXT);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                 INSERT INTO settings VALUES ('licence_code', 'LICENCE-VALUE-SHOULD-NOT-APPEAR', '2026-10-01');
                 PRAGMA user_version = 70;",
            )
            .unwrap();
        })
        .unwrap();

        let extra = json!({ "licence": { "state": "none", "problem": "BAD_SIGNATURE" } });
        let (names, all) = everything_in(health_zip(&data, "2026-10-12T21:30:00Z", "0.2.20", Some(&db), &extra).unwrap());

        for secret in [
            "BOT-TOKEN-SHOULD-NOT-APPEAR", "MAIL-PASSWORD-SHOULD-NOT-APPEAR", "HASH-SHOULD-NOT-APPEAR",
            "PEER-SECRET-SHOULD-NOT-APPEAR", "CUSTOMER-NAME-SHOULD-NOT-APPEAR", "9999988888",
            "RECORD-CONTENTS-SHOULD-NOT-APPEAR", "LICENCE-VALUE-SHOULD-NOT-APPEAR",
        ] {
            assert!(!all.contains(secret), "{secret} is in the health report");
        }

        for name in ["health.json", "checks.json", "app.json", "logs/shopos.log"] {
            assert!(names.iter().any(|n| n == name), "{name} missing from {names:?}");
        }
        // What it is for: the reason a sync failed, and the clash behind it.
        assert!(all.contains("connection timed out"));
        assert!(all.contains("UNIQUE constraint failed: registers.prefix"));
        assert!(all.contains("\"prefix\": \"CR1\""));
        assert!(all.contains("BAD_SIGNATURE"));
        assert!(all.contains("\"schema_version\": 70"));
        assert!(all.contains("sync timed out"), "the log is carried");
        // The bill that has no entries in the books is counted.
        assert!(all.contains("\"submitted_bills_without_books\""));
        assert!(all.contains("\"customers\": 1"), "customers are counted, never read");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn it_is_still_made_when_the_database_will_not_open() {
        let data = scratch("nodb");
        let (names, all) = everything_in(health_zip(&data, "2026-10-12T21:30:00Z", "0.2.20", None, &Json::Null).unwrap());
        assert!(names.iter().any(|n| n == "health.json"));
        assert!(all.contains("The database is not open"));
        let _ = std::fs::remove_dir_all(&data);
    }
}
