/// The Cloudflare tunnel, kept running by the till that answers the storefront.
///
/// Customers reach the main till through `cloudflared`, which carries
/// `api-shop...` to the loopback port `web_server.rs` opens. It used to be
/// started by hand, so a PC that restarted overnight came back with the till
/// open and the shop "unreachable" until somebody remembered. Now the till
/// starts it when it starts answering the storefront, starts it again if it
/// stops (backing off to a minute between tries), and stops it when the till
/// stops answering or closes. Till open is shop online.
///
/// Which `cloudflared` and which config: `%LOCALAPPDATA%\cloudflared\cloudflared.exe`
/// (else whatever `cloudflared` is on PATH) with `%USERPROFILE%\.cloudflared\config-shopos.yml`,
/// unless the webview passes others (device settings `web_tunnel_exe`,
/// `web_tunnel_config`). Never the bare `config.yml`: on this kind of PC it can
/// belong to another program's tunnel.
///
/// Its own output goes to `logs/cloudflared.log` in the shop's data folder, at
/// warning level, so a tunnel that will not connect can be read about.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::paths;

#[derive(Default)]
pub struct TunnelHost {
    running: Mutex<Option<Supervisor>>,
}

struct Supervisor {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    state: Arc<Mutex<TunnelState>>,
}

#[derive(Serialize, Clone, Default)]
pub struct TunnelState {
    /// Whether `cloudflared` is running right now.
    pub up: bool,
    /// How many times it has had to be started again since the till started it.
    pub restarts: u32,
    /// Why it last stopped or could not start, in words.
    pub problem: Option<String>,
    pub config: String,
}

/// Starts the tunnel and keeps it up. Already running: says so and changes nothing.
#[tauri::command]
pub fn web_tunnel_start(app: tauri::AppHandle, exe: Option<String>, config: Option<String>) -> Result<TunnelState, String> {
    let host = app.state::<TunnelHost>();
    let mut running = host.running.lock().map_err(|_| "tunnel host is wedged")?;
    if let Some(current) = running.as_ref() {
        return Ok(current.state.lock().map(|s| s.clone()).unwrap_or_default());
    }

    let config = config.filter(|c| !c.trim().is_empty()).map(PathBuf::from).unwrap_or_else(default_config);
    if !config.is_file() {
        return Err(format!(
            "No tunnel is set up on this computer ({} is missing). Customers cannot reach the shop until it is.",
            config.display()
        ));
    }
    let exe = exe.filter(|e| !e.trim().is_empty()).map(PathBuf::from).unwrap_or_else(default_exe);
    let log = paths::data_dir(&app)?.join("logs").join("cloudflared.log");
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let state = Arc::new(Mutex::new(TunnelState { config: config.display().to_string(), ..Default::default() }));
    let restarts = Arc::new(AtomicU32::new(0));

    {
        let (stop, child, state) = (Arc::clone(&stop), Arc::clone(&child), Arc::clone(&state));
        std::thread::spawn(move || supervise(&exe, &config, &log, &stop, &child, &state, &restarts));
    }
    // A moment for the first start to succeed or fail, so the answer means something.
    std::thread::sleep(Duration::from_millis(400));
    let now = state.lock().map(|s| s.clone()).unwrap_or_default();
    *running = Some(Supervisor { stop, child, state });
    Ok(now)
}

#[tauri::command]
pub fn web_tunnel_stop(app: tauri::AppHandle) {
    stop_tunnel(&app);
}

#[tauri::command]
pub fn web_tunnel_status(app: tauri::AppHandle) -> Option<TunnelState> {
    let host = app.state::<TunnelHost>();
    let running = host.running.lock().ok()?;
    running.as_ref().and_then(|s| s.state.lock().ok().map(|s| s.clone()))
}

