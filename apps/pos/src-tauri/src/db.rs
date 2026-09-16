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
/// the transaction in a `finally`, and a watchdog rolls back anything left open
/// past its budget. A rolled-back bill is recoverable; a till that stops
/// responding on a Saturday evening is not.
///
/// ## Why the budget is per transaction
///
/// Fifteen seconds is right for a bill. It is not right for a merge: taking in
/// a few hundred changes from another till is one transaction on purpose --
/// half a merge is not a state any reconciliation rule can describe -- and it
/// can legitimately run for a minute on a shop that has been offline a week.
///
/// With one global timeout those two needs are the same number, and whichever
/// way it is set something breaks. At fifteen seconds the watchdog rolls back a
/// merge that was working, the next round starts again from the beginning, and
/// a till far enough behind can never catch up -- a livelock nobody would
/// diagnose from the shop floor. Raised to ninety, a bill stranded by a
/// JavaScript exception freezes the counter for a minute and a half at the
/// till, mid-queue.
///
/// So the caller says which kind of work it is, and the watchdog reads the
/// budget off the transaction rather than off a constant. A stuck bill is still
/// cleared in fifteen seconds while a legitimate merge is left alone.
const DEFAULT_TX_BUDGET: Duration = Duration::from_millis(15_000);

/// The floor and ceiling on what a caller may ask for.
///
/// The ceiling is the point. The budget arrives from the webview, and a caller
/// that asks for an hour has not been given a long transaction, it has switched
/// the watchdog off -- and the watchdog is the only thing standing between a
/// JavaScript exception and a till that will not respond until it is restarted.
/// Five minutes is well beyond the ninety seconds the merge asks for and well
/// short of a shop losing its evening.
const MIN_TX_BUDGET_MS: u64 = 1_000;
const MAX_TX_BUDGET_MS: u64 = 300_000;

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
    /// How long this one is allowed to take before the watchdog ends it.
    budget: Duration,
}

#[derive(Serialize, Debug)]
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

    /// Read-only access to the connection, for the diagnostics bundle.
    ///
    /// Deliberately narrow and deliberately `pub(crate)`: the rest of the
    /// program reaches the database through `sql_query`, which is the path that
    /// binds parameters and cannot be handed a connection to hold. This exists
    /// because the bundle asks the database a dozen fixed questions in one go
    /// and doing that over IPC would be a dozen round trips for a file nobody
    /// is waiting on.
    ///
    /// Reads are allowed while a transaction is open -- that is the phase
    /// decision, so a screen keeps working during a long merge -- and this is a
    /// read.
    pub(crate) fn read_with<T>(&self, f: impl FnOnce(&Connection) -> T) -> Result<T, String> {
        let inner = lock(self)?;
        Ok(f(&inner.conn))
    }

    pub fn has_open_transaction(&self) -> bool {
        lock(self).map(|inner| inner.active_tx.is_some()).unwrap_or(true)
    }

    pub fn start_watchdog(&self) {
        let inner = Arc::clone(&self.0);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let Ok(mut guard) = inner.lock() else { return };
            sweep(&mut guard);
        });
    }

    /// Opens a transaction and hands back the token every later call must carry.
    ///
    /// `budget_ms` is what the caller believes this piece of work is worth
    /// waiting for. Absent means a bill.
    pub fn begin(&self, budget_ms: Option<u64>) -> Result<String, String> {
        let mut inner = lock(self)?;
        if inner.active_tx.is_some() {
            return Err("a transaction is already open".into());
        }
        // IMMEDIATE so write contention fails here rather than at commit, when
        // the work is already done.
        inner
            .conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let token = uuid_v4();
        inner.active_tx = Some(ActiveTx {
            token: token.clone(),
            started: Instant::now(),
            budget: budget_of(budget_ms),
        });
        Ok(token)
    }

    /// A write that is not part of any transaction.
    ///
    /// Refused while one is open, and this is the whole of the fix.
    ///
    /// SQLite has one connection here and one transaction on it. A statement
    /// sent outside the token while a transaction is running does not fail and
    /// does not wait -- it silently *joins* that transaction, and then shares
    /// its fate. A setting saved during a merge that rolls back is gone, with
    /// the screen having already said it was saved; a `recordAttempt` row
    /// written during a merge that rolls back takes the sync loop's memory of
    /// what it just tried with it.
    ///
    /// Reads are still allowed, which is the other half of the same decision:
    /// a merge can hold the connection for a minute, and a counter that cannot
    /// read during it is a counter that has stopped. A read that joins a
    /// transaction sees uncommitted rows, which is a real cost and a much
    /// smaller one than the screen going blank.
    pub fn execute(&self, sql: &str, params: &[Json]) -> Result<ExecResult, String> {
        let inner = lock(self)?;
        if inner.active_tx.is_some() {
            return Err("a transaction is open".into());
        }
        run_execute(&inner.conn, sql, params)
    }

    /// A read, transaction or no transaction. See `execute` for why the two are
    /// treated differently.
    pub fn query(&self, sql: &str, params: &[Json]) -> Result<Vec<Json>, String> {
        let inner = lock(self)?;
        run_query(&inner.conn, sql, params)
    }

    /// One watchdog tick, for a test that cannot wait a second per assertion.
    #[cfg(test)]
    fn sweep_now(&self) -> bool {
        let Ok(mut guard) = self.0.lock() else { return false };
        sweep(&mut guard)
    }
}

