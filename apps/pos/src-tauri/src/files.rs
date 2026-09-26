/// Writing a file so that it is either all there or not there at all.
///
/// Three modules each had their own way of doing this, and each had left out a
/// different step. The ones that matter are the same everywhere: write under a
/// name nothing reads, push the bytes to the disk, and only then rename over the
/// real name. A rename that reaches the disk before the bytes do leaves a file
/// with the right name and nothing in it -- after a power cut, which is exactly
/// when somebody goes looking for it.
///
/// `std::fs::rename` replaces an existing target on Windows as well as
/// elsewhere, so none of this deletes the old file first. Deleting first opens
/// a window in which neither the old copy nor the new one exists.
use std::io::Write;
use std::path::{Path, PathBuf};

/// Removes its path when it goes out of scope, however it goes out of scope.
///
/// Every error path returns early, and SQLite refuses to vacuum into a file
/// that already exists -- so a temp left behind by a failure would break the
/// *next* backup rather than the one that failed.
pub struct Temp(pub PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The name a file is written under before it is renamed into place.
///
/// Beside the target, never in the work folder: a rename is only atomic within
/// one volume, and a USB stick is not the volume the work folder is on.
pub fn part_of(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    target.with_file_name(format!("{name}.part"))
}

/// Pushes a file's bytes to the disk.
///
/// Opened for writing because Windows will not flush a handle that was opened
/// only to read: `FlushFileBuffers` wants write access, and a read-only handle
/// fails with "access denied", which would read as a disk problem.
pub fn sync(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

/// Writes `bytes` to `target` through a `.part` beside it.
pub fn write_durably(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let part = Temp(part_of(target));
    let mut file = std::fs::File::create(&part.0)
        .map_err(|e| format!("Could not create {}: {e}", part.0.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("Could not write {}: {e}", part.0.display()))?;
    drop(file);
    std::fs::rename(&part.0, target).map_err(|e| format!("Could not save {}: {e}", target.display()))
}

/// Copies `source` to `target` through a `.part` beside the target.
///
/// A USB stick pulled out halfway through a plain copy leaves a file with the
/// backup's name and half its bytes, and the next person to find it trusts the
/// name.
pub fn copy_durably(source: &Path, target: &Path) -> Result<(), String> {
    let part = Temp(part_of(target));
    std::fs::copy(source, &part.0).map_err(|e| format!("Could not copy to {}: {e}", target.display()))?;
    sync(&part.0).map_err(|e| format!("Could not finish writing {}: {e}", target.display()))?;
    std::fs::rename(&part.0, target).map_err(|e| format!("Could not save {}: {e}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-files-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_durable_write_replaces_what_was_there_and_leaves_no_part() {
        let dir = scratch("write");
        let target = dir.join("RESTORE.json");
        std::fs::write(&target, b"old").unwrap();

        write_durably(&target, b"new").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(!part_of(&target).exists());
    }

    /* The copy that lands on a USB stick. What it must never do is leave the
       backup's own name on a file that is not the whole backup. */
    #[test]
    fn a_durable_copy_replaces_an_older_copy_and_leaves_no_part() {
        let dir = scratch("copy");
        let source = dir.join("source.zip");
        std::fs::write(&source, vec![7u8; 100_000]).unwrap();
        let target = dir.join("shop-2026-09-13.zip");
        std::fs::write(&target, b"yesterday's half-copied file").unwrap();

        copy_durably(&source, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), vec![7u8; 100_000]);
        assert!(!part_of(&target).exists());
    }

    #[test]
    fn a_copy_that_fails_leaves_neither_a_part_nor_a_new_file() {
        let dir = scratch("copy-fails");
        let target = dir.join("shop-2026-09-13.zip");

        assert!(copy_durably(&dir.join("not-there.zip"), &target).is_err());
        assert!(!target.exists());
        assert!(!part_of(&target).exists());
    }
}
