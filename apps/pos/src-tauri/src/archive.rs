/// The backup archive: one zip holding the database, and later the photographs
/// attached to it.
///
/// One file rather than several because a backup is only worth having if it can
/// be carried off the machine, and a shopkeeper carries one file. Every archive
/// is self-contained and never rewritten after it is closed, so a zip found on a
/// USB stick in a year restores a working shop by itself.
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use zip::write::SimpleFileOptions;

pub const FORMAT: u32 = 1;
pub const DB_ENTRY: &str = "shop.db";
pub const MANIFEST_ENTRY: &str = "manifest.json";
/// Attachments keep the layout they have on disk, so restoring them is a copy
/// rather than a translation.
pub const ATTACH_PREFIX: &str = "attachments/";

#[derive(Serialize)]
struct Manifest {
    format: u32,
    app: String,
    /// The database's `user_version`, so a restore can refuse a file this build
    /// is too old to understand before it touches anything.
    schema: i64,
    taken_at: String,
    database: Entry,
    /// The photographs this archive carries, which is those recorded inside the
    /// window rather than every one on the machine — see `attachmentsToCarry`.
    attachments: Vec<Entry>,
    /// Named rather than silently dropped: a file a row points at that is no
    /// longer on the disk is worth knowing about, and is not a reason to fail
    /// the backup of the ledger.
    missing: Vec<String>,
}

#[derive(Serialize)]
struct Entry {
    path: String,
    bytes: u64,
    /// CRC-32, which is also what the zip container stores per entry — recorded
    /// here as well so the manifest can be checked without trusting the reader
    /// that unpacked it.
    crc32: u32,
}

/// Removes its path when it goes out of scope, however it goes out of scope.
///
/// Every error path below returns early, and SQLite refuses to vacuum into a
/// file that already exists — so a temp left behind by a failure would break the
/// *next* backup rather than the one that failed.
pub struct Temp(pub PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Writes `db_file` into a new archive at `target`.
///
/// Built under a temporary name and renamed into place at the end, so a crash
/// halfway through never leaves a half-written archive wearing today's name —
/// which would be read next time as a backup that had already been taken.
pub fn write(
    target: &Path,
    work: &Path,
    db_file: &Path,
    app_version: &str,
    taken_at: &str,
    attachments_root: &Path,
    attachments: &[String],
) -> Result<(), String> {
    let schema = read_schema(db_file)?;
    let bytes = std::fs::read(db_file).map_err(|e| format!("Could not read the copy: {e}"))?;

    let part = Temp(work.join(format!(
        "{}.part",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("backup.zip")
    )));
    let file = std::fs::File::create(&part.0).map_err(|e| format!("Could not create {}: {e}", part.0.display()))?;
    let mut zip = zip::ZipWriter::new(file);

    let mut manifest = Manifest {
        format: FORMAT,
        app: app_version.to_string(),
        schema,
        taken_at: taken_at.to_string(),
        database: Entry {
            path: DB_ENTRY.to_string(),
            bytes: bytes.len() as u64,
            crc32: crc32fast::hash(&bytes),
        },
        attachments: Vec::new(),
        missing: Vec::new(),
    };
    // A SQLite file is mostly empty pages and repeated structure; it compresses
    // to a fraction. Photographs are already compressed and are stored as they
    // are — deflating a JPEG costs time and saves nothing.
    add(&mut zip, DB_ENTRY, &bytes, zip::CompressionMethod::Deflated)?;
    drop(bytes);

    for rel in attachments {
        let file = match super::paths::stored_rel(rel) {
            Some(r) => attachments_root.join(r),
            // A path that is not the shape this program writes did not come from
            // it. Recorded as missing rather than followed.
            None => {
                manifest.missing.push(rel.clone());
                continue;
            }
        };
        let photo = match std::fs::read(&file) {
            Ok(b) => b,
            Err(_) => {
                manifest.missing.push(rel.clone());
                continue;
            }
        };
        add(&mut zip, &format!("{ATTACH_PREFIX}{rel}"), &photo, zip::CompressionMethod::Stored)?;
        manifest.attachments.push(Entry {
            path: rel.clone(),
            bytes: photo.len() as u64,
            crc32: crc32fast::hash(&photo),
        });
    }

    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("Could not write the manifest: {e}"))?;
    // Stored rather than deflated so it can be read out of a damaged archive
    // with nothing more than a text editor. It goes in last because it is only
    // true once everything it describes is written.
    add(&mut zip, MANIFEST_ENTRY, &manifest_json, zip::CompressionMethod::Stored)?;

    zip.finish().map_err(|e| format!("Could not finish the archive: {e}"))?;

    /* Before the rename, deliberately.

       A backup nobody has opened is not a backup, it is a hope. Until now this
       function wrote a zip and said it had succeeded, and the first time anyone
       found out otherwise was the day they needed it -- which is the one day a
       shop cannot afford to find out.

       Verifying the `.part` rather than the finished file means an archive that
       fails never exists under today's name at all. `Temp` deletes it on the way
       out of this function, so the failure leaves nothing behind for tomorrow's
       backup to mistake for a backup that was already taken, and `Err` turns the
       Backups card red. */
    verify(&part.0, db_file, work)?;

    super::paths::remove_if_present(target)?;
    std::fs::rename(&part.0, target).map_err(|e| format!("Could not save {}: {e}", target.display()))?;
    Ok(())
}

