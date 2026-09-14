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
}

#[derive(Serialize)]
pub struct Identity {
    pub id: String,
    pub label: String,
    #[serde(rename = "registerId")]
    pub register_id: Option<String>,
    /// True only on the run that minted it, so a caller can record a first
    /// sighting once instead of on every start.
    pub minted: bool,
}

#[tauri::command]
pub fn device_identity(app: tauri::AppHandle) -> Result<Identity, String> {
    load_or_mint(&paths::data_dir(&app)?)
}

/// Records which counter this machine bills on. Null forgets the choice, which
/// is what deactivating the chosen register has to leave behind.
#[tauri::command]
pub fn device_set_register(
    app: tauri::AppHandle,
    register_id: Option<String>,
) -> Result<Identity, String> {
    set_register(&paths::data_dir(&app)?, register_id)
}

fn set_register(dir: &Path, register_id: Option<String>) -> Result<Identity, String> {
    // Minting first rather than refusing: a machine choosing its counter before
    // it has ever been identified is just a machine on its first run.
    let existing = load_or_mint(dir)?;
    let stored = Stored {
        device_id: existing.id,
        label: existing.label,
        register_id,
    };
    save(&dir.join(FILE), &stored)?;
    Ok(Identity {
        id: stored.device_id,
        label: stored.label,
        register_id: stored.register_id,
        minted: false,
    })
}

fn load_or_mint(dir: &Path) -> Result<Identity, String> {
    let path = dir.join(FILE);

    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Stored>(&text) {
            Ok(stored) if is_device_id(&stored.device_id) => Ok(Identity {
                id: stored.device_id,
                label: stored.label,
                register_id: stored.register_id,
                minted: false,
            }),
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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let stored = Stored {
                device_id: mint(),
                label: hostname(),
                register_id: None,
            };
            write_new(&path, &stored)?;
            Ok(Identity {
                id: stored.device_id,
                label: stored.label,
                register_id: stored.register_id,
                minted: true,
            })
        }
        // Unreadable for any other reason — permissions, a locked file, a failing
        // disk — is also not a reason to mint. Same damage, same refusal.
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// `create_new` rather than a write: if two processes start together, exactly one
/// creates the file and the other is told it exists and re-reads it. A plain
/// write would let the second overwrite the first's identity after the first had
/// already begun stamping rows with it.
fn write_new(path: &Path, stored: &Stored) -> Result<(), String> {
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut f) => f
            .write_all(json.as_bytes())
            .map_err(|e| format!("Could not write {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("Could not create {}: {e}", path.display())),
    }
}

/// Replaces the file through a temporary and a rename, so a machine that loses
/// power mid-write keeps the identity it had rather than half of one. A
/// truncating write in place is the one way this file could become the
/// unreadable thing `load_or_mint` refuses.
fn save(path: &Path, stored: &Stored) -> Result<(), String> {
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.writing");
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
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
