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
/// else. Nothing else in the product does this, and nothing reaches it but the
/// settings row an admin wrote.
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::paths;

/// The placeholder replaced with the backup's full path. A command without it
/// gets the path appended, because that is what someone who typed
/// `rclone copy` obviously meant.
const FILE_TOKEN: &str = "{file}";

/// Long enough for a slow upload on a shop's broadband, short enough that a
/// command waiting on a prompt nobody will ever answer does not sit there for
/// the rest of the day.
const LIMIT: Duration = Duration::from_secs(15 * 60);

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

fn command_line(template: &str, file: &str) -> String {
    if template.contains(FILE_TOKEN) {
        template.replace(FILE_TOKEN, &quoted(file))
    } else {
        format!("{template} {}", quoted(file))
    }
}

fn quoted(path: &str) -> String {
    if path.contains(' ') && !path.starts_with('"') {
        format!("\"{path}\"")
    } else {
        path.to_string()
    }
}

fn shell(line: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(line);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(line);
        cmd
    }
}

fn run(line: &str) -> Result<HookResult, String> {
    let mut child = shell(line)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run that command: {e}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if started.elapsed() > LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(HookResult {
                    ok: false,
                    code: None,
                    output: "The command was still running after fifteen minutes and was stopped.".into(),
                });
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }

    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let mut text = tail(&out.stdout, 2000);
    let errs = tail(&out.stderr, 2000);
    if !errs.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&errs);
    }

    Ok(HookResult { ok: out.status.success(), code: out.status.code(), output: text })
}

/// Runs the hook against a backup that is already written.
///
/// `async` so the wait happens off the UI thread: an upload takes as long as the
/// shop's connection takes, and the counter must stay usable throughout.
#[tauri::command]
pub async fn run_backup_hook(
    app: tauri::AppHandle,
    command: String,
    name: String,
) -> Result<HookResult, String> {
    let template = command.trim().to_string();
    if template.is_empty() {
        return Err("There is no command to run.".into());
    }

    // The file is named the same way every other backup command names one, so a
    // hook cannot be pointed at the live database or anywhere outside the
    // backups folder.
    let dir = paths::backups_dir(&app)?;
    let file: PathBuf = paths::in_backups(&dir, &name)?;
    if !file.exists() {
        return Err(format!("{name} is no longer there"));
    }

    let line = command_line(&template, &file.to_string_lossy());
    tauri::async_runtime::spawn_blocking(move || run(&line))
        .await
        .map_err(|e| format!("The command did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_goes_where_the_command_asks_for_it() {
        assert_eq!(
            command_line("rclone copy {file} gdrive:shop", r"C:\data\shop-2026-09-13.zip"),
            r"rclone copy C:\data\shop-2026-09-13.zip gdrive:shop"
        );
    }

    #[test]
    fn a_command_without_the_placeholder_gets_the_file_appended() {
        assert_eq!(
            command_line("rclone copy", "/tmp/shop-2026-09-13.zip"),
            "rclone copy /tmp/shop-2026-09-13.zip"
        );
    }

    /* Every Windows shop has a space in its path somewhere. */
    #[test]
    fn a_path_with_a_space_is_quoted() {
        assert_eq!(
            command_line("copy {file} D:\\", r"C:\Program Files\ShopOS\shop.zip"),
            "copy \"C:\\Program Files\\ShopOS\\shop.zip\" D:\\"
        );
    }

    #[test]
    fn a_command_that_works_reports_what_it_said() {
        let line = if cfg!(windows) { "echo uploaded" } else { "echo uploaded" };
        let result = run(line).unwrap();
        assert!(result.ok);
        assert!(result.output.contains("uploaded"));
    }

    #[test]
    fn a_command_that_fails_says_so_rather_than_passing_quietly() {
        let line = if cfg!(windows) { "exit /b 3" } else { "exit 3" };
        let result = run(line).unwrap();
        assert!(!result.ok);
        assert_eq!(result.code, Some(3));
    }
}
