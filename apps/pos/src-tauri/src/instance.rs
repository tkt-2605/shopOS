/// One copy of ShopOS per shop folder.
///
/// Nothing stopped a second one before. A shopkeeper who double-clicks twice
/// -- which is most of them, on a slow machine -- got two windows on one
/// database, and the second one did everything the first had already done at
/// startup: swept the work folder out from under a backup the first was
/// writing, and applied any staged restore by renaming the database the first
/// one had open. On Windows the rename usually fails, and "usually" is the
/// wrong word to have anywhere near a shop's books.
///
/// The guard is a file in the data folder opened with no sharing at all, held
/// for the life of the process. Windows releases it when the process ends,
/// however it ends, so a crash cannot leave a stale lock behind the way a pid
/// file would. Per data folder rather than per machine, because two companies
/// on one machine are two folders and are meant to run side by side.
///
/// ## Why it waits before refusing
///
/// A restart is the one time two copies overlap on purpose. `restore_begin`
/// and the updater both restart the app, and Tauri starts the new process
/// *before* the old one exits -- so the new one arrives at this door while the
/// old one is still holding it, for a few hundred milliseconds. Refusing at
/// once would put "already open" on the screen after every restore, which is
/// the moment a shopkeeper is least able to shrug it off.
use std::path::Path;
use std::time::{Duration, Instant};

const LOCK_FILE: &str = "shopos.lock";

/// How long a new copy waits for an old one to finish exiting.
pub const RESTART_GRACE: Duration = Duration::from_secs(5);

/// Held for as long as this process owns the folder. Dropping it lets the
/// next copy in.
pub struct Held(#[allow(dead_code)] std::fs::File);

/// Managed only by the copy that won, so a command that must not run in a
/// second copy -- throwing away a staged restore -- can ask.
pub struct Instance(#[allow(dead_code)] pub Held);

/// Takes the folder, waiting up to `wait` for another copy to let go of it.
pub fn hold(dir: &Path, wait: Duration) -> Result<Held, String> {
    let path = dir.join(LOCK_FILE);
    let started = Instant::now();
    loop {
        match open_exclusive(&path) {
            Ok(file) => return Ok(Held(file)),
            Err(e) if is_held_elsewhere(&e) && started.elapsed() < wait => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) if is_held_elsewhere(&e) => {
                return Err(
                    "ShopOS is already open for this shop on this machine. Use the window \
                     that is already open, or close it and start ShopOS again."
                        .into(),
                )
            }
            Err(e) => return Err(format!("Could not open {}: {e}", path.display())),
        }
    }
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        // No sharing at all: while this handle is open, every other open of
        // the file fails with a sharing violation.
        .share_mode(0)
        .open(path)
}

/// Elsewhere the file is opened and nothing is excluded. ShopOS ships for
/// Windows; `File::try_lock` would do this properly and is newer than the
/// toolchain this crate promises to build on.
#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

fn is_held_elsewhere(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION, and ERROR_LOCK_VIOLATION for good measure.
    cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(33))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("shopos-instance-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_second_copy_on_the_same_folder_is_turned_away() {
        let dir = scratch("second");
        let first = hold(&dir, Duration::ZERO).unwrap();

        let said = hold(&dir, Duration::from_millis(200)).err().expect("the second copy must not get in");
        assert!(said.contains("already open"), "{said}");

        // And once the first has gone, the folder is free again.
        drop(first);
        assert!(hold(&dir, Duration::ZERO).is_ok());
    }

    /// Two companies on one machine are two folders, and both run.
    #[test]
    fn a_different_shop_is_not_held_up() {
        let a = hold(&scratch("shop-a"), Duration::ZERO).unwrap();
        let b = hold(&scratch("shop-b"), Duration::ZERO);
        assert!(b.is_ok());
        drop(a);
    }

    /// The restart after a restore: the old copy is still exiting when the new
    /// one arrives.
    #[test]
    fn a_restart_waits_for_the_copy_that_is_exiting() {
        let dir = scratch("restart");
        let old = hold(&dir, Duration::ZERO).unwrap();
        let exiting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(old);
        });

        let started = Instant::now();
        assert!(hold(&dir, RESTART_GRACE).is_ok(), "the new copy should get in once the old one leaves");
        assert!(started.elapsed() >= Duration::from_millis(200));
        exiting.join().unwrap();
    }
}
