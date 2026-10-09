/// A copy of the shop, from the main till to a till that is joining it.
///
/// A new till used to receive the shop through the change feed: every row
/// seeded into the feed, then two hundred records a round. Five thousand
/// rounds on a shop of a million rows -- and seeding put every row back in
/// the feed for *every* paired till, so the tills that already had the shop
/// were sent it again. Systems with a leader all answer this the same way: a
/// new replica starts from a snapshot that records the log position it was
/// taken at, and reads the log from there. `docs/specs/one-main-till.md`,
/// *Joining*, and `packages/core/src/services/sync/copy.ts` for the half that
/// decides what is asked and checked.
///
/// Three things live here because only Rust can do them:
///
/// * **Taking the copy** on the main: a `VACUUM INTO`, with what is true only
///   of the main taken out (`packages/core/sql/prepare-copy.sql`) and the feed
///   position it was taken at.
/// * **Serving it** in chunks from the listener itself. Hundreds of megabytes
///   cannot go through the webview, whose answers are strings with a
///   two-minute wait, so `/copy-part` is answered here from the file and
///   never forwarded.
/// * **Fetching it** on the joining till, resumable, checked against the
///   sha256 the signed `/copy` answer gave. `restore::copy_install` stages it.
///
/// The bytes cross the shop network in the clear, as every sync batch already
/// does (`syncAuth.ts` says why there is no TLS between tills). What protects
/// them is the same: the token comes back over a signed exchange with a paired
/// till, lasts half an hour, and names one copy.
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};

use crate::db::DbState;
use crate::paths;
use shopos_net::http;

/// Shared with the tests in `packages/core`, so what they prove is what runs.
const PREPARE_SQL: &str = include_str!("../../../../packages/core/sql/prepare-copy.sql");

/// How much one `/copy-part` answer carries. Base64 makes it a third larger,
/// still well inside `MAX_BODY`, and small enough that a dropped connection
/// costs seconds rather than minutes.
const CHUNK: u64 = 4 * 1024 * 1024;

/// How long a copy waits to be fetched before it is thrown away.
const KEPT_FOR: Duration = Duration::from_secs(30 * 60);

/// Where a joining till puts what it fetches, and which copy that was.
const DOWNLOAD: &str = "joining-copy.db";
const DOWNLOAD_TOKEN: &str = "joining-copy.token";

#[derive(Default)]
pub struct CopyShelf {
    offers: Mutex<HashMap<String, Offer>>,
}

struct Offer {
    path: PathBuf,
    bytes: u64,
    until: Instant,
}

#[derive(Serialize)]
pub struct Made {
    token: String,
    bytes: u64,
    sha256: String,
    #[serde(rename = "feedHead")]
    feed_head: i64,
}

/// The main takes a copy for a till that asked, over a signed `/copy`.
#[tauri::command(async)]
pub fn sync_copy_prepare(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    shelf: State<'_, CopyShelf>,
    for_peer: String,
) -> Result<Made, String> {
    throw_away_expired(&shelf);
    let work = paths::work_dir(&app)?;
    let token = token()?;
    let path = work.join(format!("copy-{token}.db"));
    paths::remove_if_present(&path)?;

    db.get()?.vacuum_into(&path)?;
    let feed_head = match prepare(&path) {
        Ok(head) => head,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    let (bytes, sha256) = digest(&path)?;

    shelf
        .offers
        .lock()
        .map_err(|_| "the copy shelf is wedged")?
        .insert(token.clone(), Offer { path, bytes, until: Instant::now() + KEPT_FOR });
    crate::log::write("info", "sync", &format!("took a copy of the shop for {for_peer}: {bytes} bytes"));
    Ok(Made { token, bytes, sha256, feed_head })
}

/// What only the main has comes out of the copy, and how far its feed got is
/// read first. From `sqlite_sequence` rather than the largest seq still in the
/// feed: a feed pruned empty has still issued every number up to there, and
/// every row it named is in this copy.
pub fn prepare(path: &Path) -> Result<i64, String> {
    let conn = Connection::open(path).map_err(|e| format!("could not open the copy: {e}"))?;
    conn.pragma_update(None, "journal_mode", "DELETE").map_err(|e| e.to_string())?;
    let head: i64 = conn
        .query_row(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'), 0)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute_batch(PREPARE_SQL).map_err(|e| format!("could not prepare the copy: {e}"))?;
    // Smaller on the wire, and nothing of what was deleted left in free pages.
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
    Ok(head)
}

/// One chunk of a copy, answered by the listener without asking the webview.
pub fn answer_part(app: &tauri::AppHandle, body: &str) -> http::Reply {
    #[derive(Deserialize)]
    struct Ask {
        token: String,
        offset: u64,
    }
    let Ok(ask) = serde_json::from_str::<Ask>(body) else {
        return http::Reply::refuse(400, "MALFORMED");
    };

    let shelf = app.state::<CopyShelf>();
    let found = shelf.offers.lock().ok().and_then(|offers| {
        offers
            .get(&ask.token)
            .filter(|o| o.until > Instant::now())
            .map(|o| (o.path.clone(), o.bytes))
    });
    let Some((path, bytes)) = found else {
        return http::Reply::refuse(404, "NO_SUCH_COPY");
    };
    if ask.offset >= bytes {
        return http::Reply::refuse(400, "MALFORMED");
    }

    match read_part(&path, ask.offset, CHUNK.min(bytes - ask.offset)) {
        Ok(data) => http::Reply {
            status: 200,
            body: serde_json::json!({ "data": base64::engine::general_purpose::STANDARD.encode(data) })
                .to_string(),
        },
        Err(e) => {
            crate::log::write("warn", "sync", &format!("could not read a copy of the shop: {e}"));
            http::Reply::refuse(500, "SERVER_ERROR")
        }
    }
}

fn read_part(path: &Path, offset: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut data = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut data)?;
    Ok(data)
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: u64,
}

/// The joining till fetches a copy, picking up where it stopped if the same
/// copy was half fetched, and checks it before anything uses it.
#[tauri::command(async)]
pub fn sync_copy_download(
    app: tauri::AppHandle,
    address: String,
    token: String,
    bytes: u64,
    sha256: String,
) -> Result<(), String> {
    let work = paths::work_dir(&app)?;
    let path = work.join(DOWNLOAD);
    let mark = work.join(DOWNLOAD_TOKEN);

    // Only the same copy resumes. A different token is a different file.
    let same = std::fs::read_to_string(&mark).map(|t| t == token).unwrap_or(false);
    if !same {
        paths::remove_if_present(&path)?;
        std::fs::write(&mark, &token).map_err(|e| e.to_string())?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not write the copy: {e}"))?;
    let mut done = file.metadata().map_err(|e| e.to_string())?.len();
    if done > bytes {
        file.set_len(0).map_err(|e| e.to_string())?;
        done = 0;
    }

    while done < bytes {
        let body = serde_json::json!({ "token": token, "offset": done }).to_string();
        let answer = http::request(&address, http::COPY_PART_PATH, &body, None, None)?;
        if answer.status != 200 {
            let code = serde_json::from_str::<serde_json::Value>(&answer.body)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_owned))
                .unwrap_or_else(|| format!("HTTP_{}", answer.status));
            return Err(code);
        }
        let part = serde_json::from_str::<serde_json::Value>(&answer.body)
            .ok()
            .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(str::to_owned))
            .ok_or("The main till sent something that was not part of a copy.")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(part)
            .map_err(|_| "The main till sent something that was not part of a copy.")?;
        if data.is_empty() {
            return Err("The main till sent an empty part of the copy.".into());
        }
        file.write_all(&data).map_err(|e| format!("Could not write the copy: {e}"))?;
        done += data.len() as u64;
        let _ = app.emit("copy-progress", Progress { done, total: bytes });
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    let (got, digest) = digest(&path)?;
    if got != bytes || !digest.eq_ignore_ascii_case(&sha256) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&mark);
        return Err("The copy of the shop did not arrive intact. Join again to fetch it once more.".into());
    }
    let _ = std::fs::remove_file(&mark);
    Ok(())
}

