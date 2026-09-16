use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Number, Value as Json};
use tauri::State;

/// A transaction is held open across IPC calls, which means a JavaScript
/// exception between begin and end would otherwise strand the connection and
/// freeze every later query. Two things prevent that: the TypeScript driver ends
/// the transaction in a `finally`, and this watchdog rolls back anything left
/// open past the timeout. A rolled-back bill is recoverable; a till that stops
/// responding on a Saturday evening is not.
const TX_TIMEOUT: Duration = Duration::from_secs(15);

/// Why the database could not be opened, in the words the screen will use.
///
/// Serialised straight to the webview, so the field names are what `App.tsx`
/// reads. It exists because `setup()` used to end in `Db::open(..)?`: a
/// database that would not open made Tauri's setup return `Err`, no window was
/// ever created, and `main.rs` sets `windows_subsystem = "windows"` in release
/// -- so there was no console either. The entire symptom, for a shopkeeper at
/// eight in the morning, was an icon that does nothing when it is
/// double-clicked. No message, no log, nothing to read down a phone line, and
/// no way to reach the Restore button that would have fixed it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartupFailure {
    /// A sentence for a shopkeeper, not a rusqlite Display impl.
    pub message: String,
    /// Named because the next thing anybody does is go and look at the file.
    pub db_path: String,
    pub kind: FailureKind,
}

/// What kind of not-opening this is, because the three want opposite advice.
///
/// `SchemaTooNew` is deliberately absent. The expected schema version lives in
/// `packages/core/src/db/schemaVersion.ts` beside the migration registry that
/// checks it, and the webview already raises `SchemaTooNewError` with that
/// number in hand. Copying the constant into Rust would create a second source
/// of truth that stays right until the one release where it matters.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The bytes are not a database, or SQLite says the pages are damaged.
    Corrupt,
    /// Something else has the file. Another copy of ShopOS, a backup tool, an
    /// antivirus scanner -- all of which a shop PC has.
    Locked,
    /// Permissions, a missing folder, a disconnected drive.
    Io,
}

/// The database, or the reason there isn't one.
///
/// No outer `Mutex`, deliberately, though the phase spec drafted one: `Db` is
/// `Arc<Mutex<Inner>>` already and a `StartupFailure` never changes, so an
/// outer lock would add nothing but a second queue in front of every query --
/// and it would be held across a long merge, which is exactly when the screen
/// most wants to ask what is going on.
pub struct DbState(pub Result<Db, StartupFailure>);

impl DbState {
    /// The prefix is a contract with `tauri-driver.ts`, which turns it into a
    /// failure the webview can tell apart from an ordinary SQL error.
    pub(crate) fn get(&self) -> Result<&Db, String> {
        self.0
            .as_ref()
            .map_err(|f| format!("DB_NOT_OPEN: {}", f.message))
    }
}

/// What went wrong at startup, or nothing. Asked before anything else.
#[tauri::command]
pub fn startup_status(state: State<'_, DbState>) -> Option<StartupFailure> {
    state.0.as_ref().err().cloned()
}

pub struct Db(Arc<Mutex<Inner>>);

struct Inner {
    conn: Connection,
    active_tx: Option<ActiveTx>,
}

struct ActiveTx {
    token: String,
    started: Instant,
}

#[derive(Serialize)]
pub struct ExecResult {
    #[serde(rename = "rowsAffected")]
    rows_affected: usize,
}

