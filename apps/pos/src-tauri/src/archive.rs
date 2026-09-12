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

#[derive(Serialize)]
struct Manifest {
    format: u32,
    app: String,
    /// The database's `user_version`, so a restore can refuse a file this build
    /// is too old to understand before it touches anything.
    schema: i64,
    taken_at: String,
    database: Entry,
    /// Empty until attachments exist; present from the first archive so a reader
    /// written today does not need a second format version to find it missing.
    attachments: Vec<Entry>,
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
pub fn write(target: &Path, work: &Path, db_file: &Path, app_version: &str, taken_at: &str) -> Result<(), String> {
    let schema = read_schema(db_file)?;
    let bytes = std::fs::read(db_file).map_err(|e| format!("Could not read the copy: {e}"))?;

    let part = Temp(work.join(format!(
        "{}.part",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("backup.zip")
    )));
    let file = std::fs::File::create(&part.0).map_err(|e| format!("Could not create {}: {e}", part.0.display()))?;
    let mut zip = zip::ZipWriter::new(file);

    let manifest = Manifest {
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
    };
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("Could not write the manifest: {e}"))?;

    // The manifest is stored rather than deflated so it can be read out of a
    // damaged archive with nothing more than a text editor.
    add(&mut zip, MANIFEST_ENTRY, &manifest_json, zip::CompressionMethod::Stored)?;
    // A SQLite file is mostly empty pages and repeated structure; it compresses
    // to a fraction. Images, when they arrive, will be stored instead.
    add(&mut zip, DB_ENTRY, &bytes, zip::CompressionMethod::Deflated)?;

    zip.finish().map_err(|e| format!("Could not finish the archive: {e}"))?;
    drop(bytes);

    super::paths::remove_if_present(target)?;
    std::fs::rename(&part.0, target).map_err(|e| format!("Could not save {}: {e}", target.display()))?;
    Ok(())
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
        write(&zip, &work, &db, "0.1.0", "2026-09-13T03:00:00Z").unwrap();

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
        write(&zip, &work, &db, "0.1.0", "2026-09-14T03:00:00Z").unwrap();

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

        assert!(write(&zip, &work, &missing, "0.1.0", "2026-09-15T03:00:00Z").is_err());
        assert!(!zip.exists());
        assert!(!work.join("shop-2026-09-15.zip.part").exists());
    }

    #[test]
    fn a_file_that_is_not_an_archive_is_refused() {
        let junk = scratch("junk.zip");
        std::fs::write(&junk, b"not a zip at all").unwrap();
        let out = scratch("junk-out.db");
        assert!(extract_database(&junk, &out).is_err());
    }
}
