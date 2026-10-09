/// Putting a backup back.
///
/// The whole design turns on one constraint: on Windows the live database cannot
/// be replaced while anything holds a handle to it, and under WAL it is three
/// files that must move together. So nothing is swapped while the app is running.
/// The chosen backup is staged beside the database, a marker is written, and the
/// app restarts; the replace happens in `setup()` before the database is opened,
/// which is the one moment in the program's life when no handle exists.
///
/// The marker is what makes it safe rather than merely convenient. It is written
/// last and deleting it is the commit, so a machine that loses power in the
/// middle either starts with the old database untouched, or finishes the job on
/// the next start. There is no state in between.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::archive;
use crate::db::DbState;
use crate::files::{self, Temp};
use crate::paths::{self, DB_FILE};

const MARKER: &str = "RESTORE.json";
const STAGED: &str = "pending.db";
/// Where the live database waits while its replacement moves in.
const PREVIOUS: &str = "previous.db";

/// Tables only ShopOS creates. A file with none of them is somebody's holiday
/// photographs renamed, not a backup.
const SENTINELS: [&str; 3] = ["bills", "products", "registers"];

fn restore_dir(dir: &Path) -> PathBuf {
    dir.join("restore")
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Marker {
    /// The backup this came from, for the message shown after the restart.
    pub source: String,
    /// Where the pre-restore state was parked, so the owner can undo it.
    pub safety: String,
    pub staged_at: String,
    /// Present when what is staged is a copy of the shop taken from the main,
    /// rather than a backup of this till. See `shop_copy.rs`. Absent from every
    /// marker written before it existed, which reads as an ordinary restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyPlan>,
}

/// What installing a copy of the shop has to do besides the swap.
///
/// A restore puts this till's own past back and so takes a new identity
/// (`start_over`). A copy is the opposite: it is the *shop*, taken from the
/// main, and this till keeps everything that is its own -- its identity, its
/// pairing with the main, its feed, its invoice series. Those are carried
/// across from the database the copy replaces (`carry_over`), and the cursor
/// on the main starts at the head the copy recorded, so the first round asks
/// only for what was written after it.
#[derive(Serialize, Deserialize, Clone)]
pub struct CopyPlan {
    pub main_device: String,
    pub feed_head: i64,
}

/// The statements that carry this till's own tables across, shared with the
/// tests in `packages/core` so what they prove is what runs here.
const CARRY_OVER_SQL: &str = include_str!("../../../../packages/core/sql/carry-over-after-copy.sql");

/// What the app did with a pending restore while it was starting. Held in state
/// rather than written anywhere, because it is a message for this run only.
#[derive(Serialize, Clone, Default)]
pub struct Report {
    pub restored: Option<Marker>,
    pub error: Option<String>,
    /// The database at `shop.db` is not safe to open: a swap was started and
    /// neither finished nor fully undone, or it was undone and the marker still
    /// says to try again. `setup()` reads this and opens nothing. Not sent to
    /// the webview, which learns the same thing from `startup_status`.
    #[serde(skip)]
    pub incomplete: bool,
}

pub struct LastRestore(pub Report);

// ── Inspecting a candidate ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Check {
    pub name: String,
    pub format: String,
    pub bytes: u64,
    pub schema: i64,
    pub supported: i64,
    pub ok: bool,
    /// Why it cannot be restored at all.
    pub problem: Option<String>,
    /// Something wrong with it that the shopkeeper should decide about rather
    /// than be refused over.
    pub warning: Option<String>,
    pub taken_at: Option<String>,
    /// Submitted bills inside it, and the date of the last one.
    ///
    /// The integrity result answers "is this file broken", which is a question
    /// a shopkeeper did not ask. These answer the one they did: is this the
    /// backup I want. "1,284 bills, last one 14 September" is a thing somebody
    /// can check against what they remember; "integrity_check: ok" is not.
    ///
    /// It also catches the quiet disaster that passes every other check here —
    /// a backup of an empty database. Perfectly sound, perfectly restorable,
    /// and it would wipe the shop.
    pub bills: i64,
    pub last_bill: Option<String>,
}

/// Unpacks a candidate if it needs unpacking, and hands back a plain database
/// file to check. A zip verifies its own CRC on the way out, so a truncated
/// archive fails here rather than after the swap.
fn materialise(source: &Path, into: &Path) -> Result<PathBuf, String> {
    if source.extension().and_then(|e| e.to_str()) == Some("zip") {
        archive::extract_database(source, into)?;
        Ok(into.to_path_buf())
    } else {
        Ok(source.to_path_buf())
    }
}

