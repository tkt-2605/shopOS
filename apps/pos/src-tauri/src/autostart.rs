/// "Start this till with Windows": a value under the signed-in user's
/// `HKCU\...\CurrentVersion\Run` key, which Windows reads at sign-in.
///
/// One value per till, named after the app's identifier (`ShopOS
/// com.shopos.pos.till1`), so two tills on one PC are switched separately and
/// moving the exe is put right by switching it on again. The current user's
/// key needs no administrator. `reg.exe` rather than a crate: it is in every
/// Windows, and the registry is touched in exactly these two places.
///
/// The Startup-folder shortcut `tools/windows/setup-ports.ps1 -StartTill`
/// makes counts as on too, and switching off removes it as well, so the screen
/// and what happens at sign-in never disagree. The instance guard keeps a till
/// started twice to one copy (`instance.rs`).
use std::path::PathBuf;
use std::process::Command;

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

fn value_name(app: &tauri::AppHandle) -> String {
    format!("ShopOS {}", app.config().identifier)
}

fn shortcut() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| {
        PathBuf::from(d).join(r"Microsoft\Windows\Start Menu\Programs\Startup").join("ShopOS till.lnk")
    })
}

#[tauri::command]
pub fn autostart_get(app: tauri::AppHandle) -> bool {
    let exe = std::env::current_exe().ok().map(|p| p.display().to_string().to_lowercase()).unwrap_or_default();
    let in_run = reg(&["query", RUN_KEY, "/v", &value_name(&app)])
        .map(|out| out.to_lowercase().contains(&exe))
        .unwrap_or(false);
    in_run || shortcut_points_here(&exe)
}

#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let name = value_name(&app);
    if on {
        let exe = std::env::current_exe().map_err(|e| format!("Could not find this till's program: {e}"))?;
        reg(&["add", RUN_KEY, "/v", &name, "/t", "REG_SZ", "/d", &format!("\"{}\"", exe.display()), "/f"])
            .ok_or("Windows did not let the till be added to sign-in.")?;
    } else {
        let _ = reg(&["delete", RUN_KEY, "/v", &name, "/f"]);
        let exe = std::env::current_exe().ok().map(|p| p.display().to_string().to_lowercase()).unwrap_or_default();
        if shortcut_points_here(&exe) {
            if let Some(link) = shortcut() {
                let _ = std::fs::remove_file(link);
            }
        }
    }
    let now = autostart_get(app.clone());
    crate::log::write("info", "app", &format!("start with Windows: {}", if now { "on" } else { "off" }));
    Ok(now)
}

/// The setup script's shortcut, if it starts this very exe. A .lnk keeps its
/// target as UTF-16 inside; looking for the path in both encodings is enough
/// to tell, without a COM call.
fn shortcut_points_here(exe: &str) -> bool {
    shortcut().and_then(|l| std::fs::read(l).ok()).is_some_and(|bytes| names(&bytes, exe))
}

/// Whether a .lnk's bytes name this exe, as 8-bit text or as UTF-16 starting
/// on either an even or an odd byte -- a .lnk's strings fall on both.
fn names(bytes: &[u8], exe: &str) -> bool {
    if exe.is_empty() {
        return false;
    }
    let wide = |from: usize| -> String {
        bytes.get(from..).unwrap_or_default().chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .filter_map(|u| char::from_u32(u32::from(u)))
            .collect::<String>()
            .to_lowercase()
    };
    String::from_utf8_lossy(bytes).to_lowercase().contains(exe) || wide(0).contains(exe) || wide(1).contains(exe)
}

fn reg(args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::names;

    const EXE: &str = r"c:\shop\till-1\shopos-pos.exe";

    fn stored(pad: usize, path: &str) -> Vec<u8> {
        let mut bytes = vec![0u8; pad];
        bytes.extend(path.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    #[test]
    fn finds_this_exe_in_a_shortcut_however_its_path_is_stored() {
        assert!(names(&stored(4, r"C:\Shop\till-1\shopos-pos.exe"), EXE));
        assert!(names(&stored(5, r"C:\Shop\till-1\shopos-pos.exe"), EXE));
        assert!(names(br"xxC:\Shop\till-1\shopos-pos.exe", EXE));
    }

    #[test]
    fn does_not_mistake_another_till_for_this_one() {
        assert!(!names(&stored(3, r"C:\Shop\till-2\shopos-pos.exe"), EXE));
        assert!(!names(&stored(3, r"C:\Shop\till-1\shopos-pos.exe"), ""));
    }
}