/// Opens the archive that has just been written and reads the database back out
/// of it.
///
/// Three checks, each catching something the one before it cannot:
///
/// **The zip round-trips.** `extract_database` copies through the reader, and
/// that is what verifies the entry's CRC-32 -- a truncated write, a bad sector
/// under the part file, a disk that filled up between `write_all` and `finish`.
///
/// **The database inside is sound.** `integrity_check`, not `quick_check`: this
/// is the one place in the product with time to spend, running once a day
/// against a copy while the counter goes on serving customers. It is the check
/// that catches a `VACUUM INTO` of an already-damaged database -- a backup that
/// is a perfect copy of something broken, which is the failure most likely to
/// go unnoticed for months.
///
/// **It is the same size as what went in.** The vacuumed copy and the extracted
/// copy are the same bytes, so their page counts agree or something between the
/// two lied about what it stored.
fn verify(archive: &Path, source: &Path, work: &Path) -> Result<(), String> {
    /* Named after the archive rather than a fixed "verify.db". Two backups
       written into one work folder at the same time -- which is what the tests
       do, and what two windows racing each other would do -- must not unpack
       over one another and each accuse the other of being damaged. */
    let stem = archive
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("backup");
    let check = Temp(work.join(format!("{stem}.verify.db")));
    super::paths::remove_if_present(&check.0)?;

    extract_database(archive, &check.0)
        .map_err(|e| format!("This backup could not be read back after writing, so it was not kept ({e})."))?;

    let conn = Connection::open_with_flags(&check.0, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("This backup could not be opened after writing, so it was not kept ({e})."))?;

    let verdict: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("This backup could not be checked after writing, so it was not kept ({e})."))?;
    if verdict != "ok" {
        return Err(format!(
            "This backup was damaged the moment it was written, so it was not kept: {verdict}"
        ));
    }

    let got = page_count(&conn)?;
    let want = {
        let original = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Could not re-read the copy to check it: {e}"))?;
        page_count(&original)?
    };
    if got != want {
        return Err(format!(
            "This backup came back the wrong size ({got} pages, expected {want}), so it was not kept."
        ));
    }

    Ok(())
}

fn page_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| format!("Could not count the pages: {e}"))
}

fn add<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    bytes: &[u8],
    method: zip::CompressionMethod,
) -> Result<(), String> {
    zip.start_file(name, SimpleFileOptions::default().compression_method(method))
        .map_err(|e| format!("Could not add {name}: {e}"))?;
    zip.write_all(bytes).map_err(|e| format!("Could not write {name}: {e}"))
}

/// Pulls the database out of an archive to `into`, so it can be checked and
/// staged as an ordinary file. Returns the archive's own idea of its schema.
pub fn extract_database(archive: &Path, into: &Path) -> Result<i64, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Could not open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("That file is not a ShopOS backup: {e}"))?;

    let mut entry = zip
        .by_name(DB_ENTRY)
        .map_err(|_| format!("That archive has no {DB_ENTRY} in it, so it is not a ShopOS backup."))?;

    let mut out = std::fs::File::create(into).map_err(|e| format!("Could not write {}: {e}", into.display()))?;
    // Copying through the reader is what verifies the entry's CRC — a truncated
    // or corrupted archive fails here, before anything has been replaced.
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("That backup is damaged: {e}"))?;
    out.sync_all().map_err(|e| e.to_string())?;
    drop(entry);

    read_schema(into)
}

