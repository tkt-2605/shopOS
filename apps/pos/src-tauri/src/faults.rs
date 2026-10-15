//! What went wrong on this machine, counted: how many times the app started
//! and how each run ended, and every error grouped by what kind of error it
//! was. It goes out in the health report as `faults.json`.
//!
//! The log already holds every error, one line after another, and that is the
//! record to read once a problem is known. This is the record that says there
//! *is* one: "since 0.3.0 this till has crashed twice and hit the same error
//! forty times on the bills page" is a sentence nobody can get from five
//! megabytes of log, and it is the one a vendor needs before the shop rings.
//!
//! ## How a run ends
//!
//! A run is written down as running when it starts and crossed off when it
//! ends cleanly -- the window closed, or the app stopping for an update. A run
//! still marked as running at the next start did not end cleanly, and is
//! counted one of two ways:
//!
//! - **panicked**: the Rust side panicked. A bug, ours.
//! - **unclean**: it simply stopped -- a power cut, the PC switched off at the
//!   wall, the process killed. In a shop without a UPS this is most runs that
//!   end badly, and it is not a bug; it is counted apart so that it does not
//!   read as one.
//!
//! ## Rules it keeps
//!
//! Like `log.rs`, it never stops the till: every failure is swallowed, and the
//! panic hook reaches it through `try_lock`, so a panic raised while it holds
//! its own lock records nothing rather than deadlocking. The file is written
//! whole to a temporary name and renamed, so a power cut mid-write leaves the
//! last good copy.
//!
//! It holds nothing the log does not already hold -- the health report carries
//! the log files too -- and less: an error is kept as its signature, with every
//! number and quoted value taken out, never as the words it arrived in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

const FILE: &str = "faults.json";
/// Kinds of error kept. Past this the one seen longest ago goes.
const KEEP_ERRORS: usize = 100;
/// An error in a loop is written at most this often; the count is still exact.
const FLUSH_EVERY_SECS: i64 = 5;
const MAX_SIGNATURE: usize = 200;

#[derive(Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Faults {
    /// By app version.
    #[serde(default)]
    pub sessions: BTreeMap<String, Sessions>,
    /// The run under way, crossed off when it ends cleanly.
    #[serde(default)]
    pub running: Option<Running>,
    /// The last run that did not end cleanly.
    #[serde(default)]
    pub last_unclean: Option<Unclean>,
    #[serde(default)]
    pub errors: Vec<Seen>,
}