/// Rolls back a transaction that has outstayed its own budget. Returns whether
/// it did.
fn sweep(guard: &mut Inner) -> bool {
    let Some(tx) = guard.active_tx.as_ref() else { return false };
    if tx.started.elapsed() <= tx.budget {
        return false;
    }
    let budget = tx.budget;
    let _ = guard.conn.execute_batch("ROLLBACK");
    guard.active_tx = None;
    eprintln!("shopos: rolled back a transaction left open past {budget:?}");
    true
}

/// What the caller asked for, brought inside the bounds.
///
/// Clamped rather than refused. A budget that is out of range is a programming
/// mistake in the webview, and failing the transaction over it would turn a
/// sensible default into a till that cannot bill.
fn budget_of(ms: Option<u64>) -> Duration {
    match ms {
        None => DEFAULT_TX_BUDGET,
        Some(ms) => Duration::from_millis(ms.clamp(MIN_TX_BUDGET_MS, MAX_TX_BUDGET_MS)),
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
    db.get()?.query(&sql, &params)
}

#[tauri::command]
pub fn sql_execute(db: State<'_, DbState>, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    db.get()?.execute(&sql, &params)
}

#[tauri::command]
pub fn sql_tx_begin(db: State<'_, DbState>, budget_ms: Option<u64>) -> Result<String, String> {
    db.get()?.begin(budget_ms)
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

    /// A database in a folder of its own, with one table to write to.
    fn a_till() -> (std::path::PathBuf, Db) {
        let dir = scratch();
        let db = Db::open(&dir.join("shop.db")).unwrap();
        db.execute("CREATE TABLE note (id INTEGER PRIMARY KEY, text TEXT)", &[])
            .unwrap();
        (dir, db)
    }

    /// Pretends the open transaction started `ago` in the past.
    ///
    /// Reaching in rather than sleeping: the floor on a budget is a second, and
    /// a suite that waits one out per assertion is a suite people stop running.
    fn started_ago(db: &Db, ago: Duration) {
        let mut inner = db.0.lock().unwrap();
        let tx = inner.active_tx.as_mut().expect("a transaction is open");
        tx.started = Instant::now().checked_sub(ago).expect("clock has a past");
    }

    #[test]
    fn a_bill_gets_fifteen_seconds_and_a_merge_gets_what_it_asked_for() {
        assert_eq!(budget_of(None), Duration::from_secs(15));
        assert_eq!(budget_of(Some(90_000)), Duration::from_secs(90));
    }

    #[test]
    fn a_budget_nobody_could_have_meant_is_brought_back_into_range() {
        /* Clamped and not refused. An impossible budget is a mistake in the
           webview, and failing the transaction over it would turn a sensible
           default into a till that cannot bill. The ceiling is the one that
           matters: a caller asking for an hour has not been given a long
           transaction, it has switched the watchdog off. */
        assert_eq!(budget_of(Some(0)), Duration::from_millis(MIN_TX_BUDGET_MS));
        assert_eq!(budget_of(Some(1)), Duration::from_millis(MIN_TX_BUDGET_MS));
        assert_eq!(budget_of(Some(3_600_000)), Duration::from_millis(MAX_TX_BUDGET_MS));
    }

    #[test]
    fn a_bill_left_open_is_cleared_and_the_till_writes_again() {
        let (dir, db) = a_till();
        let token = db.begin(None).unwrap();

        started_ago(&db, Duration::from_secs(16));
        assert!(db.sweep_now(), "a bill past fifteen seconds is the watchdog's whole job");

        // Rolled back, not committed: the point is that the till is usable
        // again, not that half a bill was kept.
        assert!(db.execute("INSERT INTO note (text) VALUES ('after')", &[]).is_ok());
        let rows = db.query("SELECT text FROM note", &[]).unwrap();
        assert_eq!(rows.len(), 1, "only the write that came after the rollback");

        // And the stale token cannot commit anything.
        let inner = db.0.lock().unwrap();
        assert!(assert_token(&inner, &token).is_err());
        drop(inner);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_merge_that_asked_for_ninety_seconds_is_left_alone_at_twenty() {
        /* The livelock this exists to prevent: with one fifteen-second timeout
           for everything, a till a week behind has its merge rolled back, starts
           again from the beginning next round, and never catches up. Nobody
           would diagnose that from the shop floor. */
        let (dir, db) = a_till();
        db.begin(Some(90_000)).unwrap();

        started_ago(&db, Duration::from_secs(20));
        assert!(!db.sweep_now(), "twenty seconds is inside ninety");

        started_ago(&db, Duration::from_secs(91));
        assert!(db.sweep_now(), "and ninety-one is not");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_outside_the_token_is_refused_while_a_transaction_is_open() {
        /* The bug, in one sentence: SQLite has one connection here, so a
           statement sent outside the token does not fail and does not wait --
           it silently joins whatever transaction is running, and shares its
           fate. A setting saved during a merge that rolls back is gone, with
           the screen having already said it was saved. */
        let (dir, db) = a_till();
        let token = db.begin(None).unwrap();

        let refused = db.execute("INSERT INTO note (text) VALUES ('joined')", &[]);
        assert_eq!(refused.unwrap_err(), "a transaction is open");

        // Through the token it is fine, because that is the work that opened it.
        {
            let inner = db.0.lock().unwrap();
            assert_token(&inner, &token).unwrap();
            run_execute(&inner.conn, "INSERT INTO note (text) VALUES ('mine')", &[]).unwrap();
        }
        {
            let mut inner = db.0.lock().unwrap();
            inner.conn.execute_batch("COMMIT").unwrap();
            inner.active_tx = None;
        }

        let rows = db.query("SELECT text FROM note", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(db.execute("INSERT INTO note (text) VALUES ('later')", &[]).is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_read_is_still_allowed_while_a_transaction_is_open() {
        /* The other half of the same decision. A merge can hold the connection
           for a minute, and a counter that cannot read for a minute is a
           counter that has stopped. */
        let (dir, db) = a_till();
        db.execute("INSERT INTO note (text) VALUES ('before')", &[]).unwrap();
        db.begin(Some(90_000)).unwrap();

        let rows = db.query("SELECT text FROM note", &[]).unwrap();
        assert_eq!(rows.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_transaction_is_refused_rather_than_nested() {
        let (dir, db) = a_till();
        db.begin(None).unwrap();
        assert_eq!(db.begin(None).unwrap_err(), "a transaction is already open");
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