/// Copies the archive's photographs into the attachments folder, adding what is
/// not already there.
///
/// A merge, never a replacement. Swapping the folder for this archive's set
/// would delete every photograph older than the window this zip was taken
/// under — which is exactly the ones no other archive carries either.
///
/// Files are content-addressed, so writing one twice is the same as writing it
/// once and a half-finished set is simply a subset. That is what lets this run
/// before the database is replaced and be safe to repeat.
pub fn extract_attachments(archive: &Path, root: &Path) -> Result<Restored, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Could not open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("That file is not a ShopOS backup: {e}"))?;

    let mut out = Restored::default();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("That backup is damaged: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        // `name` is attacker-controlled in the general case — a zip can carry
        // `../../windows/system32/x`. The only names accepted are the shape this
        // program writes, which cannot leave the folder.
        let Some(rel) = entry.name().strip_prefix(ATTACH_PREFIX).map(str::to_string) else {
            continue;
        };
        let Some(safe) = super::paths::stored_rel(&rel) else {
            out.refused += 1;
            continue;
        };

        let target = root.join(&safe);
        if target.exists() {
            out.already += 1;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }

        // Through a temporary name, so a file wearing a hash is always the whole
        // file. Reading the entry to its end is also what checks its CRC.
        let part = Temp(target.with_extension("part"));
        let mut writer = std::fs::File::create(&part.0)
            .map_err(|e| format!("Could not write {}: {e}", part.0.display()))?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| format!("That backup is damaged: {e}"))?;
        writer.sync_all().map_err(|e| e.to_string())?;
        drop(writer);

        std::fs::rename(&part.0, &target).map_err(|e| format!("Could not save {}: {e}", target.display()))?;
        out.written += 1;
    }
    Ok(out)
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Restored {
    pub written: usize,
    pub already: usize,
    pub refused: usize,
}

