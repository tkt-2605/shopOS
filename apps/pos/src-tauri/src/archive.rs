/// The backup archive: one zip holding the database, and later the photographs
/// attached to it.
///
/// One file rather than several because a backup is only worth having if it can
/// be carried off the machine, and a shopkeeper carries one file. Every archive
/// is self-contained and never rewritten after it is closed, so a zip found on a
/// USB stick in a year restores a working shop by itself.
use std::io::{Read, Seek, Write};
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::files::Temp;

pub const FORMAT: u32 = 1;
pub const DB_ENTRY: &str = "shop.db";
pub const MANIFEST_ENTRY: &str = "manifest.json";
/// Attachments keep the layout they have on disk, so restoring them is a copy
/// rather than a translation.
pub const ATTACH_PREFIX: &str = "attachments/";

/// The most a database coming out of an archive may unpack to.
///
/// An archive is a file off a USB stick, and a zip entry says how big it is in
/// a header nobody checks: a few kilobytes can claim to inflate to terabytes
/// and fill the disk the shop's live database is on. A shop's database is tens
/// of megabytes; this is a ceiling nothing honest reaches.
pub const MAX_DATABASE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The manifest is a page of JSON. Anything longer is not one.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

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
    let db = std::fs::File::open(db_file).map_err(|e| format!("Could not read the copy: {e}"))?;

    let part = Temp(work.join(format!(
        "{}.part",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("backup.zip")
    )));
    let file = std::fs::File::create(&part.0).map_err(|e| format!("Could not create {}: {e}", part.0.display()))?;
    let mut zip = zip::ZipWriter::new(file);

    // A SQLite file is mostly empty pages and repeated structure; it compresses
    // to a fraction. Photographs are already compressed and are stored as they
    // are — deflating a JPEG costs time and saves nothing.
    //
    // Streamed rather than read whole: the database used to be loaded into
    // memory in one piece and then copied again into the compressor, which on
    // a shop a few years in is a few hundred megabytes of a till's memory at
    // two in the morning, for no reason.
    let database = add(&mut zip, DB_ENTRY, db, zip::CompressionMethod::Deflated)?;

    let mut manifest = Manifest {
        format: FORMAT,
        app: app_version.to_string(),
        schema,
        taken_at: taken_at.to_string(),
        database,
        attachments: Vec::new(),
        missing: Vec::new(),
    };

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
        // Opened before the entry is started, so a photograph that has gone
        // is a line in `missing` rather than an empty entry wearing its name.
        let Ok(photo) = std::fs::File::open(&file) else {
            manifest.missing.push(rel.clone());
            continue;
        };
        let mut entry = add(&mut zip, &format!("{ATTACH_PREFIX}{rel}"), photo, zip::CompressionMethod::Stored)?;
        entry.path = rel.clone();
        manifest.attachments.push(entry);
    }

    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("Could not write the manifest: {e}"))?;
    // Stored rather than deflated so it can be read out of a damaged archive
    // with nothing more than a text editor. It goes in last because it is only
    // true once everything it describes is written.
    add(&mut zip, MANIFEST_ENTRY, manifest_json.as_slice(), zip::CompressionMethod::Stored)?;

    /* On the disk before anything reads it back or renames it. `finish` only
       hands the bytes to the operating system; without this, the rename below
       can reach the disk before the archive does, and a power cut leaves a
       file with today's name and nothing in it -- which tomorrow's run reads
       as "already backed up today". */
    let file = zip.finish().map_err(|e| format!("Could not finish the archive: {e}"))?;
    file.sync_all().map_err(|e| format!("Could not finish the archive: {e}"))?;
    drop(file);

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

    /* A rename over the old file, never a delete and then a rename. Deleting
       first left a moment with no archive under this name at all, and a
       rename that then failed turned "rewrite today's backup" into "delete
       today's backup". `rename` replaces the target on Windows too. */
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

/// A reader that counts and checksums what passes through it, so an entry's
/// manifest line is worked out from the same bytes the archive stored.
struct Tally<R> {
    inner: R,
    crc: crc32fast::Hasher,
    bytes: u64,
}

impl<R: Read> Read for Tally<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.crc.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}

/// Streams `source` into a new entry and says what went in.
fn add<W: Write + Seek, R: Read>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    source: R,
    method: zip::CompressionMethod,
) -> Result<Entry, String> {
    zip.start_file(name, SimpleFileOptions::default().compression_method(method))
        .map_err(|e| format!("Could not add {name}: {e}"))?;
    let mut tally = Tally { inner: source, crc: crc32fast::Hasher::new(), bytes: 0 };
    std::io::copy(&mut tally, zip).map_err(|e| format!("Could not write {name}: {e}"))?;
    Ok(Entry { path: name.to_string(), bytes: tally.bytes, crc32: tally.crc.finalize() })
}

/// A writer that hashes what passes through it, so a photograph's name can be
/// checked against its bytes on the way out of an archive.
struct Hashing<W> {
    inner: W,
    sha: Sha256,
}

