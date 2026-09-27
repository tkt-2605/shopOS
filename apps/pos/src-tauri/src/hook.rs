/// The command a shop runs after each backup.
///
/// This is how ShopOS gets a file off the machine without ever opening a network
/// connection itself. A shop that wants a real cloud copy points this at
/// `rclone`; one that wants a second disk points it at `robocopy`. We ship no
/// credentials, no OAuth and no upload code, and the shopkeeper keeps whatever
/// account they already have.
///
/// What runs is what the owner typed into Settings. That is the feature — it is
/// their machine and their command — so the honest thing is to say so on the
/// screen rather than to pretend a text box full of a command line is anything
/// else. Nothing else in the product does this.
///
/// ## Where the command comes from
///
/// From `device.json`, read here, and never from the request to run it. The
/// command used to arrive as an argument alongside the file name, which made
/// `run_backup_hook` a general "run this shell line" for anything that could
/// reach `invoke` -- one script injected into the webview away from running
/// whatever it liked. Now a request can only say *which backup*; the line that
/// runs is the one saved on this machine through Settings.
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{device, paths};

/// The placeholder replaced with the backup's full path. A command without it
/// gets the path appended, because that is what someone who typed
/// `rclone copy` obviously meant.
const FILE_TOKEN: &str = "{file}";

/// The device setting the command is saved under. Must match `HOOK_SETTING` in
/// `apps/pos/src/core/backup.ts`.
pub const SETTING: &str = "backup_hook";

/// Long enough for a slow upload on a shop's broadband, short enough that a
/// command waiting on a prompt nobody will ever answer does not sit there for
/// the rest of the day.
const LIMIT: Duration = Duration::from_secs(15 * 60);

/// How much of what the command says is kept while it runs, from the end. The
/// screen shows the last two thousand characters; this is room for those
/// however many bytes each one takes.
const KEEP: usize = 16 * 1024;

/// How long to wait for the last of the output once the command has ended.
/// Normally no time at all; see `Drain::finish` for when it is not.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Serialize)]
pub struct HookResult {
    pub ok: bool,
    /// None when it had to be killed for running too long.
    pub code: Option<i32>,
    pub output: String,
}

fn tail(bytes: &[u8], limit: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let start = trimmed.char_indices().nth(trimmed.chars().count() - limit).map_or(0, |(i, _)| i);
    format!("…{}", &trimmed[start..])
}

/// The line the shell runs, with the backup's path in it.
///
/// The path is always quoted, not only when it has a space in it. A Windows
/// user folder can be `Ravi & Sons`, and to `cmd` an unquoted `&` ends one
/// command and starts another. A template that already put quotes round the
/// placeholder gets them once, not twice.
fn command_line(template: &str, file: &str) -> String {
    let path = quoted(file);
    let wrapped = format!("\"{FILE_TOKEN}\"");
    if template.contains(&wrapped) {
        template.replace(&wrapped, &path)
    } else if template.contains(FILE_TOKEN) {
        template.replace(FILE_TOKEN, &path)
    } else {
        format!("{template} {path}")
    }
}

/// A Windows path cannot contain `"`, so double quotes are the whole of the
/// job. Inside them `cmd` takes `&`, `^`, `|`, `<`, `>` and spaces literally.
/// `%` it still expands, and there is no way to stop it doing so on a `/C`
/// line; a backups folder with `%` in its path is left to the owner's command.
#[cfg(windows)]
fn quoted(path: &str) -> String {
    format!("\"{path}\"")
}