fn examine(file: &Path, supported: i64) -> Check {
    let mut check = Check {
        name: String::new(),
        format: String::new(),
        bytes: std::fs::metadata(file).map(|m| m.len()).unwrap_or(0),
        schema: 0,
        supported,
        ok: false,
        problem: None,
        warning: None,
        taken_at: None,
        bills: 0,
        last_bill: None,
    };

    let conn = match Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => {
            check.problem = Some(format!("That file is not a database ShopOS can open ({e})."));
            return check;
        }
    };

    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(result) if result == "ok" => {}
        Ok(result) => {
            check.problem = Some(format!("That backup is damaged: {result}"));
            return check;
        }
        Err(e) => {
            check.problem = Some(format!("That backup could not be checked ({e})."));
            return check;
        }
    }

    let all_present = SENTINELS.iter().all(|t| {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [t],
            |_| Ok(()),
        )
        .is_ok()
    });
    if !all_present {
        check.problem = Some("That file is a database, but not a ShopOS one.".into());
        return check;
    }

    check.schema = conn
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0);

    if check.schema > supported {
        check.problem = Some(format!(
            "That backup was written by a newer ShopOS (schema {}; this one understands {}). Update ShopOS before restoring it.",
            check.schema, supported
        ));
        return check;
    }
    if check.schema == 0 {
        check.problem = Some(
            "That backup has ShopOS tables but no schema version, so there is no safe way to tell which upgrades it has already had."
                .into(),
        );
        return check;
    }

    // VACUUM INTO does not validate foreign keys, so a backup taken from an
    // already-damaged database passes integrity_check and fails this. Refusing
    // outright would deny a shopkeeper the only copy they have, so it asks.
    if let Ok(mut stmt) = conn.prepare("PRAGMA foreign_key_check") {
        if let Ok(rows) = stmt.query_map([], |_| Ok(())) {
            let broken = rows.count();
            if broken > 0 {
                check.warning = Some(format!(
                    "{broken} row(s) in that backup point at something that is no longer there. It will restore, but those records may read oddly."
                ));
            }
        }
    }

    /* After the sentinel check, so `bills` is known to exist. Failures here are
       not failures of the backup: a schema old enough to have called this table
       something else still restores, and saying nothing about the count is
       better than refusing over it. */
    if let Ok((n, last)) = conn.query_row(
        "SELECT COUNT(*), MAX(posting_date) FROM bills WHERE docstatus = 1",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
    ) {
        check.bills = n;
        check.last_bill = last;
    }

    /* Sound, restorable, and empty. Every check above passes on a database with
       no rows in it, and restoring one over a working shop erases the shop. It
       is a warning rather than a refusal because there is one honest reason to
       see it -- a till that was backed up on the day it was set up -- and the
       shopkeeper is the only one who can tell that from the other reason. */
    if check.bills == 0 && check.warning.is_none() {
        check.warning = Some(
            "That backup has no bills in it at all. If this till has been trading, it is not the backup you want -- restoring it would leave you with an empty shop."
                .into(),
        );
    }

    check.ok = true;
    check
}

#[tauri::command(async)]
pub fn restore_inspect(app: tauri::AppHandle, name: String, supported: i64) -> Result<Check, String> {
    let backups = paths::backups_dir(&app)?;
    let source = paths::in_backups(&backups, &name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let work = paths::work_dir(&app)?;
    let scratch = Temp(work.join("inspect.db"));
    paths::remove_if_present(&scratch.0)?;

    let file = materialise(&source, &scratch.0)?;
    let mut check = examine(&file, supported);
    check.name = name.clone();
    check.format = if name.ends_with(".zip") { "zip".into() } else { "db".into() };
    // The size worth showing is the backup's own, not the database unpacked out
    // of it.
    check.bytes = std::fs::metadata(&source).map(|m| m.len()).unwrap_or(check.bytes);
    check.taken_at = archive::read_manifest(&source)
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("taken_at").and_then(|t| t.as_str().map(str::to_owned)));

    Ok(check)
}

// ── Staging one, and finishing it on the next start ────────────────────────

/// Where the copy of the current data goes, checked before anything is taken.
///
/// The name arrives from the webview, and it used to be trusted as far as
/// "is it a backup name": so it could name *any* backup -- yesterday's archive,
/// or the very file being restored -- and the line after it deleted whatever
/// was there to make room. A restore that named its own source as the safety
/// copy deleted the backup it was about to restore from.
///
/// So it must be the safety shape, must not be the source, and must not exist.
/// An existing file is refused rather than replaced: two restores inside one
/// minute is a person who can wait a minute, and the alternative is throwing
/// away the previous safety copy, which may be the only record of the day.
fn safety_path(backups: &Path, source_name: &str, safety_name: &str) -> Result<PathBuf, String> {
    if paths::backup_kind(safety_name) != Some(paths::Kind::Safety) {
        return Err(format!("\"{safety_name}\" is not a name for a safety copy"));
    }
    if safety_name == source_name {
        return Err("The safety copy cannot have the same name as the backup being restored.".into());
    }
    let path = paths::in_backups(backups, safety_name)?;
    if path.exists() {
        return Err(format!(
            "A safety copy called {safety_name} is already in the backups folder. Nothing was changed -- \
             wait a minute and try again."
        ));
    }
    Ok(path)
}

/// Validates, parks a copy of the current data, stages the replacement and
/// restarts. Everything before the marker is written is undone by doing nothing;
/// everything after it is finished by the next start.
///
/// `async` so the copy of the database, which on a big shop is seconds, does
/// not freeze the window it was started from.
#[tauri::command(async)]
pub fn restore_begin(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    name: String,
    safety_name: String,
    now: String,
    supported: i64,
) -> Result<(), String> {
    if db.get()?.has_open_transaction() {
        return Err("A bill is being saved right now. Try again in a moment.".into());
    }

    let dir = paths::data_dir(&app)?;
    let backups = paths::backups_dir(&app)?;
    let source = paths::in_backups(&backups, &name)?;
    if !source.exists() {
        return Err(format!("{name} is no longer there"));
    }
    let safety = safety_path(&backups, &name, &safety_name)?;

    let work = paths::work_dir(&app)?;
    let staging = restore_dir(&dir);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Could not create {}: {e}", staging.display()))?;

    let staged = staging.join(STAGED);
    paths::remove_if_present(&staged)?;

    let scratch = Temp(work.join("restore.db"));
    paths::remove_if_present(&scratch.0)?;
    let candidate = materialise(&source, &scratch.0)?;

    // Checked here as well as in the dialog. The file could have changed since,
    // and this is the call that actually destroys something.
    let check = examine(&candidate, supported);
    if !check.ok {
        return Err(check.problem.unwrap_or_else(|| "That backup cannot be restored.".into()));
    }

    // The pre-restore copy is itself a VACUUM INTO, not a file copy: under WAL
    // the main file alone is stale by whatever the log still holds, and this is
    // the only copy the owner has if the restore turns out to be the wrong one.
    db.get()?.vacuum_into(&safety)?;

    // Photographs go in before the database, and outside the marker, because they
    // are content-addressed and additive: writing them twice is the same as
    // writing them once, and a set that only half arrived is a subset rather than
    // a corruption. The database landing last is what makes the marker
    // unambiguous — it means "the swap has not happened yet".
    if source.extension().and_then(|e| e.to_str()) == Some("zip") {
        let photos = paths::attachments_dir(&app)?;
        archive::extract_attachments(&source, &photos)?;
    }

    /* On the disk, not merely in the cache, before the marker says it is ready.
       The marker is the commit: once it exists the next start *will* move the
       live database aside and put this file in its place. A power cut that
       kept the marker and lost the tail of this file would be a restore of
       half a database, carried out faithfully. */
    files::copy_durably(&candidate, &staged).map_err(|e| format!("Could not stage the restore: {e}"))?;

    let marker = Marker { source: name, safety: safety_name, staged_at: now, copy: None };
    let json = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    // Written last, and whole or not at all. Until this exists, nothing above
    // has changed the live data.
    files::write_durably(&staging.join(MARKER), &json)
        .map_err(|e| format!("Could not record the restore: {e}"))?;

    drop(scratch);
    app.restart()
}

