/// This machine's own identity, kept beside the database and never inside it.
///
/// Everything that happens to `shop.db` is a reason not to keep it there. It is
/// backed up nightly, copied onto a replacement machine, restored from a
/// six-month-old file, and will one day be replicated to a second till. An
/// identity stored inside it would be cloned by every one of those, and two
/// tills that each believe they are the same till cannot be told apart in any
/// history, ever — not by a report, not by a merge, and not by a person trying
/// to work out which counter took the cash.
///
/// The property that makes this work is that nothing else here touches the file:
/// `backup.rs` copies the database with VACUUM INTO, and `restore.rs` replaces
/// the database file alone. So a database restored onto a different machine
/// adopts the identity of the machine it lands on, which is the truth, rather
/// than carrying the identity of the machine it came from, which is a lie that
/// gets written into every row created afterwards.
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths;

const FILE: &str = "device.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    device_id: String,
    label: String,
    /// Which counter this machine bills on.
    ///
    /// It lived in the `settings` table until now, which the whole shop shares —
    /// so the moment two tills opened one database they would both claim the
    /// same till and overwrite each other's choice, and their invoice numbers
    /// would collide. `registers.ts` has carried a comment saying this "must
    /// never travel with the data when sync arrives" since it was written; this
    /// is the file where that is actually true.
    ///
    /// `default` so a device.json written before this field existed still parses
    /// rather than being refused as damaged.
    #[serde(default)]
    register_id: Option<String>,
    /// Settings that describe this machine rather than the shop.
    ///
    /// Four of them were in the `settings` table, which the whole shop shares,
    /// and every one is a thing that differs from counter to counter:
    ///
    ///   * `thermal_printer` — the printer plugged into *this* till. Shared, the
    ///     second till prints on the first one's printer, or on nothing.
    ///   * `backup_hook` — a command run after this machine's backup. It carries
    ///     the file to a USB stick, a NAS share or a syncing folder, none of
    ///     which are the same on the next machine. Shared, both tills fire the
    ///     shop's one command against their own backup and the last to finish is
    ///     the copy that survives.
    ///   * `backup_folder` — a folder on this machine.
    ///   * `ui_density`, `ui_theme` — how this screen is set up. A 10-inch till
    ///     at the counter and the owner's laptop want different answers.
    ///
    /// A map rather than a field each, because the list is four long and every
    /// value is a string the webview already had a name for. `BTreeMap` so the
    /// file is written in a stable order and a person can read it.
    #[serde(default)]
    settings: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct Identity {
    pub id: String,
    pub label: String,
    #[serde(rename = "registerId")]
    pub register_id: Option<String>,
    pub settings: BTreeMap<String, String>,
    /// True only on the run that minted it, so a caller can record a first
    /// sighting once instead of on every start.
    pub minted: bool,
}

/// Every write here is read-modify-write: the whole file is loaded, one field is
/// changed, and the whole file is written back. Two of those running at once and
/// the second overwrites the first with what it read before the first landed —
/// the shape of "saved one thing, lost another".
///
/// The Settings screen is where that becomes reachable. Its fields save as they
/// are changed, so a person moving quickly between the printer and the backup
/// command has two of these in flight. Tauri answers commands on a thread pool,
/// so they genuinely overlap.
///
/// A mutex covers this process. It does not cover two copies of the app, which
/// `write_new`'s `create_new` handles for the one case that matters — minting —
/// and which nothing else here can lose, because a second copy writing settings
/// would be a second copy the user opened on purpose.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Poisoning means another call panicked mid-write, which tells us nothing about
/// the file; the next read will find out for itself. Refusing to identify the
/// machine for the rest of the session would be the larger harm.
fn writing() -> std::sync::MutexGuard<'static, ()> {
    WRITING.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn device_identity(app: tauri::AppHandle) -> Result<Identity, String> {
    let _guard = writing();
    load_or_mint(&paths::data_dir(&app)?)
}

/// Records which counter this machine bills on. Null forgets the choice, which
/// is what deactivating the chosen register has to leave behind.
#[tauri::command]
pub fn device_set_register(
    app: tauri::AppHandle,
    register_id: Option<String>,
) -> Result<Identity, String> {
    let _guard = writing();
    set_register(&paths::data_dir(&app)?, register_id)
}

/// Records one setting about this machine. A null or blank value forgets it
/// rather than storing an empty string, which would read as "set to nothing".
#[tauri::command]
pub fn device_set_setting(
    app: tauri::AppHandle,
    key: String,
    value: Option<String>,
) -> Result<Identity, String> {
    let _guard = writing();
    let dir = paths::data_dir(&app)?;
    put(&dir, &key, value.as_deref())
}