impl Db {
    /// Opens the shop's database, or says why not in words a person can act on.
    ///
    /// Three steps, and all three can fail differently: the file has to open,
    /// it has to accept the pragmas -- which is where a file held by another
    /// program usually gives way -- and it has to pass `quick_check`.
    pub fn open(path: &std::path::Path) -> Result<Self, StartupFailure> {
        let fail = |kind: FailureKind, message: String| StartupFailure {
            message,
            db_path: path.display().to_string(),
            kind,
        };

        let conn = Connection::open(path).map_err(|e| {
            let kind = classify(&e, path);
            fail(kind, explain(kind, &e))
        })?;

        configure(&conn).map_err(|e| {
            let kind = classify(&e, path);
            fail(kind, explain(kind, &e))
        })?;

        /* `quick_check` and not `integrity_check`, which is the decision the
           phase spec settled: the full check reads every page, and on a shop's
           database at opening time that is seconds of a frozen window before
           anybody can bill anything. `quick_check` skips the index-to-table
           cross-checks and catches what actually happens to a shop PC -- a
           power cut mid-write, a dying disk, a file half-copied off a USB
           stick. The thorough one runs where there is time for it: after a
           backup is written, and weekly from the 02:00 timer. */
        let verdict: String = conn
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .map_err(|e| {
                let kind = classify(&e, path);
                fail(kind, explain(kind, &e))
            })?;

        if verdict != "ok" {
            return Err(fail(
                FailureKind::Corrupt,
                format!(
                    "This till's database is damaged and cannot be opened safely. \
                     SQLite reports: {verdict}"
                ),
            ));
        }

        Ok(Db(Arc::new(Mutex::new(Inner {
            conn,
            active_tx: None,
        }))))
    }

    /// Which migration the file on disk has been brought up to.
    ///
    /// Read from the database rather than from the bundle, because the two are
    /// exactly what the version line exists to tell apart: a build that carries
    /// migrations up to 28 sitting on a shop database still at 27 is a real
    /// state, and it is the one worth seeing on a screen.
    pub fn user_version(&self) -> Result<i64, String> {
        let inner = lock(self)?;
        inner
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    /// Writes a consistent copy of the database to `target`.
    ///
    /// VACUUM INTO rather than a file copy: under WAL the main file is stale by
    /// whatever the write-ahead log still holds, so copying the three files gives
    /// a torn snapshot while this gives a single, already-checkpointed database.
    ///
    /// SQLite refuses to vacuum into a path that already exists, which makes a
    /// leftover temp from a crash break the *next* backup rather than the one
    /// that failed — so callers clear the target first.
    pub fn vacuum_into(&self, target: &std::path::Path) -> Result<(), String> {
        let inner = lock(self)?;
        if inner.active_tx.is_some() {
            return Err("cannot back up while a transaction is open".into());
        }
        let escaped = target.to_string_lossy().replace("'", "''");
        inner
            .conn
            .execute_batch(&format!("VACUUM INTO '{escaped}'"))
            .map_err(|e| e.to_string())
    }

    pub fn has_open_transaction(&self) -> bool {
        lock(self).map(|inner| inner.active_tx.is_some()).unwrap_or(true)
    }

    pub fn start_watchdog(&self) {
        let inner = Arc::clone(&self.0);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let Ok(mut guard) = inner.lock() else { return };
            let expired = guard
                .active_tx
                .as_ref()
                .is_some_and(|tx| tx.started.elapsed() > TX_TIMEOUT);
            if expired {
                let _ = guard.conn.execute_batch("ROLLBACK");
                guard.active_tx = None;
                eprintln!("shopos: rolled back a transaction left open past {TX_TIMEOUT:?}");
            }
        });
    }
}

/// What the till is set to before it is allowed to write a row.
///
/// `synchronous = FULL` and not NORMAL. Under WAL, NORMAL lets SQLite return
/// from a commit before the write-ahead log has reached the platter, so a power
/// cut in that window loses whatever had committed since the last checkpoint —
/// which at a counter is the last few bills, already printed, already paid for,
/// and gone from the ledger with nothing to say they existed. FULL costs one
/// fsync per commit, which a bill every few seconds does not notice, and it is
/// the only setting under which "the bill printed" and "the bill is recorded"
/// mean the same thing.
///
/// This is the shop's database only. `node-driver.ts` stays NORMAL: tests are
/// not durability tests and pay the fsync thousands of times per run.
fn configure(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
}