/// Where a fetched, checked copy waits for `restore::copy_install`.
pub fn downloaded(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(paths::work_dir(app)?.join(DOWNLOAD))
}

fn throw_away_expired(shelf: &CopyShelf) {
    let Ok(mut offers) = shelf.offers.lock() else { return };
    let now = Instant::now();
    offers.retain(|_, offer| {
        let keep = offer.until > now;
        if !keep {
            let _ = std::fs::remove_file(&offer.path);
        }
        keep
    });
}

fn token() -> Result<String, String> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| format!("could not make a token: {e}"))?;
    Ok(raw.iter().map(|b| format!("{b:02x}")).collect())
}

/// The size and sha256 of a file, read in pieces so a large shop is not held
/// in memory.
pub fn digest(path: &Path) -> Result<(u64, String), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        total += n as u64;
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((total, hex))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A database with the real schema: every migration in
    /// `packages/core/migrations`, in order, as `migrate.ts` applies them.
    pub fn migrated(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/migrations");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "sql"))
            .collect();
        files.sort();
        for file in files {
            let sql = std::fs::read_to_string(&file).unwrap();
            conn.execute_batch(&sql).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
            let name = file.file_name().unwrap().to_string_lossy().to_string();
            let version: i64 = name[..3].parse().unwrap();
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn
    }

    pub fn add_product(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO products (id, name, base_rate, tax_rate_bp, created_at, updated_at)
             VALUES (?1, ?2, 1000, 0, '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z')",
            [id, name],
        )
        .unwrap();
    }

    pub fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-copy-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_copy_keeps_the_shop_and_leaves_the_main_behind() {
        let dir = scratch("prepare");
        let path = dir.join("copy.db");
        {
            let conn = migrated(&path);
            add_product(&conn, "p1", "Rice");
            add_product(&conn, "p2", "Dal");
            conn.execute(
                "INSERT INTO sync_peers (device_id, secret, created_at) VALUES ('t1', 'a secret', '2026-10-10')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO doc_sequences (scope, last_value) VALUES ('bill:MR:2627', 41)", [])
                .unwrap();
            conn.execute("UPDATE sync_state SET main_device = 'main', main_epoch = 3 WHERE id = 1", [])
                .unwrap();
        }

        let head = prepare(&path).unwrap();
        assert!(head >= 2, "both products were fed, so the feed had issued at least two");

        let conn = Connection::open(&path).unwrap();
        assert_eq!(count(&conn, "products"), 2, "the shop travels");
        assert_eq!(count(&conn, "sync_peers"), 0, "the pairings and secrets of the main do not");
        assert_eq!(count(&conn, "change_feed"), 0);
        assert_eq!(count(&conn, "doc_sequences"), 0, "nor its invoice series");
        let main: Option<String> =
            conn.query_row("SELECT main_device FROM sync_state WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(main, None);
    }

    #[test]
    fn the_digest_is_the_files() {
        let dir = scratch("digest");
        let path = dir.join("f");
        std::fs::write(&path, b"abc").unwrap();
        let (n, hex) = digest(&path).unwrap();
        assert_eq!(n, 3);
        assert_eq!(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