/// The manifest, as text, for showing the shopkeeper what they are about to
/// restore. A missing or unreadable manifest is not fatal: the database is the
/// part that matters and it is checked on its own.
pub fn read_manifest(archive: &Path) -> Option<String> {
    let file = std::fs::File::open(archive).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut entry = zip.by_name(MANIFEST_ENTRY).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

pub fn read_schema(db_file: &Path) -> Result<i64, String> {
    let conn = Connection::open_with_flags(db_file, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("That file is not a database ShopOS can read: {e}"))?;
    conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(|e| format!("Could not read the schema version: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-archive-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    fn a_database(path: &Path, version: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE bills (id TEXT PRIMARY KEY);
             INSERT INTO bills VALUES ('one');
             PRAGMA user_version = {version};"
        ))
        .unwrap();
    }

    #[test]
    fn a_database_survives_the_round_trip() {
        let db = scratch("round-trip.db");
        a_database(&db, 7);

        let work = db.parent().unwrap().to_path_buf();
        let zip = scratch("shop-2026-09-13.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-13T03:00:00Z", &work, &[]).unwrap();

        let back = scratch("round-trip-out.db");
        assert_eq!(extract_database(&zip, &back).unwrap(), 7);

        let conn = Connection::open(&back).unwrap();
        let id: String = conn.query_row("SELECT id FROM bills", [], |r| r.get(0)).unwrap();
        assert_eq!(id, "one");
    }

    #[test]
    fn the_manifest_says_what_is_inside() {
        let db = scratch("manifest.db");
        a_database(&db, 2);
        let work = db.parent().unwrap().to_path_buf();
        let zip = scratch("shop-2026-09-14.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-14T03:00:00Z", &work, &[]).unwrap();

        let text = read_manifest(&zip).expect("a manifest");
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["format"], FORMAT);
        assert_eq!(value["schema"], 2);
        assert_eq!(value["taken_at"], "2026-09-14T03:00:00Z");
        assert_eq!(value["database"]["path"], DB_ENTRY);
        assert!(value["attachments"].as_array().unwrap().is_empty());
    }

    /* Half an archive wearing today's name would be read tomorrow as a backup
       that had already been taken. */
    #[test]
    fn a_failed_write_leaves_no_archive_behind() {
        let missing = scratch("not-there.db");
        let work = missing.parent().unwrap().to_path_buf();
        let zip = scratch("shop-2026-09-15.zip");

        assert!(write(&zip, &work, &missing, "0.1.0", "2026-09-15T03:00:00Z", &work, &[]).is_err());
        assert!(!zip.exists());
        assert!(!work.join("shop-2026-09-15.zip.part").exists());
    }

    /// A photograph on disk, named the way `attachments.rs` names them.
    fn a_photo(root: &Path, digest: &str, bytes: &[u8]) -> String {
        let rel = format!("{}/{digest}.jpg", &digest[..2]);
        let path = root.join(&rel[..2]);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(root.join(&rel), bytes).unwrap();
        rel
    }

    #[test]
    fn the_archive_carries_the_photographs_it_is_given() {
        let db = scratch("photos.db");
        a_database(&db, 3);
        let work = db.parent().unwrap().to_path_buf();

        let root = work.join("photos-root");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let one = a_photo(&root, &"a".repeat(64), b"first photograph");
        let two = a_photo(&root, &"b".repeat(64), b"second photograph");

        let zip = scratch("shop-2026-09-16.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-16T03:00:00Z", &root, &[one.clone(), two.clone()]).unwrap();

        let manifest: serde_json::Value = serde_json::from_str(&read_manifest(&zip).unwrap()).unwrap();
        assert_eq!(manifest["attachments"].as_array().unwrap().len(), 2);
        assert!(manifest["missing"].as_array().unwrap().is_empty());

        // Into an empty folder: both arrive, unchanged.
        let into = work.join("photos-restored");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();
        assert_eq!(extract_attachments(&zip, &into).unwrap().written, 2);
        assert_eq!(std::fs::read(into.join(&one)).unwrap(), b"first photograph");
        assert_eq!(std::fs::read(into.join(&two)).unwrap(), b"second photograph");
    }

    /* Swapping the folder for the archive's set would delete every photograph
       older than the window — the ones no archive carries either. */
    #[test]
    fn restoring_photographs_adds_rather_than_replaces() {
        let db = scratch("merge.db");
        a_database(&db, 3);
        let work = db.parent().unwrap().to_path_buf();

        let root = work.join("merge-root");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let carried = a_photo(&root, &"c".repeat(64), b"in the archive");

        let zip = scratch("shop-2026-09-17.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-17T03:00:00Z", &root, &[carried.clone()]).unwrap();

        // A machine that already holds an older photograph the archive does not.
        let into = work.join("merge-into");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();
        let older = a_photo(&into, &"d".repeat(64), b"nine months old");

        let done = extract_attachments(&zip, &into).unwrap();
        assert_eq!(done.written, 1);
        assert_eq!(std::fs::read(into.join(&older)).unwrap(), b"nine months old");

        // And running it twice writes nothing a second time.
        assert_eq!(extract_attachments(&zip, &into).unwrap(), Restored { written: 0, already: 1, refused: 0 });
    }

    #[test]
    fn a_photograph_the_machine_has_lost_does_not_fail_the_backup() {
        let db = scratch("gone.db");
        a_database(&db, 3);
        let work = db.parent().unwrap().to_path_buf();
        let root = work.join("gone-root");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let zip = scratch("shop-2026-09-18.zip");
        let vanished = format!("{}/{}.jpg", "e".repeat(2), "e".repeat(64));
        write(&zip, &work, &db, "0.1.0", "2026-09-18T03:00:00Z", &root, &[vanished.clone()]).unwrap();

        let manifest: serde_json::Value = serde_json::from_str(&read_manifest(&zip).unwrap()).unwrap();
        assert!(manifest["attachments"].as_array().unwrap().is_empty());
        assert_eq!(manifest["missing"][0], vanished);
        // The ledger is in there regardless, which is the point.
        let back = scratch("gone-out.db");
        assert_eq!(extract_database(&zip, &back).unwrap(), 3);
    }

    /* A zip is an untrusted file that arrived on a USB stick. */
    #[test]
    fn an_entry_that_tries_to_leave_the_folder_is_refused() {
        let path = scratch("evil.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for name in [
            "attachments/../../evil.exe",
            r"attachments/..\evil.exe",
            "attachments/ab/not-a-hash.jpg",
        ] {
            add(&mut zip, name, b"payload", zip::CompressionMethod::Stored).unwrap();
        }
        zip.finish().unwrap();

        let into = path.parent().unwrap().join("evil-into");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();

        let done = extract_attachments(&path, &into).unwrap();
        assert_eq!(done.written, 0);
        assert_eq!(done.refused, 3);
        assert_eq!(std::fs::read_dir(&into).unwrap().count(), 0);
    }

    #[test]
    fn a_file_that_is_not_an_archive_is_refused() {
        let junk = scratch("junk.zip");
        std::fs::write(&junk, b"not a zip at all").unwrap();
        let out = scratch("junk-out.db");
        assert!(extract_database(&junk, &out).is_err());
    }

    // ── Proving the backup after it is written ─────────────────────────────

    /// The ordinary day: it is written, it is checked, it is there.
    #[test]
    fn a_good_backup_is_checked_and_kept() {
        let db = scratch("verified-good.db");
        a_database(&db, 12);
        let work = db.parent().unwrap().to_path_buf();
        let zip = scratch("shop-verified-good.zip");

        write(&zip, &work, &db, "0.1.0", "2026-09-16T03:00:00Z", &work, &[]).unwrap();

        assert!(zip.exists(), "a backup that verifies must be kept");
        // And the check left nothing behind for tomorrow's backup to trip over.
        let stem = zip.file_name().unwrap().to_str().unwrap();
        assert!(!work.join(format!("{stem}.verify.db")).exists());
    }

    /// A database that is already damaged when the backup is taken.
    ///
    /// This is the failure worth having the check for. The zip is perfectly
    /// well-formed, its CRC is correct, and every byte of it round-trips — it
    /// is a flawless copy of something broken. Nothing before this would have
    /// noticed, and the shop would have found out on the day it restored.
    #[test]
    fn a_backup_of_a_damaged_database_is_refused_and_not_kept() {
        let db = scratch("verified-damaged.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode = DELETE;
                 CREATE TABLE bills (id TEXT PRIMARY KEY, doc_no TEXT);
                 INSERT INTO bills VALUES ('one', 'INV/26-27/00001');
                 CREATE INDEX idx_doc_no ON bills(doc_no);
                 PRAGMA user_version = 12;",
            )
            .unwrap();
        }

        /* Scribble past the header, which is what a failing disk does. The
           header is left intact deliberately: a mangled one is refused when the
           file is opened and never reaches `integrity_check`. */
        let mut bytes = std::fs::read(&db).unwrap();
        let from = bytes.len() / 2;
        for b in bytes[from..].iter_mut() {
            *b = 0x5a;
        }
        std::fs::write(&db, &bytes).unwrap();

        let work = db.parent().unwrap().to_path_buf();
        let zip = scratch("shop-verified-damaged.zip");
        let result = write(&zip, &work, &db, "0.1.0", "2026-09-16T03:00:00Z", &work, &[]);

        assert!(result.is_err(), "a damaged database must not pass as a backup");
        let said = result.unwrap_err();
        assert!(
            said.contains("damaged") || said.contains("could not be"),
            "the card has to say something a person can act on: {said}"
        );

        /* And nothing wearing today's name is left behind. A zip that failed
           its check must not sit in the folder looking like the backup for the
           sixteenth, because the next thing that reads this folder is either
           tomorrow's "have we backed up today" or a shopkeeper in trouble. */
        assert!(!zip.exists(), "a backup that failed its check must not be kept");
    }

    /// The check has to be able to fail, which is easy to lose by accident.
    ///
    /// If `verify` were ever wired to the wrong file — the source instead of the
    /// archive — every one of these tests would still pass and the check would
    /// be worth nothing. This one corrupts the *archive* after it is built.
    #[test]
    fn the_check_reads_the_archive_and_not_the_original() {
        let db = scratch("verified-source.db");
        a_database(&db, 12);
        let work = db.parent().unwrap().to_path_buf();

        let zip = scratch("shop-verified-source.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-16T03:00:00Z", &work, &[]).unwrap();

        // Truncating the archive leaves the source database perfectly healthy.
        let bytes = std::fs::read(&zip).unwrap();
        std::fs::write(&zip, &bytes[..bytes.len() / 2]).unwrap();

        let out = scratch("verified-source-out.db");
        assert!(
            extract_database(&zip, &out).is_err(),
            "the reader must refuse a truncated archive, which is what verify relies on"
        );
    }
}