/// Which of the three this is.
///
/// By SQLite's own error code rather than by reading the message, so a
/// reworded string from a library upgrade cannot quietly turn a locked file
/// into a corrupt one and start telling shops to restore a backup they do not
/// need.
fn classify(err: &rusqlite::Error, path: &std::path::Path) -> FailureKind {
    use rusqlite::ErrorCode;

    let rusqlite::Error::SqliteFailure(e, _) = err else {
        return FailureKind::Io;
    };

    match e.code {
        ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt => FailureKind::Corrupt,
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => FailureKind::Locked,
        /* A file that is there and will not open is, on a Windows shop PC,
           overwhelmingly something else holding it: a second copy of ShopOS
           started by double-clicking twice, a cloud-sync client, an antivirus
           scanner mid-scan. A file that is *not* there and will not open is a
           folder or a permissions problem, which is a different sentence and a
           different fix. */
        ErrorCode::CannotOpen if path.exists() => FailureKind::Locked,
        _ => FailureKind::Io,
    }
}

/// The sentence a shopkeeper reads.
///
/// The rusqlite message is kept on the end rather than shown on its own: "unable
/// to open database file" tells the person standing at the counter nothing, and
/// tells whoever they ring everything.
fn explain(kind: FailureKind, err: &rusqlite::Error) -> String {
    let detail = err.to_string();
    match kind {
        FailureKind::Corrupt => format!(
            "This till's database is damaged and cannot be opened safely. ({detail})"
        ),
        FailureKind::Locked => format!(
            "Another program is holding this till's database open. \
             Close any other copy of ShopOS and try again. ({detail})"
        ),
        FailureKind::Io => format!(
            "This till's database could not be opened. ({detail})"
        ),
    }
}

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
    db.0.lock().map_err(|_| "database lock poisoned".to_string())
}

fn bind(params: &[Json]) -> Result<Vec<SqlValue>, String> {
    params
        .iter()
        .map(|p| match p {
            Json::Null => Ok(SqlValue::Null),
            Json::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
            Json::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Ok(SqlValue::Integer(i))
                } else if let Some(f) = n.as_f64() {
                    Ok(SqlValue::Real(f))
                } else {
                    Err(format!("unsupported number: {n}"))
                }
            }
            Json::String(s) => Ok(SqlValue::Text(s.clone())),
            other => Err(format!("cannot bind {other} as a SQL parameter")),
        })
        .collect()
}

fn to_json(value: ValueRef<'_>) -> Json {
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(Number::from(i)),
        ValueRef::Real(f) => Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Json::Array(b.iter().map(|byte| Json::Number(Number::from(*byte))).collect()),
    }
}

