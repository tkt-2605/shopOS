/// Answering the storefront, from inside the app.
///
/// The listener is `crates/shopos-net/src/web.rs`, loopback only, reached by
/// `cloudflared` and through it by customers' phones; that file says why it is
/// a door of its own beside sync's. What is here is the app's half, as
/// `sync_server.rs` is for sync: the commands a screen calls, and an answerer
/// that hands each request to the webview (`core/webHost.ts`), where
/// `handleWebRequest` in core decides what it means.
///
/// Photos are the exception. `/img/<hash>` is answered here, straight off the
/// attachments folder: a photo is bytes, the webview answers in strings, and
/// there is nothing to decide about a file named by its own hash that only a
/// listed item's photo can be (the catalogue is what hands the hash out).
///
/// ── Off unless the webview says so ─────────────────────────────────────────
///
/// Nothing listens until `web_serve_start`, which the webview calls only on
/// the main of a shop online orders are for, with them turned on
/// (`onlineOrdersAllowed`).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::paths;
use shopos_net::web::{self, WebAnswerer, WebBound, WebReply, WebRequest};
use tauri::{Emitter, Manager};

/// A storefront request is a read or one small write. Twenty seconds is far
/// more than any takes, and less than a phone waits before giving up.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone)]
struct Forwarded {
    id: u64,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Deserialize)]
pub struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Default)]
pub struct WebHost {
    running: Mutex<Option<WebBound>>,
    waiting: Mutex<HashMap<u64, Sender<Reply>>>,
    next: AtomicU64,
    status: Mutex<Option<LiveStatus>>,
}

/// `/api/status` as the webview last worked it out (`web_set_status`), with
/// the one origin it may be read from.
///
/// Every open storefront asks for it about once a minute, and it is the
/// answer that says whether the shop is there at all. Answered here, it costs
/// the counter's webview nothing and is still answered while the webview is
/// busy billing or reloading -- a phone that got no answer would show the shop
/// as closed. The webview sends a fresh copy every half minute and after any
/// change in Settings, Online orders, and clears it when it stops serving.
#[derive(Clone)]
struct LiveStatus {
    body: String,
    origin: Option<String>,
}

struct ToWebview {
    app: tauri::AppHandle,
}

impl WebAnswerer for ToWebview {
    fn answer(&self, request: WebRequest) -> WebReply {
        if let Some(hash) = request.path.strip_prefix("/img/") {
            return photo(&self.app, &request.method, hash);
        }
        let host = self.app.state::<WebHost>();
        if request.method == "GET" && request.path.split('?').next() == Some("/api/status") {
            let live = host.status.lock().ok().and_then(|s| s.clone());
            if let Some(live) = live {
                let origin = request.headers.iter().find(|(n, _)| n == "origin").map(|(_, v)| v.as_str());
                return status_reply(&live, origin);
            }
        }
        let id = host.next.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = channel::<Reply>();
        if let Ok(mut waiting) = host.waiting.lock() {
            waiting.insert(id, sender);
        }
        let forwarded = Forwarded {
            id,
            method: request.method,
            path: request.path,
            headers: request.headers.into_iter().collect(),
            body: request.body,
        };
        if self.app.emit("web-request", forwarded).is_err() {
            if let Ok(mut waiting) = host.waiting.lock() {
                waiting.remove(&id);
            }
            return WebReply::refuse(503, "NOT_READY");
        }
        match receiver.recv_timeout(ANSWER_TIMEOUT) {
            Ok(reply) => WebReply {
                status: reply.status,
                headers: reply.headers.into_iter().collect(),
                body: reply.body.into_bytes(),
            },
            Err(_) => {
                if let Ok(mut waiting) = host.waiting.lock() {
                    waiting.remove(&id);
                }
                WebReply::refuse(503, "NOT_READY")
            }
        }
    }
}

/// The cached status, with the CORS headers `routes.ts` gives the same
/// origin (`corsFor`): none for any other.
fn status_reply(live: &LiveStatus, origin: Option<&str>) -> WebReply {
    let mut headers = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("cache-control".to_string(), "no-store".to_string()),
    ];
    if let (Some(origin), Some(allowed)) = (origin, live.origin.as_deref()) {
        if origin == allowed {
            headers.push(("access-control-allow-origin".into(), origin.into()));
            headers.push(("access-control-allow-headers".into(), "authorization, content-type".into()));
            headers.push(("access-control-allow-methods".into(), "GET, POST, OPTIONS".into()));
            headers.push(("vary".into(), "Origin".into()));
        }
    }
    WebReply { status: 200, headers, body: live.body.clone().into_bytes() }
}

/// A product photo by its content hash. Only the WebP and the two photo types
/// are served; a PDF attached to an item is not a photo.
fn photo(app: &tauri::AppHandle, method: &str, hash: &str) -> WebReply {
    if method != "GET" {
        return WebReply::refuse(405, "GET_ONLY");
    }
    let hash = hash.split('?').next().unwrap_or_default();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return WebReply::refuse(404, "NOT_FOUND");
    }
    let Ok(root) = paths::attachments_dir(app) else {
        return WebReply::refuse(503, "NOT_READY");
    };
    for (ext, mime) in [("webp", "image/webp"), ("jpg", "image/jpeg"), ("png", "image/png")] {
        let Ok(path) = paths::in_attachments(&root, &format!("{}/{hash}.{ext}", &hash[..2])) else { continue };
        if let Ok(bytes) = std::fs::read(&path) {
            return WebReply {
                status: 200,
                headers: vec![
                    ("content-type".into(), mime.into()),
                    // Named by its own content, so it can never be anything else.
                    ("cache-control".into(), "public, max-age=31536000, immutable".into()),
                    ("access-control-allow-origin".into(), "*".into()),
                ],
                body: bytes,
            };
        }
    }
    WebReply::refuse(404, "NOT_FOUND")
}