/// How a file is moved, so a test can make one move fail.
type Rename<'a> = &'a mut dyn FnMut(&Path, &Path) -> std::io::Result<()>;

/// The files a swap touches, named once.
struct Swap {
    live: PathBuf,
    live_wal: PathBuf,
    live_shm: PathBuf,
    staged: PathBuf,
    /// The live database, parked while its replacement moves in. Inside the
    /// staging folder, so the commit that deletes the folder deletes it too.
    previous: PathBuf,
    /// Its write-ahead log, parked beside it under the name SQLite would look
    /// for. A log is only meaningful next to the database it belongs to.
    previous_wal: PathBuf,
}

impl Swap {
    fn in_dir(dir: &Path) -> Swap {
        let staging = restore_dir(dir);
        Swap {
            live: dir.join(DB_FILE),
            live_wal: dir.join(format!("{DB_FILE}-wal")),
            live_shm: dir.join(format!("{DB_FILE}-shm")),
            staged: staging.join(STAGED),
            previous: staging.join(PREVIOUS),
            previous_wal: staging.join(format!("{PREVIOUS}-wal")),
        }
    }

    /// Puts a parked database back where it was, if it is parked and nothing
    /// has taken its place. The one step every way out of a failed swap -- and
    /// every way of abandoning one -- must take before the staging folder is
    /// deleted, or the folder takes the shop's data with it.
    fn put_back(&self, rename: Rename<'_>) -> std::io::Result<()> {
        if !self.previous.exists() || self.live.exists() {
            return Ok(());
        }
        if self.previous_wal.exists() {
            rename(&self.previous_wal, &self.live_wal)?;
        }
        rename(&self.previous, &self.live)
    }
}

/// Finishes a staged restore. Called from `setup()` before the database is
/// opened — the one point in the program with no handle on it.
pub fn apply_pending(dir: &Path) -> Report {
    apply_with(dir, &mut |from, to| std::fs::rename(from, to))
}

/// The swap, as a sequence of renames that can each be undone.
///
/// It used to delete `shop.db` and its log first and then rename the backup
/// into place. When the rename failed -- a scanner holding the file, a full
/// disk -- the shop was left with no database at all, and `Db::open` then
/// created an empty one. Every bill, every customer and every stock figure
/// gone, and the till cheerfully open for business on a blank file.
///
/// Now nothing is deleted until the new database is in place. The live file
/// and its log are *moved* into the staging folder; the backup moves in; and
/// only then does deleting the staging folder commit it. Any step that fails
/// moves the old files back. If even that fails, the start stops with
/// `incomplete` set, the message names where the data is, and nothing opens
/// until a person has decided -- which is the only safe answer when the file
/// at `shop.db` is not known to be the shop.
///
/// Every state a crash can leave behind is one this function finishes on the
/// next start:
///
/// * marker, backup staged, live in place: the ordinary case, do the swap;
/// * marker, backup staged, live parked: stopped half-way, carry on;
/// * marker, nothing staged, live parked *and* in place: the swap finished and
///   the commit did not, so commit.
fn apply_with(dir: &Path, rename: Rename<'_>) -> Report {
    let staging = restore_dir(dir);
    let swap = Swap::in_dir(dir);

    let Ok(text) = std::fs::read_to_string(staging.join(MARKER)) else {
        // No marker means nothing was ever committed, so whatever else is in
        // there is rubbish from an abandoned attempt -- once a parked database,
        // if there is somehow one, is back where it belongs.
        if staging.exists() && swap.put_back(rename).is_ok() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        return Report::default();
    };

    let marker: Marker = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            if swap.put_back(rename).is_ok() {
                let _ = std::fs::remove_dir_all(&staging);
            }
            return Report {
                error: Some(format!(
                    "A restore was interrupted and could not be finished ({e}). Nothing was changed."
                )),
                ..Report::default()
            };
        }
    };

    if !swap.staged.exists() {
        if swap.previous.exists() && swap.live.exists() {
            // The swap happened and the commit did not. Commit.
            return settle(dir, &swap, marker, rename);
        }
        if swap.put_back(rename).is_err() {
            return stuck(&swap, &marker, "the backup went missing half-way through the restore");
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Report {
            error: Some(
                "A restore was interrupted before the backup was ready. Nothing was changed.".into(),
            ),
            ..Report::default()
        };
    }

    if swap.live.exists() && swap.previous.exists() {
        // Two candidates for "the shop's data before the restore", and no way
        // to tell from here which is right. A person decides.
        return stuck(&swap, &marker, "both the database and a parked copy of it are present");
    }

    // 1. The live database steps aside, with its log. Nothing is deleted.
    if swap.live.exists() {
        if let Err(e) = rename(&swap.live, &swap.previous) {
            return Report {
                error: Some(format!(
                    "The restore could not start ({e}): something else has this shop's database open. \
                     Nothing was changed. Close anything else using ShopOS and start it again, or \
                     cancel the pending restore to carry on with the data as it is."
                )),
                incomplete: true,
                ..Report::default()
            };
        }
    }
    let parked = (|| {
        if swap.live_wal.exists() {
            rename(&swap.live_wal, &swap.previous_wal)?;
        }
        // The shared-memory file is an index over the log, rebuilt on open.
        // Left beside a different database it describes the wrong file.
        match std::fs::remove_file(&swap.live_shm) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        // 2. The backup moves in.
        rename(&swap.staged, &swap.live)
    })();

    if let Err(e) = parked {
        // 3a. Undo, so the shop is as it was.
        if swap.put_back(rename).is_err() {
            return stuck(&swap, &marker, &e.to_string());
        }
        return Report {
            error: Some(format!(
                "The backup could not be put in place ({e}). Your data is back as it was before the \
                 restore. Start ShopOS again to try once more, or cancel the pending restore to carry on \
                 without it."
            )),
            incomplete: true,
            ..Report::default()
        };
    }

    // 3b. Deleting the marker, and the parked database with it, is the commit.
    settle(dir, &swap, marker, rename)
}