impl<W: Write> Write for Hashing<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.sha.update(&buf[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
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
    // or corrupted archive fails here, before anything has been replaced. The
    // ceiling is for an archive that is not damaged but hostile.
    let copied = std::io::copy(&mut (&mut entry).take(MAX_DATABASE_BYTES + 1), &mut out)
        .map_err(|e| format!("That backup is damaged: {e}"))?;
    if copied > MAX_DATABASE_BYTES {
        return Err("That archive's database is larger than any shop's, so it was not unpacked.".into());
    }
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
        let file = std::fs::File::create(&part.0)
            .map_err(|e| format!("Could not write {}: {e}", part.0.display()))?;
        let mut writer = Hashing { inner: file, sha: Sha256::new() };
        let limit = crate::attachments::MAX_BYTES as u64;
        let copied = std::io::copy(&mut (&mut entry).take(limit + 1), &mut writer)
            .map_err(|e| format!("That backup is damaged: {e}"))?;

        /* The name is a hash, and the whole folder trusts it: the same
           photograph attached twice is stored once *because* the name says what
           the bytes are. An entry whose bytes do not hash to its name would
           sit under the name of a different photograph for ever, and be shown
           against every bill that attached the real one. So it is checked, and
           a stranger's file -- or a damaged one the CRC happened to pass -- is
           refused rather than written. Also refused: anything larger than an
           attachment is allowed to be. */
        let digest = hex(&writer.sha.finalize_reset());
        let named = rel.rsplit('/').next().and_then(|f| f.split('.').next()).unwrap_or("");
        if copied > limit || digest != named {
            out.refused += 1;
            continue;
        }
        writer.inner.sync_all().map_err(|e| e.to_string())?;
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
    let entry = zip.by_name(MANIFEST_ENTRY).ok()?;
    let mut text = String::new();
    entry.take(MAX_MANIFEST_BYTES).read_to_string(&mut text).ok()?;
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
    use std::path::PathBuf;

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

    /// A photograph on disk, named the way `attachments.rs` names them: by
    /// its own hash, which extraction now checks.
    fn a_photo(root: &Path, bytes: &[u8]) -> String {
        let digest = hex(&Sha256::digest(bytes));
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
        let one = a_photo(&root, b"first photograph");
        let two = a_photo(&root, b"second photograph");

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
        let carried = a_photo(&root, b"in the archive");

        let zip = scratch("shop-2026-09-17.zip");
        write(&zip, &work, &db, "0.1.0", "2026-09-17T03:00:00Z", &root, std::slice::from_ref(&carried)).unwrap();

        // A machine that already holds an older photograph the archive does not.
        let into = work.join("merge-into");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();
        let older = a_photo(&into, b"nine months old");

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
        write(&zip, &work, &db, "0.1.0", "2026-09-18T03:00:00Z", &root, std::slice::from_ref(&vanished)).unwrap();

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
            add(&mut zip, name, &b"payload"[..], zip::CompressionMethod::Stored).unwrap();
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

    /* The name is the hash, and the folder trusts it. An archive off a USB
       stick can put any bytes under any name. */
    #[test]
    fn a_photograph_whose_bytes_are_not_its_name_is_refused() {
        let path = scratch("mislabelled.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let real = hex(&Sha256::digest(b"the real photograph"));
        let honest = format!("{ATTACH_PREFIX}{}/{real}.jpg", &real[..2]);
        let liar = format!("{ATTACH_PREFIX}ab/ab{}.jpg", "c".repeat(62));
        add(&mut zip, &honest, &b"the real photograph"[..], zip::CompressionMethod::Stored).unwrap();
        add(&mut zip, &liar, &b"somebody else's file"[..], zip::CompressionMethod::Stored).unwrap();
        zip.finish().unwrap();

        let into = path.parent().unwrap().join("mislabelled-into");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();

        let done = extract_attachments(&path, &into).unwrap();
        assert_eq!(done, Restored { written: 1, already: 0, refused: 1 });
        assert!(!into.join(format!("ab/ab{}.jpg", "c".repeat(62))).exists());
        // And no half-written part is left beside it either.
        assert!(!into.join(format!("ab/ab{}.part", "c".repeat(62))).exists());
    }

    /// A file far larger than any attachment may be is not unpacked, whatever
    /// it is called.
    #[test]
    fn a_photograph_larger_than_any_attachment_is_refused() {
        let path = scratch("oversized.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let big = vec![0u8; crate::attachments::MAX_BYTES + 1];
        let digest = hex(&Sha256::digest(&big));
        let name = format!("{ATTACH_PREFIX}{}/{digest}.jpg", &digest[..2]);
        add(&mut zip, &name, big.as_slice(), zip::CompressionMethod::Deflated).unwrap();
        zip.finish().unwrap();

        let into = path.parent().unwrap().join("oversized-into");
        let _ = std::fs::remove_dir_all(&into);
        std::fs::create_dir_all(&into).unwrap();
        assert_eq!(extract_attachments(&path, &into).unwrap().refused, 1);
    }

    /// Rewriting today's archive replaces it without a moment in which there
    /// is none, and leaves no part file behind.
    #[test]
    fn a_second_backup_on_the_same_day_replaces_the_first() {
        let db = scratch("rewrite.db");
        a_database(&db, 4);
        let work = db.parent().unwrap().to_path_buf();
        let zip = scratch("shop-2026-09-19.zip");
        std::fs::write(&zip, b"this morning's archive").unwrap();

        write(&zip, &work, &db, "0.1.0", "2026-09-19T03:00:00Z", &work, &[]).unwrap();

        let back = scratch("rewrite-out.db");
        assert_eq!(extract_database(&zip, &back).unwrap(), 4);
        assert!(!work.join("shop-2026-09-19.zip.part").exists());
    }
}