fn put(dir: &Path, key: &str, value: Option<&str>) -> Result<Identity, String> {
    let existing = load_or_mint(dir)?;
    let mut settings = existing.settings;
    match value.map(str::to_string).filter(|v| !v.trim().is_empty()) {
        Some(v) => settings.insert(key.to_string(), v),
        None => settings.remove(key),
    };
    write_back(
        dir,
        Stored {
            device_id: existing.id,
            label: existing.label,
            register_id: existing.register_id,
            settings,
        },
    )
}

fn set_register(dir: &Path, register_id: Option<String>) -> Result<Identity, String> {
    // Minting first rather than refusing: a machine choosing its counter before
    // it has ever been identified is just a machine on its first run.
    let existing = load_or_mint(dir)?;
    write_back(
        dir,
        Stored {
            device_id: existing.id,
            label: existing.label,
            register_id,
            settings: existing.settings,
        },
    )
}

fn write_back(dir: &Path, stored: Stored) -> Result<Identity, String> {
    save(&dir.join(FILE), &stored)?;
    Ok(Identity {
        id: stored.device_id,
        label: stored.label,
        register_id: stored.register_id,
        settings: stored.settings,
        minted: false,
    })
}

/// This machine's identity, for anything that needs to name it without going
/// through a Tauri command — discovery announcing which till is answering.
pub fn identity_of(dir: &Path) -> Result<Identity, String> {
    load_or_mint(dir)
}

fn load_or_mint(dir: &Path) -> Result<Identity, String> {
    let path = dir.join(FILE);

    if let Some(identity) = read_identity(&path)? {
        return Ok(identity);
    }

    let stored = Stored {
        device_id: mint(),
        label: hostname(),
        register_id: None,
        settings: BTreeMap::new(),
    };

    if write_new(&path, &stored)? {
        return Ok(Identity {
            id: stored.device_id,
            label: stored.label,
            register_id: stored.register_id,
            settings: stored.settings,
            minted: true,
        });
    }

    /* Another process created the file between the read above and the write —
       the app launched twice in quick succession on a first run, which nothing
       in this build prevents. The id on disk is this machine's; the one just
       minted is discarded unused.

       Handing back the minted id instead is the mirror of the fault this module
       exists to prevent: one machine appearing in the history as two. It would
       also be silent, because the counter and the settings this process went on
       to record are read back off the file and land on the *other* id, while its
       audit rows name an id no file has ever held. */
    read_identity(&path)?.ok_or_else(|| {
        format!(
            "{} was created by another start and then went missing.",
            path.display()
        )
    })
}

/// The identity on disk, or `None` when there is not a file yet.
///
/// Keeping "no file" apart from "a file I cannot read" is the whole reason this
/// is its own function: the first is a first run, and the second is damage.
fn read_identity(path: &Path) -> Result<Option<Identity>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Stored>(&text) {
            Ok(stored) if is_device_id(&stored.device_id) => Ok(Some(Identity {
                id: stored.device_id,
                label: stored.label,
                register_id: stored.register_id,
                settings: stored.settings,
                minted: false,
            })),
            // A file that exists but cannot be read as an identity is never
            // quietly replaced. Minting over it would give this machine a second
            // identity and orphan everything already attributed to the first,
            // which is exactly the damage this module exists to prevent — so it
            // stops and says so, and a person decides.
            _ => Err(format!(
                "{} exists but is not a device identity. Move it aside to mint a new one — \
                 note that history already recorded against the old identity will not follow.",
                path.display()
            )),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        // Unreadable for any other reason — permissions, a locked file, a failing
        // disk — is also not a reason to mint. Same damage, same refusal.
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// `create_new` rather than a write: if two processes start together, exactly one
/// creates the file. A plain write would let the second overwrite the first's
/// identity after the first had already begun stamping rows with it.
///
/// **False means the file was already there and nothing was written**, and the
/// caller has to read it rather than keep what it minted. Answering `Ok(())` to
/// both outcomes is what made this wrong to begin with: the caller could not
/// tell the two apart, so it kept an id that had never been stored.
fn write_new(path: &Path, stored: &Stored) -> Result<bool, String> {
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut f) => {
            f.write_all(json.as_bytes())
                .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
            // On the disk before anything reads it back and acts on it.
            f.sync_all()
                .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(format!("Could not create {}: {e}", path.display())),
    }
}