/// The last step of a swap that has happened: whatever the staged file still
/// needs, then the commit.
///
/// For a backup, a new identity (`start_over`). For a copy of the shop, this
/// till's own tables carried across from the database it replaced, which is
/// still parked in the staging folder until the commit deletes it -- and if
/// that cannot be done, the copy is put aside and this till's own database
/// comes back, because a copy without this till's pairing and feed is a till
/// that cannot sync and has lost what it had not yet sent.
///
/// Reached on the start that did the swap and on the one after a power cut
/// between swap and commit. Carrying over is idempotent, so the second does
/// no harm.
fn settle(dir: &Path, swap: &Swap, marker: Marker, rename: Rename<'_>) -> Report {
    let staging = restore_dir(dir);
    let Some(plan) = marker.copy.clone() else {
        let error = start_over(dir, &marker);
        let _ = std::fs::remove_dir_all(&staging);
        return Report { restored: Some(marker), error, ..Report::default() };
    };

    if let Err(e) = carry_over(&swap.live, &swap.previous, &plan) {
        let undone = discard_live(swap).and_then(|()| swap.put_back(rename));
        if let Err(why) = undone {
            return stuck(swap, &marker, &format!("{e}; then {why}"));
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Report {
            error: Some(format!(
                "The copy of the shop could not be finished ({e}). This till is exactly as it was \
                 before; join the shop again to try once more."
            )),
            ..Report::default()
        };
    }
    let _ = std::fs::remove_dir_all(&staging);
    Report { restored: Some(marker), ..Report::default() }
}

/// This till's own tables, from the database the copy replaced, into the copy.
fn carry_over(live: &Path, previous: &Path, plan: &CopyPlan) -> Result<(), String> {
    let mut conn = Connection::open(live).map_err(|e| format!("could not open the copy: {e}"))?;
    conn.execute("ATTACH DATABASE ?1 AS prev", [previous.to_string_lossy()])
        .map_err(|e| format!("could not open this till's own database beside it: {e}"))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(CARRY_OVER_SQL).map_err(|e| format!("could not carry this till's tables across: {e}"))?;
    tx.execute(
        "UPDATE sync_peers SET their_cursor = ?1 WHERE device_id = ?2",
        rusqlite::params![plan.feed_head, plan.main_device],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.execute("DETACH DATABASE prev", []).map_err(|e| e.to_string())?;
    Ok(())
}

/// The copy steps aside, so the parked database can come back.
fn discard_live(swap: &Swap) -> std::io::Result<()> {
    for file in [&swap.live, &swap.live_wal, &swap.live_shm] {
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Stages a copy of the shop that `shop_copy::sync_copy_download` fetched and
/// checked, then restarts to install it.
///
/// The same path as a restore -- a safety copy of what is here, the file staged
/// beside the database, the marker written last -- with the plan in the marker
/// that tells the next start to carry this till's own tables across rather
/// than take a new identity. The file is the one place the download writes to,
/// never a path the webview names.
#[tauri::command(async)]
pub fn copy_install(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    main_device: String,
    feed_head: i64,
    safety_name: String,
    now: String,
    supported: i64,
) -> Result<(), String> {
    if db.get()?.has_open_transaction() {
        return Err("A bill is being saved right now. Try again in a moment.".into());
    }
    let candidate = crate::shop_copy::downloaded(&app)?;
    if !candidate.exists() {
        return Err("The copy of the shop is not here. Join the shop again to fetch it.".into());
    }

    /* Exactly this build's schema. A backup from an older build is migrated on
       the way in; a copy cannot be, because this till's own tables are carried
       into it *before* the migrations run, column for column. */
    let check = examine(&candidate, supported);
    if !check.ok {
        return Err(check.problem.unwrap_or_else(|| "That copy cannot be installed.".into()));
    }
    if check.schema != supported {
        return Err(format!(
            "The main till is on a different version of ShopOS (schema {}; this one is {}). Update \
             the older one, then join again.",
            check.schema, supported
        ));
    }

    let dir = paths::data_dir(&app)?;
    let backups = paths::backups_dir(&app)?;
    let safety = safety_path(&backups, "a copy of the shop", &safety_name)?;
    let staging = restore_dir(&dir);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Could not create {}: {e}", staging.display()))?;
    let staged = staging.join(STAGED);
    paths::remove_if_present(&staged)?;

    db.get()?.vacuum_into(&safety)?;
    files::copy_durably(&candidate, &staged).map_err(|e| format!("Could not stage the copy: {e}"))?;

    let marker = Marker {
        source: "a copy of the shop".into(),
        safety: safety_name,
        staged_at: now,
        copy: Some(CopyPlan { main_device, feed_head }),
    };
    let json = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    files::write_durably(&staging.join(MARKER), &json)
        .map_err(|e| format!("Could not record the copy: {e}"))?;

    let _ = std::fs::remove_file(&candidate);
    app.restart()
}

/// The machine takes a new identity, immediately before the commit.
///
/// The restored database is this machine's past, and the other tills already
/// hold its present: they have read its change feed up to a number the restored
/// feed is now far below, so everything written after the restore would sit
/// under their cursor and never be asked for -- and the bills this till rang up
/// between the backup and now are filed on them as having come from this till,
/// so they would never be sent back. Reproduced during the pre-release review of 26 September. A new
/// id makes this a till the others have not read at all, which is the truth
/// about the database it now holds.
///
/// Before the commit rather than after, so a machine that loses power between
/// the two finishes the commit on the next start and rotates again -- keeping
/// the identity it replaced from the first time, which is the one the other
/// tills know. `device::start_over_after_restore` owns that rule.
///
/// A failure does not undo the restore, which has already happened; it is
/// reported, with what to do about it.
fn start_over(dir: &Path, marker: &Marker) -> Option<String> {
    crate::device::start_over_after_restore(dir, &marker.staged_at)
        .err()
        .map(|e| {
            format!(
                "The backup is back in place, but this till could not take a new identity ({e}). \
                 Until it does, the other tills cannot tell it from the till it was before the \
                 restore: on each of them, forget this till and pair it again."
            )
        })
}

/// A swap that could not be finished *or* undone. Nothing opens; the message
/// says where every copy is.
fn stuck(swap: &Swap, marker: &Marker, why: &str) -> Report {
    Report {
        error: Some(format!(
            "A restore could not be finished or undone ({why}). Nothing has been deleted. Your data \
             from before the restore is at {}, and a copy of it is in your backups as {}. Cancel the \
             pending restore to put it back, or call for help before doing anything else.",
            swap.previous.display(),
            marker.safety
        )),
        incomplete: true,
        ..Report::default()
    }
}

/// What happened on the way in, so the Settings screen can say so.
#[tauri::command]
pub fn restore_report(state: State<'_, LastRestore>) -> Report {
    state.0.clone()
}

/// Throws away a staged restore, first putting back a database the restore
/// had parked, if it had parked one. Deleting the staging folder without that
/// step would delete the shop.
fn abandon(dir: &Path) -> Result<(), String> {
    let staging = restore_dir(dir);
    if !staging.exists() {
        return Ok(());
    }
    let swap = Swap::in_dir(dir);
    if swap.previous.exists() && swap.live.exists() && swap.staged.exists() {
        return Err(format!(
            "Both {} and {} are present, so there is no safe way to tell which is this shop's data. \
             Nothing was removed.",
            swap.live.display(),
            swap.previous.display()
        ));
    }
    swap.put_back(&mut |from, to| std::fs::rename(from, to))
        .map_err(|e| format!("Could not put {} back: {e}", swap.previous.display()))?;
    std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())
}

/// Throws away a staged restore that has not been applied yet. Reachable from
/// the failure screen, which is where someone who staged the wrong file lands.
///
/// Only from the copy of ShopOS that owns the folder. A second window, turned
/// away at the door, shows the same failure screen with the same button, and
/// pressing it there would reach into the first window's restore.
#[tauri::command(async)]
pub fn restore_abandon(app: tauri::AppHandle) -> Result<(), String> {
    if app.try_state::<crate::instance::Instance>().is_none() {
        return Err("Another copy of ShopOS has this shop open; cancel the restore from that one.".into());
    }
    let dir = paths::data_dir(&app)?;
    let staged = restore_dir(&dir).exists();
    abandon(&dir)?;

    /* From the failure screen, where a restore that would not finish has kept
       the database closed, cancelling it is only half the way out: this run
       decided at startup not to open anything, and reloading the window asks
       the same run again. Starting afresh opens the shop's own data, which is
       what the person who pressed "cancel" is waiting to see. */
    if staged && app.state::<DbState>().0.is_err() {
        app.restart();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data directory with a live database and its write-ahead log beside it,
    /// which is the shape restore actually has to deal with.
    fn a_shop(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-restore-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DB_FILE), b"the live database").unwrap();
        std::fs::write(dir.join(format!("{DB_FILE}-wal")), b"log").unwrap();
        std::fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm").unwrap();
        dir
    }

    fn stage(dir: &Path, contents: &[u8], marker: bool) {
        let staging = restore_dir(dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join(STAGED), contents).unwrap();
        if marker {
            let m = Marker {
                source: "shop-2026-09-12.zip".into(),
                safety: "before-restore-2026-09-13-0905.db".into(),
                staged_at: "2026-09-13T09:05:00Z".into(),
                copy: None,
            };
            std::fs::write(staging.join(MARKER), serde_json::to_vec(&m).unwrap()).unwrap();
        }
    }

    #[test]
    fn an_ordinary_start_does_nothing() {
        let dir = a_shop("ordinary");
        let report = apply_pending(&dir);
        assert!(report.restored.is_none() && report.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
    }

    #[test]
    fn a_staged_restore_replaces_the_database_and_clears_the_log() {
        let dir = a_shop("staged");
        stage(&dir, b"the backup", true);

        let report = apply_pending(&dir);
        assert!(report.error.is_none());
        assert_eq!(report.restored.unwrap().source, "shop-2026-09-12.zip");
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
        // A write-ahead log belonging to the replaced database would corrupt the
        // one that took its place.
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
        assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
        assert!(!restore_dir(&dir).exists());
    }

    /* The marker is written last, so a crash before it must leave the shop
       exactly as it was. */
    #[test]
    fn a_crash_before_the_marker_changes_nothing() {
        let dir = a_shop("no-marker");
        stage(&dir, b"the backup", false);

        let report = apply_pending(&dir);
        assert!(report.restored.is_none() && report.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(!restore_dir(&dir).exists());
    }

    #[test]
    fn a_marker_with_nothing_staged_refuses_rather_than_guessing() {
        let dir = a_shop("marker-only");
        stage(&dir, b"", true);
        std::fs::remove_file(restore_dir(&dir).join(STAGED)).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(!restore_dir(&dir).exists());
    }

    #[test]
    fn an_unreadable_marker_changes_nothing() {
        let dir = a_shop("bad-marker");
        stage(&dir, b"the backup", true);
        std::fs::write(restore_dir(&dir).join(MARKER), b"{ not json").unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
    }

    /* The whole point of the marker: finishing the job is idempotent, so a
       machine that loses power mid-restore finishes it on the next start and a
       machine that finishes it does not repeat it. */
    #[test]
    fn applying_twice_is_the_same_as_applying_once() {
        let dir = a_shop("twice");
        stage(&dir, b"the backup", true);

        assert!(apply_pending(&dir).restored.is_some());
        let again = apply_pending(&dir);
        assert!(again.restored.is_none() && again.error.is_none());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
    }

    // ── The whole way round, with a real database ──────────────────────────

    /// A shop with bills in it, as a database rather than as the word "backup".
    fn a_shop_that_has_been_trading(path: &Path, bills: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE bills (id TEXT PRIMARY KEY, docstatus INTEGER, posting_date TEXT);
             CREATE TABLE bill_items (id TEXT PRIMARY KEY);
             CREATE TABLE products (id TEXT PRIMARY KEY);
             CREATE TABLE registers (id TEXT PRIMARY KEY);
             CREATE TABLE users (id TEXT PRIMARY KEY);
             PRAGMA user_version = 33;",
        )
        .unwrap();
        for i in 1..=bills {
            conn.execute(
                "INSERT INTO bills (id, docstatus, posting_date) VALUES (?1, 1, ?2)",
                rusqlite::params![format!("bill-{i}"), format!("2026-09-{:02}", (i % 28) + 1)],
            )
            .unwrap();
        }
    }

    /// Backup to restored shop, without stubs anywhere in the middle.
    ///
    /// Every other test here uses the bytes "the backup" and proves the file
    /// dance — which is the part most likely to go wrong, and not the part a
    /// shopkeeper is trusting. This one writes a real archive from a real
    /// database, checks it the way the Backups card does, stages it, applies it
    /// the way `setup()` does, and then opens what came out and counts the
    /// bills. If any link in that chain stopped working, nothing else in this
    /// file would notice.
    #[test]
    fn a_backup_becomes_a_working_shop_again() {
        let dir = a_shop("end-to-end");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();

        let source = work.join("source.db");
        a_shop_that_has_been_trading(&source, 12);

        let zip = dir.join("shop-2026-09-16.zip");
        archive::write(&zip, &work, &source, "0.1.0", "2026-09-16T03:00:00Z", &work, &[]).unwrap();

        // What "Check this backup" shows, before anything is replaced.
        let unpacked = work.join("inspect.db");
        let file = materialise(&zip, &unpacked).unwrap();
        let check = examine(&file, 33);
        assert!(check.ok, "the archive we just wrote must inspect cleanly: {:?}", check.problem);
        assert_eq!(check.bills, 12);
        assert_eq!(check.schema, 33);
        assert!(check.last_bill.is_some());

        // Stage it the way `restore_begin` does, then finish it the way the next
        // start does.
        let staged = work.join("staged.db");
        archive::extract_database(&zip, &staged).unwrap();
        let staging = restore_dir(&dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::rename(&staged, staging.join(STAGED)).unwrap();
        let marker = Marker {
            source: "shop-2026-09-16.zip".into(),
            safety: "before-restore-2026-09-16-0905.db".into(),
            staged_at: "2026-09-16T09:05:00Z".into(),
            copy: None,
        };
        std::fs::write(staging.join(MARKER), serde_json::to_vec(&marker).unwrap()).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_none(), "{:?}", report.error);
        assert!(report.restored.is_some());

        /* The point of the whole exercise: open what is now the shop's database
           and find the shop in it. */
        let live = Connection::open_with_flags(dir.join(DB_FILE), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let count: i64 = live
            .query_row("SELECT COUNT(*) FROM bills WHERE docstatus = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 12, "every bill that went into the backup has to come out of it");

        let version: i64 = live.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 33, "restoring must not lose which migrations have run");

        // And the replaced database's log is gone, or it would corrupt this one.
        assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
    }

    /// Sound, restorable, and empty — which every other check passes.
    #[test]
    fn a_backup_with_no_bills_in_it_says_so_before_it_is_restored() {
        let dir = a_shop("empty-backup");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();

        let source = work.join("empty.db");
        a_shop_that_has_been_trading(&source, 0);

        let check = examine(&source, 33);

        /* Not a refusal: a till backed up on the day it was set up honestly has
           no bills, and only the shopkeeper can tell that from the other case.
           But restoring this over a trading shop erases the shop, so it cannot
           pass in silence. */
        assert!(check.ok);
        assert_eq!(check.bills, 0);
        let said = check.warning.expect("an empty backup must warn");
        assert!(said.contains("no bills"), "{said}");
        assert!(said.contains("empty shop"), "{said}");
    }

    // ── When the swap itself goes wrong ────────────────────────────────────

    /// A rename that fails the first `times` it is asked to move something to
    /// `into`, and works like any other after that.
    fn failing_into(into: PathBuf, mut times: usize) -> impl FnMut(&Path, &Path) -> std::io::Result<()> {
        move |from: &Path, to: &Path| {
            if to == into && times > 0 {
                times -= 1;
                Err(std::io::Error::other("the disk said no"))
            } else {
                std::fs::rename(from, to)
            }
        }
    }

    /* The bug this section exists for: the live database and its log were
       deleted first, the rename of the backup then failed, and `Db::open`
       created an empty database in the gap. A till open for business on a
       blank file, with every bill gone. */
    #[test]
    fn a_backup_that_will_not_move_in_leaves_the_shop_as_it_was() {
        let dir = a_shop("rename-fails");
        stage(&dir, b"the backup", true);

        let report = apply_with(&dir, &mut failing_into(dir.join(DB_FILE), 1));

        assert!(report.incomplete, "the start must stop rather than open something");
        assert!(report.restored.is_none());
        let said = report.error.expect("the screen has to say why");
        assert!(said.contains("back as it was"), "{said}");

        // The live database and its log are back, untouched.
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert_eq!(std::fs::read(dir.join(format!("{DB_FILE}-wal"))).unwrap(), b"log");
        // And the restore is still staged, so starting again tries again.
        assert!(restore_dir(&dir).join(MARKER).exists());
        assert!(restore_dir(&dir).join(STAGED).exists());

        let again = apply_pending(&dir);
        assert!(again.error.is_none() && !again.incomplete, "{:?}", again.error);
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
    }

    /// Worse: the backup will not move in, and the old database will not move
    /// back either. Nothing may open, nothing may be deleted, and cancelling
    /// has to put the shop back.
    #[test]
    fn a_swap_that_cannot_be_undone_stops_the_start_and_cancelling_puts_it_back() {
        let dir = a_shop("undo-fails");
        stage(&dir, b"the backup", true);

        // Everything into `shop.db` fails: the backup going in, and the old
        // database coming back.
        let report = apply_with(&dir, &mut failing_into(dir.join(DB_FILE), usize::MAX));
        assert!(report.incomplete);
        let said = report.error.unwrap();
        assert!(said.contains(PREVIOUS), "the message must say where the data is: {said}");
        assert!(said.contains("before-restore-2026-09-13-0905.db"), "{said}");

        // Nothing at shop.db for Db::open to mistake for the shop, and the
        // shop's data parked, not deleted.
        assert!(!dir.join(DB_FILE).exists());
        assert_eq!(std::fs::read(restore_dir(&dir).join(PREVIOUS)).unwrap(), b"the live database");

        abandon(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert_eq!(std::fs::read(dir.join(format!("{DB_FILE}-wal"))).unwrap(), b"log");
        assert!(!restore_dir(&dir).exists());
    }

    /// Power lost after the live database was parked and before the backup
    /// moved in. The next start finishes the job.
    #[test]
    fn a_swap_interrupted_half_way_is_finished_on_the_next_start() {
        let dir = a_shop("half-way");
        stage(&dir, b"the backup", true);
        let staging = restore_dir(&dir);
        std::fs::rename(dir.join(DB_FILE), staging.join(PREVIOUS)).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_none(), "{:?}", report.error);
        assert!(report.restored.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
        assert!(!staging.exists());
    }

    /// Power lost after the swap and before the commit.
    #[test]
    fn a_swap_that_finished_without_its_commit_is_committed() {
        let dir = a_shop("uncommitted");
        stage(&dir, b"the backup", true);
        let staging = restore_dir(&dir);
        std::fs::rename(dir.join(DB_FILE), staging.join(PREVIOUS)).unwrap();
        std::fs::rename(staging.join(STAGED), dir.join(DB_FILE)).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_none() && report.restored.is_some());
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the backup");
        assert!(!staging.exists());
    }

    /// Cancelling an ordinary staged restore is still just throwing it away.
    #[test]
    fn cancelling_a_restore_that_never_started_leaves_the_live_database_alone() {
        let dir = a_shop("cancel");
        stage(&dir, b"the backup", true);
        abandon(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(!restore_dir(&dir).exists());
    }

    /// The real thing rather than an injected failure: another program with
    /// the live database open, no sharing, which is what an antivirus scanner
    /// mid-scan looks like to Windows.
    #[cfg(windows)]
    #[test]
    fn a_database_held_by_another_program_is_not_replaced_and_says_so() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = a_shop("held");
        stage(&dir, b"the backup", true);
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(dir.join(DB_FILE))
            .unwrap();

        let report = apply_pending(&dir);
        assert!(report.incomplete);
        assert!(report.error.unwrap().contains("Nothing was changed"));
        drop(held);

        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"the live database");
        assert!(restore_dir(&dir).join(MARKER).exists(), "still staged, to try again");
    }

    // ── The safety copy's name ─────────────────────────────────────────────

    #[test]
    fn the_safety_copy_must_be_new_and_must_not_be_the_backup_itself() {
        let dir = a_shop("safety-name");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::write(backups.join("shop-2026-09-12.zip"), b"yesterday").unwrap();
        std::fs::write(backups.join("before-restore-2026-09-13-0900.db"), b"earlier").unwrap();

        // Any backup name used to do: this one would have deleted yesterday's
        // archive to make room.
        assert!(safety_path(&backups, "shop-2026-09-11.zip", "shop-2026-09-12.zip").is_err());
        // Restoring a safety copy must not name itself as the next one.
        assert!(safety_path(
            &backups,
            "before-restore-2026-09-13-0900.db",
            "before-restore-2026-09-13-0900.db"
        )
        .is_err());
        // An existing safety copy is refused rather than replaced.
        assert!(safety_path(&backups, "shop-2026-09-12.zip", "before-restore-2026-09-13-0900.db").is_err());
        assert_eq!(std::fs::read(backups.join("before-restore-2026-09-13-0900.db")).unwrap(), b"earlier");

        assert_eq!(
            safety_path(&backups, "shop-2026-09-12.zip", "before-restore-2026-09-13-0905.db").unwrap(),
            backups.join("before-restore-2026-09-13-0905.db")
        );
    }

    fn identity(dir: &Path) -> String {
        crate::device::identity_of(dir).unwrap().id
    }

    /// Restoring on the machine that made the backup used to keep its id, and
    /// the other tills' cursors on that id then stepped over everything it
    /// wrote afterwards. The sync half is argued at `start_over`.
    #[test]
    fn a_restore_gives_the_machine_a_new_identity() {
        let dir = a_shop("new-identity");
        let before = identity(&dir);
        stage(&dir, b"the backup", true);

        let report = apply_pending(&dir);
        assert!(report.error.is_none() && report.restored.is_some());
        assert_ne!(identity(&dir), before);
    }

    #[test]
    fn an_ordinary_start_keeps_the_identity() {
        let dir = a_shop("same-identity");
        let before = identity(&dir);
        apply_pending(&dir);
        assert_eq!(identity(&dir), before);
    }

    /// Power lost after the swap and before the commit, on a machine that had
    /// already been given its new identity: the one the other tills know is
    /// still the one recorded as replaced.
    #[test]
    fn finishing_an_interrupted_commit_keeps_the_identity_it_replaced() {
        let dir = a_shop("uncommitted-identity");
        let original = identity(&dir);
        stage(&dir, b"the backup", true);
        crate::device::start_over_after_restore(&dir, "2026-09-13T09:05:00Z").unwrap();
        let staging = restore_dir(&dir);
        std::fs::rename(dir.join(DB_FILE), staging.join(PREVIOUS)).unwrap();
        std::fs::rename(staging.join(STAGED), dir.join(DB_FILE)).unwrap();

        let report = apply_pending(&dir);
        assert!(report.error.is_none() && report.restored.is_some());
        let held = crate::device::setting(&dir, crate::device::RESTORE_SETTING).unwrap().unwrap();
        let held: serde_json::Value = serde_json::from_str(&held).unwrap();
        assert_eq!(held["replaces"], original.as_str());
        assert_ne!(identity(&dir), original);
    }

    #[test]
    fn a_commit_finished_on_the_next_start_takes_a_new_identity_too() {
        let dir = a_shop("uncommitted-identity");
        let before = crate::device::identity_of(&dir).unwrap().id;
        stage(&dir, b"the backup", true);
        let staging = restore_dir(&dir);
        std::fs::rename(dir.join(DB_FILE), staging.join(PREVIOUS)).unwrap();
        std::fs::rename(staging.join(STAGED), dir.join(DB_FILE)).unwrap();

        assert!(apply_pending(&dir).restored.is_some());
        assert_ne!(crate::device::identity_of(&dir).unwrap().id, before);
    }
}

#[cfg(test)]
mod copy_tests {
    use super::*;
    use crate::shop_copy::tests::{add_product, count, migrated, scratch};

    fn stage_copy(dir: &Path, copy: &Path, head: i64) {
        let staging = restore_dir(dir);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::copy(copy, staging.join(STAGED)).unwrap();
        let marker = Marker {
            source: "a copy of the shop".into(),
            safety: "before-restore-2026-10-10-1000.db".into(),
            staged_at: "2026-10-10T10:00:00Z".into(),
            copy: Some(CopyPlan { main_device: "main".into(), feed_head: head }),
        };
        std::fs::write(staging.join(MARKER), serde_json::to_vec(&marker).unwrap()).unwrap();
    }

    #[test]
    fn a_copy_of_the_shop_keeps_what_is_this_tills_own() {
        let dir = scratch("install");
        // This till: joined the main, holds its secret, its own feed and series.
        {
            let conn = migrated(&dir.join(DB_FILE));
            conn.execute(
                "INSERT INTO sync_peers (device_id, secret, created_at) VALUES ('main', 'ours', '2026-10-10')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO change_feed (table_name, row_id, op, at) VALUES ('products', 'p1', 'upsert', '2026-10-10')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO doc_sequences (scope, last_value) VALUES ('bill:TB:2627', 7)", []).unwrap();
            conn.execute("UPDATE sync_state SET main_device = 'main', main_epoch = 1 WHERE id = 1", []).unwrap();
        }
        // The copy of the shop, as the main took it.
        let copy = dir.join("from-main.db");
        {
            let conn = migrated(&copy);
            add_product(&conn, "p1", "Rice");
            add_product(&conn, "p2", "Dal");
            conn.execute(
                "INSERT INTO sync_peers (device_id, secret, created_at) VALUES ('another-till', 'theirs', '2026-10-10')",
                [],
            )
            .unwrap();
        }
        let head = crate::shop_copy::prepare(&copy).unwrap();
        stage_copy(&dir, &copy, head);

        let report = apply_pending(&dir);
        assert!(report.error.is_none(), "{:?}", report.error);
        assert!(report.restored.is_some());
        assert!(!restore_dir(&dir).exists(), "committed");

        let conn = Connection::open(dir.join(DB_FILE)).unwrap();
        assert_eq!(count(&conn, "products"), 2, "the shop arrived");
        let (secret, cursor): (String, i64) = conn
            .query_row("SELECT secret, their_cursor FROM sync_peers WHERE device_id = 'main'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(secret, "ours", "the pairing of this till with the main");
        assert_eq!(cursor, head, "and it reads the main from where the copy was taken");
        assert_eq!(count(&conn, "sync_peers"), 1, "no other pairing came with it");
        assert_eq!(count(&conn, "change_feed"), 1, "what this till still had to send");
        let series: i64 = conn
            .query_row("SELECT last_value FROM doc_sequences WHERE scope = 'bill:TB:2627'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(series, 7, "its own invoice series");
        let main: String =
            conn.query_row("SELECT main_device FROM sync_state WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(main, "main");
    }

    #[test]
    fn a_copy_that_cannot_be_finished_leaves_this_till_as_it_was() {
        let dir = scratch("install-fails");
        // Not a database the carry-over can read from: it has none of the tables.
        {
            let conn = Connection::open(dir.join(DB_FILE)).unwrap();
            conn.execute_batch("CREATE TABLE what_was_here (x INTEGER); INSERT INTO what_was_here VALUES (42);")
                .unwrap();
        }
        let copy = dir.join("from-main.db");
        {
            let conn = migrated(&copy);
            add_product(&conn, "p1", "Rice");
        }
        let head = crate::shop_copy::prepare(&copy).unwrap();
        stage_copy(&dir, &copy, head);

        let report = apply_pending(&dir);
        assert!(report.error.is_some(), "said so");
        assert!(report.restored.is_none());
        assert!(!report.incomplete, "and opened normally");

        let conn = Connection::open(dir.join(DB_FILE)).unwrap();
        let x: i64 = conn.query_row("SELECT x FROM what_was_here", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42, "the database that was here is back");
    }
}