#[cfg(not(windows))]
fn quoted(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// The shell, given the line exactly as it stands.
///
/// On Windows through `raw_arg`, because Rust's own quoting is for programs
/// that parse their command line the C runtime's way, and `cmd` does not: it
/// turned every `"` in the owner's command into `\"`, which `cmd` passes
/// through as a backslash and a quote, so `copy "{file}" "D:\Backups"` reached
/// `copy` mangled. `/S /C "…"` has `cmd` strip exactly the outer pair of quotes
/// and run what is between them as typed. `/D` skips any AutoRun command in the
/// registry, which is somebody else's configuration and not part of this one.
#[cfg(windows)]
fn shell(line: &str) -> Command {
    use std::os::windows::process::CommandExt;
    /// No console window flashing up over the till every night.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = Command::new("cmd");
    cmd.raw_arg(format!("/D /S /C \"{line}\"")).creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn shell(line: &str) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("sh");
    // Its own process group, so that stopping it stops what it started.
    cmd.arg("-c").arg(line).process_group(0);
    cmd
}

/// Everything the command starts, so that stopping it stops all of it.
///
/// `child.kill()` ends `cmd.exe` and nothing else. The `rclone` it started
/// carries on, uploading, holding the pipes open -- and the output readers,
/// waiting for those pipes to close, carry on with it. A Job object is the
/// Windows way to own a process tree: everything the command starts is in it,
/// and closing it ends the lot.
///
/// There is a moment between spawning `cmd` and putting it in the job in which
/// it could start something that escapes. `cmd` has not read its own command
/// line by then; it is a race in principle and not one seen in practice.
#[cfg(windows)]
mod tree {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Child, Command};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Tree {
        job: Option<HANDLE>,
    }

    impl Tree {
        /// Puts the child in a job that dies with its last handle -- this one,
        /// or this process's, if ShopOS itself is closed mid-upload. If the job
        /// cannot be made, the tree is killed with `taskkill` instead.
        pub fn adopt(child: &Child) -> Tree {
            // SAFETY: plain Win32 calls on handles this function owns, and on
            // the child's process handle, which `child` keeps open throughout.
            unsafe {
                let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
                    return Tree { job: None };
                };
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let adopted = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .and_then(|()| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())));
                if adopted.is_err() {
                    let _ = CloseHandle(job);
                    return Tree { job: None };
                }
                Tree { job: Some(job) }
            }
        }

        /// Ends everything still running. After an ordinary exit that is only
        /// whatever the command left behind; after an overrun it is the lot.
        pub fn kill(&mut self, child: &mut Child, overran: bool) {
            match self.job.take() {
                // SAFETY: the job handle is this struct's and is closed once.
                Some(job) => unsafe {
                    let _ = TerminateJobObject(job, 1);
                    let _ = CloseHandle(job);
                },
                // No job: `taskkill /T` walks the tree by parent id. Only for an
                // overrun, and only while `child` still holds the process open,
                // which is what stops its id being reused under us.
                None if overran => {
                    let _ = Command::new("taskkill")
                        .args(["/T", "/F", "/PID", &child.id().to_string()])
                        .output();
                    let _ = child.kill();
                }
                None => {}
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            if let Some(job) = self.job.take() {
                // SAFETY: as above. Closing the last handle ends the job.
                unsafe {
                    let _ = CloseHandle(job);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod tree {
    use std::process::Child;

    /// The child leads its own process group (see `shell`), so the group is
    /// the tree.
    pub struct Tree;

    impl Tree {
        pub fn adopt(_child: &Child) -> Tree {
            Tree
        }

        /// Signals the group directly rather than running `kill -KILL -<pid>`.
        /// Some builds of `kill` read the negative number as an option, and
        /// what they did instead took down every process the user owned -- on
        /// a CI runner, the runner itself.
        pub fn kill(&mut self, child: &mut Child, overran: bool) {
            if overran {
                if let Some(group) = group_of(child.id()) {
                    // SAFETY: a plain syscall; `group` is a real group id > 1.
                    unsafe { libc::kill(-group, libc::SIGKILL) };
                }
                let _ = child.kill();
            }
        }
    }

    /// The group to signal, never 0 or 1: `kill(0)` is this process's own
    /// group and `kill(-1)` is every process there is.
    pub fn group_of(pid: u32) -> Option<libc::pid_t> {
        libc::pid_t::try_from(pid).ok().filter(|&p| p > 1)
    }

    #[cfg(test)]
    mod tests {
        use super::group_of;

        #[test]
        fn never_signals_everything_or_itself() {
            assert_eq!(group_of(0), None);
            assert_eq!(group_of(1), None);
            assert_eq!(group_of(u32::MAX), None);
            assert_eq!(group_of(4242), Some(4242));
        }
    }
}

/// One of the command's two pipes, read for as long as it is open.
///
/// The pipes used to be read only after the command ended, and a pipe holds
/// about four kilobytes. A command that said more than that -- `robocopy`
/// listing the files it copied, `rclone -v` -- blocked writing to a pipe
/// nobody was reading, never ended, and was killed at fifteen minutes as
/// "still running". Every verbose hook failed, every night, and said the
/// opposite of why.
///
/// So each pipe gets a thread that reads it as it fills and keeps only the
/// tail, which is all the screen shows.
struct Drain {
    kept: Arc<Mutex<Vec<u8>>>,
    thread: Option<JoinHandle<()>>,
}

impl Drain {
    fn start(pipe: Option<impl Read + Send + 'static>) -> Drain {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let Some(mut pipe) = pipe else {
            return Drain { kept, thread: None };
        };
        let sink = Arc::clone(&kept);
        let thread = std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut kept = sink.lock().unwrap_or_else(|e| e.into_inner());
                        kept.extend_from_slice(&chunk[..n]);
                        if kept.len() > KEEP {
                            let excess = kept.len() - KEEP;
                            kept.drain(..excess);
                        }
                    }
                }
            }
        });
        Drain { kept, thread: Some(thread) }
    }

    /// What was said. Waits a moment for the pipe to close, and no longer: a
    /// process that escaped the tree can hold it open for ever, and the result
    /// is worth more than the last line of its output.
    fn finish(mut self) -> Vec<u8> {
        if let Some(thread) = self.thread.take() {
            let started = Instant::now();
            while !thread.is_finished() && started.elapsed() < DRAIN_GRACE {
                std::thread::sleep(Duration::from_millis(20));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
        let kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
        kept.clone()
    }
}

fn run(line: &str, limit: Duration) -> Result<HookResult, String> {
    let mut child: Child = shell(line)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run that command: {e}"))?;
    let mut tree = tree::Tree::adopt(&child);

    let stdout = Drain::start(child.stdout.take());
    let stderr = Drain::start(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > limit => break None,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                tree.kill(&mut child, true);
                return Err(e.to_string());
            }
        }
    };

    // Whatever is still running goes now, so nothing is left holding the pipes
    // the readers are waiting on.
    tree.kill(&mut child, status.is_none());
    let _ = child.wait();

    let mut text = tail(&stdout.finish(), 2000);
    let errs = tail(&stderr.finish(), 2000);
    if !errs.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&errs);
    }

    let Some(status) = status else {
        let said = "The command was still running after fifteen minutes and was stopped, with everything it had started.";
        return Ok(HookResult {
            ok: false,
            code: None,
            output: if text.is_empty() { said.into() } else { format!("{said}\n{text}") },
        });
    };
    Ok(HookResult { ok: status.success(), code: status.code(), output: text })
}

