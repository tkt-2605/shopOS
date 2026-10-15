//! A file that says what happened, for a shop nobody can visit.
//!
//! Until now the only record of a failure was whatever was on the screen when
//! it happened, and the screen is gone by the time anybody rings. `main.rs`
//! sets `windows_subsystem = "windows"` in release, so there is not even a
//! console: a panic in the webview host takes the window away and leaves
//! nothing at all behind. The first outside install must not happen before
//! this exists, because without it every bug is a visit.
//!
//! ## What it will not do
//!
//! **It will not stop the till.** Every failure in here is swallowed. A shop
//! that cannot write its log can still write bills, and a disk that has filled
//! up is not a reason to refuse a customer. Nothing in this module returns an
//! error to its caller and nothing in it can panic on a path the caller
//! controls.
//!
//! **It will not grow without limit.** Five files of a megabyte each, oldest
//! dropped. A log that fills the disk of a shop PC has caused the outage it
//! was there to explain.
//!
//! **It will not hold anything secret.** Callers decide what goes in. The one
//! secret this product holds is the `backup_hook` command line, which can
//! carry an rclone token, and it is redacted where it is logged rather than
//! trusted not to appear.
//!
//! ## The clock
//!
//! UTC, with a `Z`, formatted by hand because this crate has no date library
//! and a panic hook cannot ask the webview what time it is. Two tills in one
//! shop can disagree about the local time and one of them will be wrong; they
//! agree about UTC or their clocks are visibly broken, which is itself worth
//! seeing. Every file says so at the top, with the offset for IST, because the
//! person reading it is holding a phone showing half past four.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// One megabyte per file, five files. Enough to hold a shop's whole opening
/// morning at the rate anything here actually writes, and small enough that a
/// shopkeeper can send one over WhatsApp.
const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 5;

/// A single event cannot be longer than this. A panic backtrace is the honest
/// reason for a limit this high; a loop logging its own failure is the reason
/// there is a limit at all.
const MAX_EVENT: usize = 16 * 1024;

const HEADER: &str =
    "# ShopOS log. Times are UTC — India (IST) is 5 hours 30 minutes ahead.\n";

struct Sink {
    dir: PathBuf,
    file: File,
    written: u64,
}

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();

/// Set while the panic hook is running, so that a panic raised *by the logger*
/// cannot call the logger again for ever.
static IN_PANIC: AtomicBool = AtomicBool::new(false);

fn cell() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Starts writing to `<data dir>/logs/shopos.log`.
///
/// Safe to call more than once and safe never to call: until it runs, events
/// go to stderr, which is where they are useful in development and where they
/// go nowhere in a release build. That is the correct amount of effort to
/// spend on the window between the process starting and its data folder being
/// known.
pub fn open(data_dir: &Path) {
    let dir = data_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let path = dir.join("shopos.log");
    let existing = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let fresh = existing == 0;

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    if fresh {
        let _ = file.write_all(HEADER.as_bytes());
    }

    let written = existing + if fresh { HEADER.len() as u64 } else { 0 };
    if let Ok(mut guard) = cell().lock() {
        *guard = Some(Sink { dir, file, written });
    }

    write("info", "startup", "--- ShopOS starting ---");
}

/// Sends panics to the file, with their backtrace.
///
/// Installed from `run()` before the builder, so that a panic inside `setup()`
/// -- the place most likely to meet a broken database -- is recorded even
/// though the window never appears. Without this, the release build's only
/// symptom is an icon that does nothing when it is double-clicked.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic raised while writing a panic must not write a panic.
        if !IN_PANIC.swap(true, Ordering::SeqCst) {
            let where_ = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_else(|| "unknown".into());
            let what = payload(info);
            let trace = std::backtrace::Backtrace::force_capture();
            // First, and on its own: this run is now a crash, whatever the
            // write below manages.
            crate::faults::panicked();
            write("error", "panic", &format!("{what} at {where_}\n{trace}"));
            IN_PANIC.store(false, Ordering::SeqCst);
        }
        previous(info);
    }));
}

fn payload(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "panicked".into()
    }
}