fn run_query(conn: &Connection, sql: &str, params: &[Json]) -> Result<Vec<Json>, String> {
    let bound = bind(params)?;
    let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();

    let rows = stmt
        .query_map(rusqlite::params_from_iter(bound), |row| {
            let mut object = Map::with_capacity(columns.len());
            for (i, name) in columns.iter().enumerate() {
                object.insert(name.clone(), to_json(row.get_ref(i)?));
            }
            Ok(Json::Object(object))
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn run_execute(conn: &Connection, sql: &str, params: &[Json]) -> Result<ExecResult, String> {
    let bound = bind(params)?;
    let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
    let rows_affected = stmt
        .execute(rusqlite::params_from_iter(bound))
        .map_err(|e| e.to_string())?;
    Ok(ExecResult { rows_affected })
}

/// Rejects a statement that does not belong to the transaction currently open,
/// so a stale token from an abandoned call cannot commit someone else's work.
fn assert_token(inner: &Inner, token: &str) -> Result<(), String> {
    match &inner.active_tx {
        Some(tx) if tx.token == token => Ok(()),
        Some(_) => Err("a different transaction is open".into()),
        None => Err("no transaction is open".into()),
    }
}

#[tauri::command]
pub fn sql_query(db: State<'_, DbState>, sql: String, params: Vec<Json>) -> Result<Vec<Json>, String> {
    let inner = lock(db.get()?)?;
    run_query(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_execute(db: State<'_, DbState>, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    let inner = lock(db.get()?)?;
    run_execute(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_begin(db: State<'_, DbState>) -> Result<String, String> {
    let mut inner = lock(db.get()?)?;
    if inner.active_tx.is_some() {
        return Err("a transaction is already open".into());
    }
    // IMMEDIATE so write contention fails here rather than at commit, when the
    // work is already done.
    inner
        .conn
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let token = uuid_v4();
    inner.active_tx = Some(ActiveTx {
        token: token.clone(),
        started: Instant::now(),
    });
    Ok(token)
}

#[tauri::command]
pub fn sql_tx_query(
    db: State<'_, DbState>,
    token: String,
    sql: String,
    params: Vec<Json>,
) -> Result<Vec<Json>, String> {
    let inner = lock(db.get()?)?;
    assert_token(&inner, &token)?;
    run_query(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_execute(
    db: State<'_, DbState>,
    token: String,
    sql: String,
    params: Vec<Json>,
) -> Result<ExecResult, String> {
    let inner = lock(db.get()?)?;
    assert_token(&inner, &token)?;
    run_execute(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_end(db: State<'_, DbState>, token: String, commit: bool) -> Result<(), String> {
    let mut inner = lock(db.get()?)?;
    assert_token(&inner, &token)?;
    let statement = if commit { "COMMIT" } else { "ROLLBACK" };
    let result = inner.conn.execute_batch(statement).map_err(|e| e.to_string());
    inner.active_tx = None;
    result
}

/// Rolls back a transaction nothing can still be holding.
///
/// Only the webview opens transactions, and it does so against a token it keeps
/// in memory. A reloaded webview has lost every token it had, so a transaction
/// still open at that moment is orphaned by definition. The watchdog would clear
/// it within fifteen seconds, but the till should not fail to open in the
/// meantime — which is exactly what a reload mid-save used to cause.
#[tauri::command]
pub fn sql_abandon_tx(db: State<'_, DbState>) -> Result<bool, String> {
    let mut inner = lock(db.get()?)?;
    if inner.active_tx.is_none() {
        return Ok(false);
    }
    let _ = inner.conn.execute_batch("ROLLBACK");
    inner.active_tx = None;
    Ok(true)
}

/// Copies the live database to a path the shopkeeper chooses.
#[tauri::command]
pub fn backup_database(db: State<'_, DbState>, target: String) -> Result<(), String> {
    db.get()?.vacuum_into(std::path::Path::new(&target))
}

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("system randomness unavailable");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read back through `Db::open`, not through a bare `Connection`: what is
    /// being asserted is that the till's own opening path sets it, and the way
    /// this regresses is somebody editing `configure` for a test fixture.
    #[test]
    fn opens_fully_synchronous() {
        let dir = std::env::temp_dir().join(format!("shopos-db-{}", uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("shop.db")).unwrap();

        let inner = db.0.lock().unwrap();
        let synchronous: i64 = inner
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        let journal: String = inner
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        drop(inner);

        assert_eq!(synchronous, 2, "PRAGMA synchronous must read back as 2 (FULL)");
        assert_eq!(journal, "wal");

        std::fs::remove_dir_all(&dir).ok();
    }

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shopos-open-{}", uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A shop PC after a power cut, or a file half-copied off a USB stick.
    ///
    /// Before this, `setup()` ended in `Db::open(..)?` and the entire symptom
    /// was an icon that did nothing when it was double-clicked: no window, no
    /// console in release, no log, and no way to reach the Restore button.
    #[test]
    fn a_file_that_is_not_a_database_says_so_instead_of_vanishing() {
        let dir = scratch();
        let path = dir.join("shop.db");
        std::fs::write(&path, b"this is not a database, it is a jpeg someone renamed").unwrap();

        let Err(failure) = Db::open(&path) else {
            panic!("a JPEG must not open as a database")
        };

        assert_eq!(failure.kind, FailureKind::Corrupt);
        // The next thing anybody does is go and look at the file, so it is named.
        assert_eq!(failure.db_path, path.display().to_string());
        assert!(
            failure.message.contains("damaged"),
            "a shopkeeper has to be able to read it: {}",
            failure.message
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Damage inside a file that is otherwise a perfectly good database.
    ///
    /// This is the case `quick_check` exists for: the header is intact, SQLite
    /// opens it happily, and the pages underneath are wrong. Without the check
    /// the till starts, serves customers, and finds out at some later moment of
    /// its own choosing.
    #[test]
    fn damaged_pages_are_caught_at_open_rather_than_at_the_counter() {
        let dir = scratch();
        let path = dir.join("shop.db");

        {
            let db = Db::open(&path).unwrap();
            let inner = db.0.lock().unwrap();
            inner
                .conn
                .execute_batch(
                    "CREATE TABLE bills (id INTEGER PRIMARY KEY, doc_no TEXT);
                     INSERT INTO bills (doc_no) VALUES ('INV/26-27/00001');
                     CREATE INDEX idx_bills_doc_no ON bills(doc_no);
                     PRAGMA wal_checkpoint(TRUNCATE);",
                )
                .unwrap();
        }

        /* Scribble over the middle of the file, past the header, which is what
           a dying disk does. The first page is left alone deliberately: a
           mangled header gives NotADatabase and would pass the test above
           without ever reaching `quick_check`. */
        let mut bytes = std::fs::read(&path).unwrap();
        let start = bytes.len() / 2;
        for b in bytes[start..].iter_mut() {
            *b = 0x5a;
        }
        std::fs::write(&path, &bytes).unwrap();

        match Db::open(&path) {
            Err(f) => assert_eq!(f.kind, FailureKind::Corrupt),
            Ok(_) => panic!("quick_check must refuse a database with damaged pages"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A healthy database still opens, which is the case that matters most and
    /// is the one a check like this can most easily break.
    #[test]
    fn an_ordinary_database_opens_and_is_not_called_damaged() {
        let dir = scratch();
        let path = dir.join("shop.db");
        {
            let db = Db::open(&path).unwrap();
            let inner = db.0.lock().unwrap();
            inner
                .conn
                .execute_batch("CREATE TABLE bills (id INTEGER PRIMARY KEY)")
                .unwrap();
        }

        assert!(Db::open(&path).is_ok(), "a healthy database must reopen");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The file is not there yet, which is every till on its first morning.
    #[test]
    fn a_shop_starting_for_the_first_time_gets_a_database_rather_than_a_refusal() {
        let dir = scratch();
        assert!(Db::open(&dir.join("shop.db")).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Classification is by SQLite's error code, never by reading the message.
    ///
    /// The failure this guards against is a library upgrade rewording a string
    /// so that a locked file is reported as a corrupt one — which would put
    /// "your database is damaged" and a Restore button in front of a shop whose
    /// only problem is that they opened ShopOS twice.
    #[test]
    fn a_held_file_is_not_called_damaged() {
        use rusqlite::ffi::{Error as FfiError, ErrorCode};

        let dir = scratch();
        let path = dir.join("shop.db");
        std::fs::write(&path, b"").unwrap();

        let busy = rusqlite::Error::SqliteFailure(
            FfiError::new(5), // SQLITE_BUSY
            Some("database is locked".into()),
        );
        assert_eq!(classify(&busy, &path), FailureKind::Locked);

        let not_a_db = rusqlite::Error::SqliteFailure(
            FfiError::new(26), // SQLITE_NOTADB
            Some("file is not a database".into()),
        );
        assert_eq!(classify(&not_a_db, &path), FailureKind::Corrupt);

        /* The same code means different things depending on whether the file is
           there: something is holding it, versus a folder that does not exist
           or cannot be written to. Two different sentences, two different
           fixes. */
        let cant_open = rusqlite::Error::SqliteFailure(
            FfiError::new(14), // SQLITE_CANTOPEN
            Some("unable to open database file".into()),
        );
        assert_eq!(classify(&cant_open, &path), FailureKind::Locked);
        assert_eq!(
            classify(&cant_open, &dir.join("no-such-file.db")),
            FailureKind::Io
        );

        let _ = ErrorCode::DatabaseBusy;
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Every message keeps the library's own words on the end.
    ///
    /// "Unable to open database file" tells the person at the counter nothing
    /// and tells whoever they ring everything, so both are in the line.
    #[test]
    fn a_message_is_for_the_shopkeeper_and_for_whoever_they_ring() {
        let err = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            Some("database is locked".into()),
        );
        let said = explain(FailureKind::Locked, &err);

        assert!(said.contains("Another program"), "{said}");
        assert!(said.contains("Close any other copy of ShopOS"), "{said}");
        assert!(said.contains("database is locked"), "{said}");
    }
}