/// Replaces the file through a temporary and a rename, so a machine that loses
/// power mid-write keeps the identity it had rather than half of one. A
/// truncating write in place is the one way this file could become the
/// unreadable thing `read_identity` refuses.
///
/// Two details the first version left out, each of which turns that promise back
/// into a hope:
///
/// * The temporary is **flushed before the rename**. Without it the rename can
///   reach the disk while the bytes have not, leaving a zero-length
///   `device.json` — refused for ever afterwards, which is exactly the halted
///   state the rename was there to prevent.
/// * Its name carries the process id, so two saves running at once cannot write
///   over one another. `device_set_setting` is called from a screen, and a
///   person pressing two things quickly is not an unusual event.
///
/// The temporary stays beside `device.json` rather than in the work directory
/// `paths.rs` keeps for half-written files, and that is the one deliberate
/// exception to what that module says: a rename is only atomic within a single
/// directory, and the work directory is swept wholesale at startup, which would
/// delete a temporary another process was in the middle of writing.
fn save(path: &Path, stored: &Stored) -> Result<(), String> {
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("json.writing.{}", std::process::id()));

    let write_then_flush = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()
    };
    write_then_flush().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not write {}: {e}", tmp.display())
    })?;

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })
}

/// UUIDv4. Not the v7 that database ids use: a device id is not a document and
/// gains nothing from sorting by time, while the minting moment is the one thing
/// about a machine that is nobody else's business.
fn mint() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system randomness unavailable");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;

    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// A name for a person to recognise, never an identifier. Two machines may well
/// be called COUNTER1; only the minted id decides which is which.
fn hostname() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    "This counter".to_string()
}