/// Also called when the app exits, so the tunnel never outlives the till that answers it.
pub fn stop_tunnel(app: &tauri::AppHandle) {
    let Some(host) = app.try_state::<TunnelHost>() else { return };
    let Ok(mut running) = host.running.lock() else { return };
    if let Some(sup) = running.take() {
        sup.stop.store(true, Ordering::SeqCst);
        if let Ok(mut held) = sup.child.lock() {
            if let Some(mut c) = held.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

fn supervise(
    exe: &Path,
    config: &Path,
    log: &Path,
    stop: &AtomicBool,
    child: &Mutex<Option<Child>>,
    state: &Mutex<TunnelState>,
    restarts: &AtomicU32,
) {
    let mut wait = Duration::from_secs(2);
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        match spawn(exe, config, log) {
            Ok(c) => {
                if let Ok(mut held) = child.lock() {
                    *held = Some(c);
                }
                set(state, |s| { s.up = true; s.problem = None; });
                let why = watch(stop, child);
                set(state, |s| s.up = false);
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let n = restarts.fetch_add(1, Ordering::SeqCst) + 1;
                set(state, |s| { s.restarts = n; s.problem = Some(why.clone()); });
                crate::log::write("warn", "web", &format!("the tunnel stopped ({why}); starting it again"));
            }
            Err(e) => {
                let why = format!("could not start {}: {e}", exe.display());
                set(state, |s| { s.up = false; s.problem = Some(why.clone()); });
                crate::log::write("error", "web", &why);
            }
        }
        // A tunnel that ran a good while starts again quickly; one that keeps
        // falling over waits longer each time, up to a minute.
        wait = if started.elapsed() > Duration::from_secs(120) { Duration::from_secs(2) } else { (wait * 2).min(Duration::from_secs(60)) };
        let until = Instant::now() + wait;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

/// Until the child exits or the till asks it to stop. Says how it ended.
fn watch(stop: &AtomicBool, child: &Mutex<Option<Child>>) -> String {
    loop {
        if stop.load(Ordering::SeqCst) {
            return "stopped by the till".into();
        }
        if let Ok(mut held) = child.lock() {
            match held.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(status))) => {
                    held.take();
                    return format!("cloudflared exited with {status}");
                }
                Some(Err(e)) => return format!("could not watch cloudflared: {e}"),
                None => return "stopped by the till".into(),
                Some(Ok(None)) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn spawn(exe: &Path, config: &Path, log: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.arg("tunnel")
        .arg("--config").arg(config)
        .arg("--loglevel").arg("warn")
        .arg("--logfile").arg(log)
        .arg("run")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
}

fn set(state: &Mutex<TunnelState>, change: impl FnOnce(&mut TunnelState)) {
    if let Ok(mut s) = state.lock() {
        change(&mut s);
    }
}

fn default_exe() -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|d| d.join("cloudflared").join("cloudflared.exe"));
    match local {
        Some(p) if p.is_file() => p,
        _ => PathBuf::from("cloudflared"),
    }
}

fn default_config() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".cloudflared")
        .join("config-shopos.yml")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// `cmd.exe` given cloudflared's arguments and no input exits at once: a
    /// tunnel that keeps falling over, which is what the keeper is for.
    fn keep(exe: &str, for_ms: u64) -> (TunnelState, bool) {
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let state = Arc::new(Mutex::new(TunnelState::default()));
        let log = std::env::temp_dir().join("shopos-tunnel-test.log");
        let handle = {
            let (stop, child, state) = (Arc::clone(&stop), Arc::clone(&child), Arc::clone(&state));
            let exe = PathBuf::from(exe);
            std::thread::spawn(move || {
                supervise(&exe, Path::new("no-such-config.yml"), &log, &stop, &child, &state, &AtomicU32::new(0))
            })
        };
        std::thread::sleep(Duration::from_millis(for_ms));
        stop.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let ended = loop {
            if handle.is_finished() {
                break true;
            }
            if started.elapsed() > Duration::from_secs(3) {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let seen = state.lock().unwrap().clone();
        (seen, ended)
    }

    #[test]
    fn starts_a_tunnel_that_stopped_again_and_says_why() {
        let (seen, ended) = keep("cmd.exe", 3500);
        assert!(seen.restarts >= 1, "restarts {}", seen.restarts);
        assert!(seen.problem.unwrap_or_default().contains("exited"));
        assert!(ended, "the keeper did not stop when asked");
    }

    #[test]
    fn says_so_when_cloudflared_is_not_on_this_computer() {
        let (seen, ended) = keep(r"C:\no\such\cloudflared.exe", 800);
        assert!(!seen.up);
        assert!(seen.problem.unwrap_or_default().contains("could not start"));
        assert!(ended);
    }
}