#[derive(Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sessions {
    pub started: u64,
    pub clean: u64,
    pub panicked: u64,
    pub unclean: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Running {
    pub version: String,
    pub started_at: String,
    pub panicked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Unclean {
    pub version: String,
    pub started_at: String,
    pub panicked: bool,
    /// When the next run found it.
    pub noticed_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Seen {
    pub signature: String,
    pub version: String,
    pub source: String,
    pub count: u64,
    pub first_at: String,
    pub last_at: String,
}

impl Faults {
    /// A run starts. One left marked as running did not end cleanly.
    pub fn begin(&mut self, version: &str, now: &str) {
        if let Some(prev) = self.running.take() {
            let tally = self.sessions.entry(prev.version.clone()).or_default();
            if prev.panicked {
                tally.panicked += 1;
            } else {
                tally.unclean += 1;
            }
            self.last_unclean = Some(Unclean {
                version: prev.version,
                started_at: prev.started_at,
                panicked: prev.panicked,
                noticed_at: now.to_string(),
            });
        }
        self.sessions.entry(version.to_string()).or_default().started += 1;
        self.running = Some(Running { version: version.to_string(), started_at: now.to_string(), panicked: false });
    }

    /// The run ended as it should. Twice is once: the update path and the exit both call it.
    pub fn end_clean(&mut self) {
        if let Some(run) = self.running.take() {
            self.sessions.entry(run.version).or_default().clean += 1;
        }
    }

    pub fn panicked(&mut self) {
        if let Some(run) = self.running.as_mut() {
            run.panicked = true;
        }
    }

    pub fn note(&mut self, version: &str, source: &str, message: &str, now: &str) {
        let signature = signature(source, message);
        if let Some(seen) = self.errors.iter_mut().find(|e| e.signature == signature && e.version == version) {
            seen.count += 1;
            seen.last_at = now.to_string();
            return;
        }
        self.errors.push(Seen {
            signature,
            version: version.to_string(),
            source: source.to_string(),
            count: 1,
            first_at: now.to_string(),
            last_at: now.to_string(),
        });
        if self.errors.len() > KEEP_ERRORS {
            // Stamps are one fixed-width UTC format, so they sort as text.
            if let Some(oldest) = self.errors.iter().enumerate().min_by(|a, b| a.1.last_at.cmp(&b.1.last_at)).map(|(i, _)| i) {
                self.errors.remove(oldest);
            }
        }
    }

    /// One line for the caption, about the version running now.
    pub fn caption(&self, version: &str) -> String {
        let Some(tally) = self.sessions.get(version) else { return String::new() };
        let kinds = self.errors.iter().filter(|e| e.version == version).count();
        let mut parts = vec![format!("{} run(s)", tally.started)];
        if tally.panicked > 0 {
            parts.push(format!("{} crash(es)", tally.panicked));
        }
        if tally.unclean > 0 {
            parts.push(format!("{} ended without closing", tally.unclean));
        }
        parts.push(if kinds == 0 { "no errors".into() } else { format!("{kinds} kind(s) of error") });
        format!("{version}: {}", parts.join(", "))
    }
}

/// What kind of error this is, the same for every occurrence of it.
///
/// The first line with everything that varies taken out -- a number, an id, a
/// quoted value -- and, for the webview, the top frame of the stack, which is
/// where two different errors that say the same thing come apart. A panic's
/// first line already names the file and line it came from.
pub fn signature(source: &str, message: &str) -> String {
    let mut lines = message.lines();
    let head = normalise(lines.next().unwrap_or("").trim());
    let frame = if source == "panic" {
        None
    } else {
        lines.map(str::trim).find(|l| l.starts_with("at ") || l.contains('@'))
    };
    let whole = match frame {
        Some(frame) => format!("{head} | {}", normalise(frame)),
        None => head,
    };
    cut(&whole, MAX_SIGNATURE)
}

fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let mut chars = text.chars().peekable();
    let flush = |word: &mut String, out: &mut String| {
        if word.is_empty() {
            return;
        }
        if word.chars().any(|c| c.is_ascii_digit()) {
            out.push('N');
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    while let Some(c) = chars.next() {
        if c.is_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut out);
        if matches!(c, '\'' | '"' | '`') {
            // A quoted value is a value: skip to its closing quote, if it has one.
            let mut rest = chars.clone();
            if rest.any(|d| d == c) {
                while let Some(d) = chars.next() {
                    if d == c {
                        break;
                    }
                }
                out.push(c);
                out.push('…');
                out.push(c);
                continue;
            }
        }
        if c.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out.trim().to_string()
}

fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/* ------------------------------------------------------------ the file --- */

struct State {
    path: PathBuf,
    version: String,
    faults: Faults,
    flushed_at: i64,
    dirty: bool,
}

fn cell() -> &'static Mutex<Option<State>> {
    static CELL: OnceLock<Mutex<Option<State>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn read(path: &Path) -> Faults {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn flush(state: &mut State) {
    let Ok(bytes) = serde_json::to_vec_pretty(&state.faults) else { return };
    let temp = state.path.with_extension("json.tmp");
    if std::fs::write(&temp, bytes).is_ok() && std::fs::rename(&temp, &state.path).is_ok() {
        state.dirty = false;
        state.flushed_at = crate::log::now_unix();
    }
}

/// Called once the data folder is known, beside `log::open`.
pub fn open(data_dir: &Path, version: &str) {
    let path = data_dir.join(FILE);
    let mut faults = read(&path);
    faults.begin(version, &crate::log::now_stamp());
    let mut state = State { path, version: version.to_string(), faults, flushed_at: 0, dirty: true };
    flush(&mut state);
    if let Ok(mut slot) = cell().lock() {
        *slot = Some(state);
    }
}

/// An error was logged. From `log::write`, which may be inside the panic hook.
pub fn note(source: &str, message: &str) {
    let Ok(mut slot) = cell().try_lock() else { return };
    let Some(state) = slot.as_mut() else { return };
    let version = state.version.clone();
    state.faults.note(&version, source, message, &crate::log::now_stamp());
    state.dirty = true;
    if source == "panic" || crate::log::now_unix() - state.flushed_at >= FLUSH_EVERY_SECS {
        flush(state);
    }
}

/// From the panic hook, before anything else can go wrong.
pub fn panicked() {
    let Ok(mut slot) = cell().try_lock() else { return };
    let Some(state) = slot.as_mut() else { return };
    state.faults.panicked();
    flush(state);
}

pub fn end_clean() {
    let Ok(mut slot) = cell().lock() else { return };
    let Some(state) = slot.as_mut() else { return };
    state.faults.end_clean();
    flush(state);
}

/// The app is about to stop on purpose, for an update. The installer closes
/// it without the window's usual exit, and that is not a crash.
#[tauri::command]
pub fn faults_ending() {
    end_clean();
}

/// What the health report carries, written out first so the file and the
/// report agree.
pub fn snapshot(data_dir: &Path) -> (Json, String) {
    if let Ok(mut slot) = cell().lock() {
        if let Some(state) = slot.as_mut() {
            if state.dirty {
                flush(state);
            }
            let caption = state.faults.caption(&state.version);
            return (serde_json::to_value(&state.faults).unwrap_or(Json::Null), caption);
        }
    }
    (serde_json::to_value(read(&data_dir.join(FILE))).unwrap_or(Json::Null), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T1: &str = "2026-10-16T10:00:00Z";
    const T2: &str = "2026-10-16T11:00:00Z";

    #[test]
    fn a_run_that_ends_cleanly_is_counted_clean() {
        let mut f = Faults::default();
        f.begin("0.3.0", T1);
        f.end_clean();
        f.end_clean();
        assert_eq!(f.sessions["0.3.0"], Sessions { started: 1, clean: 1, panicked: 0, unclean: 0 });
        assert_eq!(f.running, None);
    }

    #[test]
    fn a_power_cut_is_not_a_crash() {
        let mut f = Faults::default();
        f.begin("0.3.0", T1);
        f.begin("0.3.0", T2);
        assert_eq!(f.sessions["0.3.0"], Sessions { started: 2, clean: 0, panicked: 0, unclean: 1 });
        let last = f.last_unclean.unwrap();
        assert!(!last.panicked);
        assert_eq!(last.started_at, T1);
    }

    #[test]
    fn a_panic_is_counted_against_the_version_that_panicked() {
        let mut f = Faults::default();
        f.begin("0.2.21", T1);
        f.panicked();
        f.begin("0.3.0", T2);
        assert_eq!(f.sessions["0.2.21"].panicked, 1);
        assert_eq!(f.sessions["0.3.0"].started, 1);
        assert!(f.last_unclean.unwrap().panicked);
    }

    #[test]
    fn the_same_error_about_different_bills_is_one_kind() {
        let a = "TypeError: Cannot read properties of undefined (reading 'qty')\n    at Billing (http://tauri.localhost/assets/index-B3x9.js:12:345)";
        let b = "TypeError: Cannot read properties of undefined (reading 'qty')\n    at Billing (http://tauri.localhost/assets/index-B3x9.js:12:999)";
        assert_eq!(signature("window", a), signature("window", b));

        let c = "Bill 0192f4a1-77aa-7bcd-8000-000000000001 not found";
        let d = "Bill 0192f4a1-77aa-7bcd-8000-000000000002 not found";
        assert_eq!(signature("promise", c), signature("promise", d));
        assert_eq!(signature("promise", c), "Bill N-N-N-N-N not found");
    }

    #[test]
    fn a_quoted_value_is_left_out() {
        assert_eq!(
            signature("promise", "No customer called 'Ravi Kumar' on this till"),
            "No customer called '…' on this till",
        );
    }

    #[test]
    fn the_same_words_from_two_places_are_two_kinds() {
        let a = "Error: failed\n    at saveBill (index.js:1:2)";
        let b = "Error: failed\n    at loadStock (index.js:1:2)";
        assert_ne!(signature("window", a), signature("window", b));
    }

    #[test]
    fn errors_are_counted_and_kept_to_a_limit() {
        let mut f = Faults::default();
        f.note("0.3.0", "window", "Error: one", T1);
        f.note("0.3.0", "window", "Error: one", T2);
        assert_eq!(f.errors.len(), 1);
        assert_eq!(f.errors[0].count, 2);
        assert_eq!(f.errors[0].first_at, T1);
        assert_eq!(f.errors[0].last_at, T2);

        for i in 0..KEEP_ERRORS + 10 {
            f.note("0.3.0", "window", &format!("Error: kind {}", "x".repeat(i + 1)), T2);
        }
        assert_eq!(f.errors.len(), KEEP_ERRORS);
        assert!(!f.errors.iter().any(|e| e.signature == "Error: one"), "the one seen longest ago went");
    }

    #[test]
    fn a_long_message_is_cut_on_a_character_boundary() {
        let long = "é".repeat(400);
        let mut f = Faults::default();
        f.note("0.3.0", "window", &long, T1);
        assert!(f.errors[0].signature.len() <= MAX_SIGNATURE + '…'.len_utf8());
    }

    #[test]
    fn the_caption_says_crashes_apart_from_power_cuts() {
        let mut f = Faults::default();
        f.begin("0.3.0", T1);
        f.panicked();
        f.begin("0.3.0", T2);
        f.begin("0.3.0", T2);
        f.note("0.3.0", "panic", "boom at src/db.rs:1:1", T2);
        assert_eq!(f.caption("0.3.0"), "0.3.0: 3 run(s), 1 crash(es), 1 ended without closing, 1 kind(s) of error");
    }

    #[test]
    fn the_file_survives_a_round_trip_and_an_old_shape() {
        let mut f = Faults::default();
        f.begin("0.3.0", T1);
        f.note("0.3.0", "window", "Error: one", T1);
        let back: Faults = serde_json::from_slice(&serde_json::to_vec(&f).unwrap()).unwrap();
        assert_eq!(back, f);
        let empty: Faults = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Faults::default());
    }
}
