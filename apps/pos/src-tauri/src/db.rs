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
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        configure(&conn)?;
        Ok(Db(Arc::new(Mutex::new(Inner {
            conn,
            active_tx: None,
        }))))
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

fn configure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| e.to_string())
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
pub fn sql_query(db: State<'_, Db>, sql: String, params: Vec<Json>) -> Result<Vec<Json>, String> {
    let inner = lock(&db)?;
    run_query(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_execute(db: State<'_, Db>, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    let inner = lock(&db)?;
    run_execute(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_begin(db: State<'_, Db>) -> Result<String, String> {
    let mut inner = lock(&db)?;
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
    db: State<'_, Db>,
    token: String,
    sql: String,
    params: Vec<Json>,
) -> Result<Vec<Json>, String> {
    let inner = lock(&db)?;
    assert_token(&inner, &token)?;
    run_query(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_execute(
    db: State<'_, Db>,
    token: String,
    sql: String,
    params: Vec<Json>,
) -> Result<ExecResult, String> {
    let inner = lock(&db)?;
    assert_token(&inner, &token)?;
    run_execute(&inner.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_tx_end(db: State<'_, Db>, token: String, commit: bool) -> Result<(), String> {
    let mut inner = lock(&db)?;
    assert_token(&inner, &token)?;
    let statement = if commit { "COMMIT" } else { "ROLLBACK" };
    let result = inner.conn.execute_batch(statement).map_err(|e| e.to_string());
    inner.active_tx = None;
    result
}

/// Copies the live database to a path the shopkeeper chooses. VACUUM INTO is
/// consistent against a database being written to, unlike copying the file.
#[tauri::command]
pub fn backup_database(db: State<'_, Db>, target: String) -> Result<(), String> {
    let inner = lock(&db)?;
    if inner.active_tx.is_some() {
        return Err("cannot back up while a transaction is open".into());
    }
    let escaped = target.replace('\'', "''");
    inner
        .conn
        .execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .map_err(|e| e.to_string())
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