/// The command saved for this machine, or the reason there is none to run.
fn configured(dir: &Path) -> Result<String, String> {
    device::setting(dir, SETTING)?.ok_or_else(|| "There is no command to run.".to_string())
}

/// Runs the saved hook against a backup that is already written.
///
/// `async` so the wait happens off the UI thread: an upload takes as long as the
/// shop's connection takes, and the counter must stay usable throughout.
#[tauri::command]
pub async fn run_backup_hook(app: tauri::AppHandle, name: String) -> Result<HookResult, String> {
    let template = configured(&paths::data_dir(&app)?)?;

    // The file is named the same way every other backup command names one, so a
    // hook cannot be pointed at the live database or anywhere outside the
    // backups folder.
    let dir = paths::backups_dir(&app)?;
    let file = paths::in_backups(&dir, &name)?;
    if !file.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let line = command_line(&template, &file.to_string_lossy());
    tauri::async_runtime::spawn_blocking(move || run(&line, LIMIT))
        .await
        .map_err(|e| format!("The command did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("shopos-hook-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn the_file_goes_where_the_command_asks_for_it_and_is_always_quoted() {
        assert_eq!(
            command_line("rclone copy {file} gdrive:shop", r"C:\data\shop-2026-09-13.zip"),
            r#"rclone copy "C:\data\shop-2026-09-13.zip" gdrive:shop"#
        );
        assert_eq!(
            command_line("rclone copy", r"C:\data\shop-2026-09-13.zip"),
            r#"rclone copy "C:\data\shop-2026-09-13.zip""#
        );
        // Quoted by the owner already: once, not twice.
        assert_eq!(
            command_line(r#"copy "{file}" "D:\Backups""#, r"C:\Users\Ravi & Sons\shop.zip"),
            r#"copy "C:\Users\Ravi & Sons\shop.zip" "D:\Backups""#
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn the_file_goes_where_the_command_asks_for_it_and_is_always_quoted() {
        assert_eq!(
            command_line("rclone copy {file} gdrive:shop", "/data/shop-2026-09-13.zip"),
            "rclone copy '/data/shop-2026-09-13.zip' gdrive:shop"
        );
        assert_eq!(command_line("rclone copy", "/tmp/it's.zip"), r"rclone copy '/tmp/it'\''s.zip'");
    }

    #[test]
    fn a_command_that_works_reports_what_it_said() {
        let result = run("echo uploaded", LIMIT).unwrap();
        assert!(result.ok);
        assert!(result.output.contains("uploaded"));
    }

    #[test]
    fn a_command_that_fails_says_so_rather_than_passing_quietly() {
        let line = if cfg!(windows) { "exit /b 3" } else { "exit 3" };
        let result = run(line, LIMIT).unwrap();
        assert!(!result.ok);
        assert_eq!(result.code, Some(3));
    }

    /* Every Windows shop has a space in its path somewhere, and a user folder
       can have an ampersand in it -- which, unquoted, `cmd` reads as the end
       of one command and the start of another. */
    #[test]
    fn a_path_with_spaces_and_shell_characters_reaches_the_command_whole() {
        let dir = scratch("Ravi & Sons ^ (2)");
        let file = dir.join("shop-2026-09-13.zip");
        std::fs::write(&file, "the whole archive").unwrap();

        let reader = if cfg!(windows) { "type" } else { "cat" };
        for template in [format!("{reader} {{file}}"), format!("{reader} \"{{file}}\""), reader.to_string()] {
            let result = run(&command_line(&template, &file.to_string_lossy()), LIMIT).unwrap();
            assert!(result.ok, "{template}: {}", result.output);
            assert!(result.output.contains("the whole archive"), "{template}: {}", result.output);
        }
    }

    /* The bug: a pipe holds about four kilobytes, and nothing read it until
       the command ended -- so a command that said more than that never ended,
       and was killed at fifteen minutes for "still running". */
    #[test]
    fn a_command_that_says_a_lot_is_not_stalled_by_its_own_output() {
        let dir = scratch("chatty");
        let file = dir.join("listing.txt");
        let mut listing = "copied shop-2026-09-13.zip to D:\\Backups\n".repeat(64 * 1024 / 40);
        listing.push_str("done: 1 file copied");
        std::fs::write(&file, &listing).unwrap();
        assert!(listing.len() >= 64 * 1024);

        let reader = if cfg!(windows) { "type" } else { "cat" };
        let started = Instant::now();
        let result = run(&command_line(reader, &file.to_string_lossy()), Duration::from_secs(60)).unwrap();

        assert!(result.ok, "{}", result.output);
        assert!(started.elapsed() < Duration::from_secs(30), "took {:?}", started.elapsed());
        // The tail is what the screen shows, and the tail is where the verdict is.
        assert!(result.output.ends_with("done: 1 file copied"), "{}", &result.output[result.output.len() - 80..]);
    }

    /* Stopping `cmd` alone left what it started running, holding the pipes the
       readers were waiting on, so the stop itself hung. */
    #[test]
    fn a_command_that_overruns_is_stopped_with_everything_it_started() {
        let line = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30; echo late" };
        let started = Instant::now();
        let result = run(line, Duration::from_millis(500)).unwrap();

        assert!(!result.ok);
        assert_eq!(result.code, None);
        assert!(result.output.contains("was stopped"), "{}", result.output);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    /// The command is the saved one, and a machine with none saved has nothing
    /// to run -- whatever the request says.
    #[test]
    fn the_command_is_read_from_this_machine_and_not_from_the_request() {
        let dir = scratch("configured");
        assert_eq!(configured(&dir).unwrap_err(), "There is no command to run.");

        std::fs::write(
            dir.join("device.json"),
            r#"{"device_id":"550e8400-e29b-41d4-a716-446655440000","label":"COUNTER1",
                "settings":{"backup_hook":"  rclone copy {file} gdrive:shop  "}}"#,
        )
        .unwrap();
        assert_eq!(configured(&dir).unwrap(), "rclone copy {file} gdrive:shop");
    }
}