#[tauri::command]
pub fn web_serve_start(app: tauri::AppHandle, port: u16) -> Result<u16, String> {
    let host = app.state::<WebHost>();
    let mut running = host.running.lock().map_err(|_| "web host is wedged")?;
    if let Some(current) = running.as_ref() {
        return Ok(current.port);
    }
    /* Insisting on the port, not settling for another: `cloudflared` is
       configured with this one, and a different one would be a storefront
       that is "unreachable" for a reason nobody could see. */
    let bound = web::serve_web(port, Arc::new(ToWebview { app: app.clone() }))
        .map_err(|e| format!("{e}{}", crate::ports::held_by(port, false)))?;
    let port = bound.port;
    *running = Some(bound);
    Ok(port)
}

#[tauri::command]
pub fn web_serve_stop(app: tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<WebHost>();
    let mut running = host.running.lock().map_err(|_| "web host is wedged")?;
    if let Some(current) = running.take() {
        current.stop();
    }
    if let Ok(mut status) = host.status.lock() {
        *status = None;
    }
    Ok(())
}

#[tauri::command]
pub fn web_serve_status(app: tauri::AppHandle) -> Option<u16> {
    let host = app.state::<WebHost>();
    let running = host.running.lock().ok()?;
    running.as_ref().map(|b| b.port)
}

/// What `/api/status` says, from the webview; `None` sends status requests
/// back to the webview, which is what a till that should not serve wants.
#[tauri::command]
pub fn web_set_status(app: tauri::AppHandle, body: Option<String>, origin: Option<String>) {
    let host = app.state::<WebHost>();
    if let Ok(mut status) = host.status.lock() {
        *status = body.map(|body| LiveStatus { body, origin: origin.filter(|o| !o.is_empty()) });
    };
}

#[tauri::command]
pub fn web_reply(app: tauri::AppHandle, id: u64, status: u16, headers: HashMap<String, String>, body: String) {
    let host = app.state::<WebHost>();
    let sender = host.waiting.lock().ok().and_then(|mut w| w.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(Reply { status, headers, body });
    }
}

/// Opens WhatsApp at a chat with a customer, with a message ready to send.
///
/// The link is built here from a phone number and some text, never taken whole
/// from the webview, so nothing but a `wa.me` address can be handed to the
/// system to open.
#[tauri::command]
pub fn web_open_whatsapp(phone: String, text: String) -> Result<(), String> {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    let number = match digits.len() {
        10 => format!("91{digits}"),
        12 if digits.starts_with("91") => digits,
        _ => return Err("That is not a phone number WhatsApp can open.".into()),
    };
    let encoded: String = text
        .chars()
        .take(500)
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                vec![c.to_string()]
            } else {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf).bytes().map(|b| format!("%{b:02X}")).collect()
            }
        })
        .collect();
    open_link(&format!("https://wa.me/{number}?text={encoded}"))
}

#[cfg(windows)]
fn open_link(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(0x0800_0000)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open WhatsApp: {e}"))
}

#[cfg(not(windows))]
fn open_link(_: &str) -> Result<(), String> {
    Err("Opening WhatsApp is only available on Windows.".into())
}

/// Google's current signing keys, as the JSON Google serves them, for the
/// webview to check sign-in tokens against (`services/web/google.ts`). None
/// when the line is down; the webview keeps the last ones it had.
#[tauri::command(async)]
pub fn web_google_keys() -> Option<String> {
    fetch_keys()
}

#[cfg(windows)]
const KEYS_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://www.googleapis.com/oauth2/v3/certs' -TimeoutSec 30
  [Console]::Out.Write($r.Content)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

#[cfg(windows)]
fn fetch_keys() -> Option<String> {
    let text = crate::report_out::run_powershell(KEYS_SCRIPT, &[], "Google did not answer.").ok()?;
    let text = text.trim().to_string();
    (text.starts_with('{') && text.len() < 64 * 1024).then_some(text)
}

#[cfg(not(windows))]
fn fetch_keys() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live() -> LiveStatus {
        LiveStatus { body: r#"{"state":"open"}"#.into(), origin: Some("https://shop.example.in".into()) }
    }

    fn header<'a>(reply: &'a WebReply, name: &str) -> Option<&'a str> {
        reply.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_cached_status_is_readable_from_the_storefront_and_from_nowhere_else() {
        let own = status_reply(&live(), Some("https://shop.example.in"));
        assert_eq!(own.status, 200);
        assert_eq!(own.body, br#"{"state":"open"}"#);
        assert_eq!(header(&own, "access-control-allow-origin"), Some("https://shop.example.in"));
        assert_eq!(header(&own, "cache-control"), Some("no-store"));

        let other = status_reply(&live(), Some("https://elsewhere.example"));
        assert_eq!(header(&other, "access-control-allow-origin"), None);
        assert_eq!(header(&status_reply(&live(), None), "access-control-allow-origin"), None);
    }
}