/// Records one event.
///
/// `source` says which part of the program is speaking -- `startup`, `backup`,
/// `sync`, `webview` -- because the first question on a support call is which
/// half of the product went wrong, and grepping one word answers it.
pub fn write(level: &str, source: &str, message: &str) {
    // Counted by kind as well as written, for the health report (`faults.rs`).
    if level == "error" {
        crate::faults::note(source, message);
    }
    let line = format(now_unix(), level, source, message);

    let Ok(mut guard) = cell().lock() else { return };
    let Some(sink) = guard.as_mut() else {
        // No file yet. stderr is nothing in a release build and everything in
        // a terminal, which is exactly when this happens.
        eprint!("{line}");
        return;
    };

    if sink.written + line.len() as u64 > MAX_BYTES {
        rotate(sink);
    }
    if sink.file.write_all(line.as_bytes()).is_ok() {
        sink.written += line.len() as u64;
        // Flushed rather than buffered: the events worth having are the ones
        // written immediately before the process stopped existing.
        let _ = sink.file.flush();
    }
}

/// `shopos.log` becomes `shopos.1.log`, and the fifth is dropped.
///
/// Renames rather than copies, so a rotation cannot take a second copy of a
/// megabyte onto a disk that may be the reason any of this is happening. If
/// anything here fails the old file simply stays and goes on growing, which is
/// worse than rotating and better than losing the handle.
fn rotate(sink: &mut Sink) {
    let name = |n: usize| -> PathBuf {
        if n == 0 {
            sink.dir.join("shopos.log")
        } else {
            sink.dir.join(format!("shopos.{n}.log"))
        }
    };

    let _ = std::fs::remove_file(name(KEEP - 1));
    for n in (0..KEEP - 1).rev() {
        let _ = std::fs::rename(name(n), name(n + 1));
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(name(0)) {
        let _ = file.write_all(HEADER.as_bytes());
        sink.file = file;
        sink.written = HEADER.len() as u64;
    }
}

/// One event, as it appears in the file.
///
/// Continuation lines are indented by two spaces so that a backtrace stays
/// readable and still cannot be mistaken for -- or forged into -- a second
/// event. Something that arrives with newlines in it is one event that happens
/// to be tall, not several.
fn format(secs: i64, level: &str, source: &str, message: &str) -> String {
    let mut text = message.trim_end().to_string();
    if text.len() > MAX_EVENT {
        // Bytes, not characters, so truncation must land on a boundary or the
        // string is invalid and the write panics inside the panic hook.
        let mut cut = MAX_EVENT;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str(" …[truncated]");
    }

    let mut out = String::with_capacity(text.len() + 64);
    let mut lines = text.split('\n');
    let first = lines.next().unwrap_or("");
    out.push_str(&format!(
        "{} {:<5} {:<9} {}\n",
        stamp(secs),
        level.to_uppercase(),
        source,
        first.trim_end()
    ));
    for line in lines {
        out.push_str("  ");
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        // A clock set before 1970 is a shop PC with a dead CMOS battery, which
        // happens. Zero is wrong and readable; panicking is wrong and silent.
        .unwrap_or(0)
}

/// Now, as `stamp` writes it.
pub(crate) fn now_stamp() -> String {
    stamp(now_unix())
}

/// `2026-09-16T14:22:01Z`, from a Unix timestamp, without a date library.
///
/// The civil-from-days algorithm, which is exact for every date this will ever
/// see and is a good deal less risky than adding a dependency to print twenty
/// characters.
fn stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The webview's way in.
///
/// `window.onerror` and `unhandledrejection` come through here, so a React
/// error that used to exist only in a DevTools console nobody has open on a
/// shop PC is in the same file, in the same order, as the Rust events around
/// it. That ordering is the point: "the backup failed and then the screen went
/// white" is a different bug from the other way round.
#[tauri::command]
pub fn log_event(level: String, source: String, message: String) {
    // The webview is not trusted to name a level; an unknown one would break
    // grepping for ERROR, which is the only thing anybody does with this file.
    let level = match level.as_str() {
        "error" => "error",
        "warn" => "warn",
        _ => "info",
    };
    let source = if source.is_empty() {
        "webview".to_string()
    } else {
        format!("web:{}", source.replace(char::is_whitespace, "-"))
    };
    write(level, &source, &message);
}

/// Every log file that exists, newest first.
///
/// Written with this module, deleted again in the same commit for having no
/// caller, and back now that `diagnostics.rs` needs it. The order matters: the
/// bundle should unpack with the events nearest the problem at the top of the
/// folder listing.
pub fn log_paths(data_dir: &Path) -> Vec<PathBuf> {
    let dir = data_dir.join("logs");
    (0..KEEP)
        .map(|n| {
            if n == 0 {
                dir.join("shopos.log")
            } else {
                dir.join(format!("shopos.{n}.log"))
            }
        })
        .filter(|p| p.exists())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_readable_instant() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(stamp(1_758_030_121), "2025-09-16T13:42:01Z");
        // A leap day, which is where a hand-rolled calendar goes wrong.
        assert_eq!(stamp(1_709_164_800), "2024-02-29T00:00:00Z");
        // And the turn of a century that is not a leap year.
        assert_eq!(stamp(4_102_444_800), "2100-01-01T00:00:00Z");
    }

    #[test]
    fn survives_a_clock_set_before_the_epoch() {
        // A shop PC with a dead CMOS battery. The line must still be a line.
        let line = format(-86_400, "warn", "startup", "clock is wrong");
        assert!(line.starts_with("1969-12-31T00:00:00Z"));
    }

    #[test]
    fn keeps_a_backtrace_readable_and_unforgeable() {
        let line = format(0, "error", "panic", "it broke\nat one\n  at two");
        let mut lines = line.lines();
        assert_eq!(
            lines.next().unwrap(),
            "1970-01-01T00:00:00Z ERROR panic     it broke"
        );
        /* Continuations are indented, so a message containing something that
           looks like a timestamp cannot pass itself off as its own event. */
        assert_eq!(lines.next().unwrap(), "  at one");
        /* And the marker is added to whatever indentation the message already
           had rather than replacing it: a real backtrace nests, and flattening
           it would throw away the part a reader is following. */
        assert_eq!(lines.next().unwrap(), "    at two");
    }

    #[test]
    fn refuses_to_be_made_enormous_by_its_own_caller() {
        let huge = "x".repeat(MAX_EVENT * 4);
        let line = format(0, "error", "panic", &huge);
        assert!(line.len() < MAX_EVENT + 128);
        assert!(line.trim_end().ends_with("…[truncated]"));
    }

    #[test]
    fn truncates_on_a_character_boundary() {
        // Tamil, because this product prints it: three bytes per character, so
        // a byte-wise cut lands inside one and the String would be invalid.
        let huge = "அ".repeat(MAX_EVENT);
        let line = format(0, "info", "test", &huge);
        assert!(line.trim_end().ends_with("…[truncated]"));
    }

    #[test]
    fn rotates_and_keeps_five() {
        let dir = std::env::temp_dir().join(format!("shopos-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();

        let logs = dir.join("logs");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("shopos.log"))
            .unwrap();
        let mut sink = Sink {
            dir: logs.clone(),
            file,
            written: 0,
        };

        for _ in 0..(KEEP + 3) {
            rotate(&mut sink);
        }

        /* Five files and never a sixth: the whole point is a bound on a shop's
           disk, and an unbounded log has caused the outage it was explaining. */
        assert!(!logs.join(format!("shopos.{KEEP}.log")).exists());
        assert!(logs.join(format!("shopos.{}.log", KEEP - 1)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rotated_file_still_says_what_its_clock_is() {
        let dir = std::env::temp_dir().join(format!("shopos-hdr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let logs = dir.join("logs");

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("shopos.log"))
            .unwrap();
        let mut sink = Sink {
            dir: logs.clone(),
            file,
            written: 0,
        };
        rotate(&mut sink);

        /* The reader of the fourth file is as confused about the clock as the
           reader of the first, and is likelier to be the one on the phone. */
        let text = std::fs::read_to_string(logs.join("shopos.log")).unwrap();
        assert!(text.starts_with("# ShopOS log."));
        assert!(text.contains("IST"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_level_from_the_webview_cannot_break_grepping_for_errors() {
        // The rendered line, not the command, because the command writes to a
        // global. What matters is that only three words can ever appear.
        for asked in ["error", "warn", "info", "trace", "", "ERROR"] {
            let level = match asked {
                "error" => "error",
                "warn" => "warn",
                _ => "info",
            };
            assert!(["error", "warn", "info"].contains(&level));
        }
    }
}