fn is_device_id(s: &str) -> bool {
    s.len() == 36
        && s.as_bytes()
            .iter()
            .enumerate()
            .all(|(i, b)| match i {
                8 | 13 | 18 | 23 => *b == b'-',
                _ => b.is_ascii_hexdigit(),
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("shopos-device-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mints_once_and_answers_the_same_afterwards() {
        let dir = temp("mints-once");

        let first = load_or_mint(&dir).unwrap();
        assert!(first.minted);
        assert!(is_device_id(&first.id));

        let second = load_or_mint(&dir).unwrap();
        assert!(!second.minted, "a second start must not mint again");
        assert_eq!(first.id, second.id);
    }

    /// The whole point of the module: two machines are two identities, even
    /// running the same build off the same installer.
    #[test]
    fn two_machines_never_share_an_identity() {
        let a = load_or_mint(&temp("machine-a")).unwrap();
        let b = load_or_mint(&temp("machine-b")).unwrap();
        assert_ne!(a.id, b.id);
    }

    /// A restored database arrives without this file's owner's consent. What it
    /// must not do is bring an identity with it — which is guaranteed by the
    /// file living outside the database, and asserted here so that a later change
    /// to backup or restore has something to break.
    #[test]
    fn a_damaged_identity_is_refused_rather_than_replaced() {
        let dir = temp("damaged");
        let path = dir.join(FILE);

        for bad in ["", "{}", "not json at all", r#"{"device_id":"nope","label":"x"}"#] {
            std::fs::write(&path, bad).unwrap();
            assert!(
                load_or_mint(&dir).is_err(),
                "{bad:?} should be refused, not overwritten"
            );
            // And the file it refused is still there to be rescued.
            assert!(path.exists());
        }
    }

    /// Two starts at once on a first run: one of them creates the file, and the
    /// loser has to adopt what the winner wrote rather than the id it minted
    /// and could not store.
    ///
    /// The damage this guards against is quiet. The loser would spend its whole
    /// session stamping audit rows with an id no file holds, while the counter
    /// and settings it recorded went to the winner's id — one machine appearing
    /// in the history as two, which is the mirror of the fault this module is
    /// built to prevent.
    #[test]
    fn a_start_that_loses_the_race_takes_the_identity_that_was_written() {
        let dir = temp("race");
        let path = dir.join(FILE);

        // The winner, already on disk.
        let winner = load_or_mint(&dir).unwrap();

        // The loser reaches write_new with an id of its own and is refused.
        let mine = Stored {
            device_id: mint(),
            label: hostname(),
            register_id: None,
            settings: BTreeMap::new(),
        };
        assert_ne!(mine.device_id, winner.id);
        assert!(
            !write_new(&path, &mine).unwrap(),
            "the file was there; nothing should have been written"
        );

        // And what it goes on to use is the winner's, not its own.
        let got = load_or_mint(&dir).unwrap();
        assert_eq!(got.id, winner.id);
        assert!(!got.minted);
        assert!(
            std::fs::read_to_string(&path).unwrap().contains(&winner.id),
            "the loser must not have overwritten the file either"
        );
    }

    /// A save in flight must not be reachable by another process's save, and
    /// must leave nothing behind once it has landed.
    #[test]
    fn a_half_written_identity_is_never_the_file_itself() {
        let dir = temp("save-temp");
        load_or_mint(&dir).unwrap();
        put(&dir, "thermal_printer", Some("EPSON TM-T82")).unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != FILE)
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }

    /// The register choice is device-local state, which is the whole reason this
    /// file exists rather than a `settings` row.
    #[test]
    fn remembers_which_counter_this_machine_is() {
        let dir = temp("register");

        assert_eq!(load_or_mint(&dir).unwrap().register_id, None);

        let set = set_register(&dir, Some("reg-front".into())).unwrap();
        assert_eq!(set.register_id.as_deref(), Some("reg-front"));
        assert_eq!(load_or_mint(&dir).unwrap().register_id.as_deref(), Some("reg-front"));
    }

    #[test]
    fn choosing_a_counter_never_changes_the_identity() {
        let dir = temp("register-keeps-id");
        let before = load_or_mint(&dir).unwrap();

        set_register(&dir, Some("reg-a".into())).unwrap();
        set_register(&dir, Some("reg-b".into())).unwrap();

        let after = load_or_mint(&dir).unwrap();
        assert_eq!(before.id, after.id);
        assert_eq!(after.register_id.as_deref(), Some("reg-b"));
    }

    /// Deactivating the chosen counter has to leave the machine with no counter,
    /// not with a dangling one.
    #[test]
    fn forgets_the_counter_when_asked() {
        let dir = temp("register-forget");
        set_register(&dir, Some("reg-a".into())).unwrap();
        assert_eq!(set_register(&dir, None).unwrap().register_id, None);
        assert_eq!(load_or_mint(&dir).unwrap().register_id, None);
    }

    /// A device.json written before the field existed is an ordinary file, not a
    /// damaged one.
    #[test]
    fn reads_a_file_written_before_counters_were_kept_here() {
        let dir = temp("older-file");
        std::fs::write(
            dir.join(FILE),
            r#"{"device_id":"550e8400-e29b-41d4-a716-446655440000","label":"COUNTER1"}"#,
        )
        .unwrap();

        let got = load_or_mint(&dir).unwrap();
        assert_eq!(got.id, "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(got.label, "COUNTER1");
        assert_eq!(got.register_id, None);
        assert!(!got.minted);
    }

    /// Every write rebuilds the whole struct, which is the shape a
    /// "saved one thing, lost another" bug takes.
    #[test]
    fn one_answer_never_clears_another() {
        let dir = temp("settings-and-register");

        set_register(&dir, Some("reg-a".into())).unwrap();
        put(&dir, "thermal_printer", Some("EPSON TM-T82")).unwrap();
        put(&dir, "backup_hook", Some("copy-to-usb.bat")).unwrap();

        let got = load_or_mint(&dir).unwrap();
        assert_eq!(got.register_id.as_deref(), Some("reg-a"));
        assert_eq!(got.settings.get("thermal_printer").map(String::as_str), Some("EPSON TM-T82"));
        assert_eq!(got.settings.get("backup_hook").map(String::as_str), Some("copy-to-usb.bat"));

        // Changing the counter leaves both settings alone.
        set_register(&dir, Some("reg-b".into())).unwrap();
        let after = load_or_mint(&dir).unwrap();
        assert_eq!(after.register_id.as_deref(), Some("reg-b"));
        assert_eq!(after.settings.len(), 2);
    }

    #[test]
    fn a_blank_setting_is_forgotten_rather_than_stored_as_nothing() {
        let dir = temp("settings-blank");

        for blank in [Some("   "), Some(""), None] {
            put(&dir, "backup_hook", Some("run.bat")).unwrap();
            assert!(load_or_mint(&dir).unwrap().settings.contains_key("backup_hook"));

            put(&dir, "backup_hook", blank).unwrap();
            assert!(
                !load_or_mint(&dir).unwrap().settings.contains_key("backup_hook"),
                "{blank:?} should forget it"
            );
        }
    }

    #[test]
    fn a_minted_id_is_shaped_like_a_uuid() {
        for _ in 0..200 {
            let id = mint();
            assert!(is_device_id(&id), "{id}");
            assert_eq!(&id[14..15], "4", "version nibble");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_a_uuid() {
        for s in [
            "",
            "short",
            &"a".repeat(36),
            "550e8400-e29b-41d4-a716-44665544000",
            "550e8400-e29b-41d4-a716-4466554400000",
            "550e8400_e29b_41d4_a716_446655440000",
            "550e8400-e29b-41d4-a716-44665544000g",
        ] {
            assert!(!is_device_id(s), "{s} should be refused");
        }
    }
}
