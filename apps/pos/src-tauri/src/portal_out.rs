//! The health report to the vendor's portal, from every shop.
//!
//! The same report the vendor's bot carries, as JSON and without the logs:
//! the checks, the app's own findings and `faults.json` -- the figures the
//! portal's alert rules read (`apps/portal/src/health`). Nothing in it names a
//! customer, an amount or a credential; `health.rs` holds it to that.
//!
//! Queued in a folder of its own and retried, like mail and Telegram
//! (`report_out.rs`), because the shop's line is poor. Its own folder because
//! everything in `outbox/` is read as a mail or a Telegram message.
//!
//! ## The key
//!
//! The portal answers a till's first report with a key, kept here in
//! `portal-key` beside the database and sent with every report after. It is
//! this machine's, not the shop's -- `device.json` and this file are the two
//! things a restore does not bring back -- so a till restored onto a new PC
//! starts with a new device id and gets a key of its own.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{device, files, paths};

const QUEUE: &str = "outbox-portal";
const KEY_FILE: &str = "portal-key";
/// A newer report supersedes an older one: only the latest few wait.
const KEEP_QUEUED: usize = 5;
const PORTAL_URL: &str = "portal_url";
const BUILT_URL: Option<&str> = option_env!("SHOPOS_PORTAL_URL");

#[derive(Serialize, Deserialize)]
struct Queued {
    shop: String,
    device: String,
    version: String,
}

/// Where the portal is: this machine's setting, else the build's, else none.
pub fn portal_url(data: &Path) -> Result<Option<String>, String> {
    let set = device::setting(data, PORTAL_URL)?.filter(|u| !u.trim().is_empty());
    let Some(url) = set.or_else(|| BUILT_URL.map(str::to_string)).filter(|u| !u.trim().is_empty()) else {
        return Ok(None);
    };
    let url = url.trim().trim_end_matches('/').to_string();
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if !(url.starts_with("https://") || local) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The portal address must be https.".into());
    }
    Ok(Some(url))
}

/// Whether health goes to the vendor's portal from this build at all.
pub fn built_in() -> bool {
    BUILT_URL.is_some_and(|u| !u.trim().is_empty())
}

fn queue_dir(data: &Path) -> Result<PathBuf, String> {
    let dir = data.join(QUEUE);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Queues one report and tries to send everything waiting. `off`, `sent` or `queued`.
pub fn send(
    app: &tauri::AppHandle,
    payload: &[u8],
    shop: &str,
    device_id: &str,
    version: &str,
) -> (&'static str, Option<String>) {
    let attempt = || -> Result<(&'static str, Option<String>), String> {
        let data = paths::data_dir(app)?;
        let Some(url) = portal_url(&data)? else { return Ok(("off", None)) };
        let dir = queue_dir(&data)?;
        let id = format!("{:016}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
        let meta = serde_json::to_vec(&Queued { shop: shop.into(), device: device_id.into(), version: version.into() })
            .map_err(|e| e.to_string())?;
        files::write_durably(&dir.join(format!("{id}.payload")), payload)?;
        files::write_durably(&dir.join(format!("{id}.json")), &meta)?;
        trim(&dir);
        let error = flush_to(&data, &url);
        let waiting = dir.join(format!("{id}.json")).exists();
        Ok((if waiting { "queued" } else { "sent" }, if waiting { error } else { None }))
    };
    attempt().unwrap_or_else(|e| ("off", Some(e)))
}

/// Sends what is waiting, oldest first; the first failure stops the rest.
/// From the outbox's own retry, so a report queued offline goes when the line is back.
pub fn flush(app: &tauri::AppHandle) -> Option<String> {
    let data = paths::data_dir(app).ok()?;
    match portal_url(&data) {
        Ok(Some(url)) => flush_to(&data, &url),
        Ok(None) => None,
        Err(e) => Some(e),
    }
}

fn flush_to(data: &Path, url: &str) -> Option<String> {
    let Ok(dir) = queue_dir(data) else { return None };
    for id in waiting(&dir) {
        let meta = std::fs::read(dir.join(format!("{id}.json")))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Queued>(&raw).ok());
        let Some(meta) = meta else {
            remove(&dir, &id);
            continue;
        };
        match post(url, &dir.join(format!("{id}.payload")), &meta, key(data).as_deref()) {
            Ok(answer) => {
                if let Some(new_key) = issued_key(&answer) {
                    keep_key(data, &new_key);
                }
                remove(&dir, &id);
            }
            Err(e) => return Some(e),
        }
    }
    None
}

/// The key this till proves itself to the portal with, once it has one.
pub fn key(data: &Path) -> Option<String> {
    std::fs::read_to_string(data.join(KEY_FILE)).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// Keeps a key the portal gave, when it is shaped like one.
pub fn keep_key(data: &Path, key: &str) {
    let key = key.trim();
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        let _ = files::write_durably(&data.join(KEY_FILE), key.as_bytes());
    }
}

/// The key in the portal's answer, when it gave one.
fn issued_key(answer: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(answer).ok()?;
    let key = value.get("key")?.as_str()?;
    (!key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| key.to_string())
}

fn waiting(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json").map(str::to_string)))
        .collect();
    ids.sort();
    ids
}

fn trim(dir: &Path) {
    let ids = waiting(dir);
    for id in ids.iter().take(ids.len().saturating_sub(KEEP_QUEUED)) {
        remove(dir, id);
    }
}

fn remove(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.payload")));
}

/// Percent-encodes a path segment.
pub fn segment(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(windows)]
const PORTAL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(100)
  $bytes = [IO.File]::ReadAllBytes($env:SHOPOS_PORTAL_FILE)
  $content = New-Object System.Net.Http.ByteArrayContent(,$bytes)
  $content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json')
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $env:SHOPOS_PORTAL_URL)
  $req.Content = $content
  [void]$req.Headers.TryAddWithoutValidation('X-ShopOS-Device', $env:SHOPOS_PORTAL_DEVICE)
  [void]$req.Headers.TryAddWithoutValidation('X-ShopOS-Version', $env:SHOPOS_PORTAL_VERSION)
  if ($env:SHOPOS_PORTAL_KEY) {
    $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $env:SHOPOS_PORTAL_KEY)
  }
  $resp = $client.SendAsync($req).GetAwaiter().GetResult()
  $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) {
    $why = $text
    try { $j = ConvertFrom-Json $text; $why = $j.error; if ($j.detail) { $why = $why + ': ' + $j.detail } } catch {}
    throw ('The portal said ' + [int]$resp.StatusCode + ': ' + $why)
  }
  [Console]::Out.Write($text)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

#[cfg(windows)]
fn post(url: &str, file: &Path, meta: &Queued, key: Option<&str>) -> Result<String, String> {
    let answer = crate::report_out::run_powershell(
        PORTAL_SCRIPT,
        &[
            ("SHOPOS_PORTAL_URL", format!("{url}/v1/shops/{}/health", segment(&meta.shop))),
            ("SHOPOS_PORTAL_FILE", file.to_string_lossy().to_string()),
            ("SHOPOS_PORTAL_DEVICE", meta.device.clone()),
            ("SHOPOS_PORTAL_VERSION", meta.version.clone()),
            ("SHOPOS_PORTAL_KEY", key.unwrap_or("").to_string()),
        ],
        "The portal did not take the health report.",
    );
    answer.map_err(|e| if e.contains("BAD_KEY") {
        "The portal does not know this till's key. Support can reset it from the console.".into()
    } else {
        e
    })
}

#[cfg(not(windows))]
fn post(_: &str, _: &Path, _: &Queued, _: Option<&str>) -> Result<String, String> {
    Err("Sending to the portal is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_key_the_portal_gives_and_nothing_else() {
        assert_eq!(issued_key(r#"{"received":"ab","key":"Xy_9-zz"}"#).as_deref(), Some("Xy_9-zz"));
        assert_eq!(issued_key(r#"{"received":"ab"}"#), None);
        assert_eq!(issued_key(r#"{"key":"has space"}"#), None);
        assert_eq!(issued_key("not json"), None);
    }

    #[test]
    fn a_shop_id_cannot_change_the_address() {
        assert_eq!(segment("0192f4a1-77aa"), "0192f4a1-77aa");
        assert_eq!(segment("../x?y"), "..%2Fx%3Fy");
    }

    #[test]
    fn only_the_newest_few_wait() {
        let dir = std::env::temp_dir().join("shopos-portal-out-tests");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..KEEP_QUEUED + 3 {
            std::fs::write(dir.join(format!("{i:016}.json")), b"{}").unwrap();
            std::fs::write(dir.join(format!("{i:016}.payload")), b"{}").unwrap();
        }
        trim(&dir);
        let left = waiting(&dir);
        assert_eq!(left.len(), KEEP_QUEUED);
        assert_eq!(left[0], format!("{:016}", 3));
        assert!(!dir.join(format!("{:016}.payload", 0)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_address_is_https_or_this_machine() {
        let dir = std::env::temp_dir().join("shopos-portal-url-tests");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let with = |url: &str| {
            std::fs::write(
                dir.join("device.json"),
                format!(r#"{{"device_id":"0192f4a1-77aa-7bcd-8000-000000000001","label":"t","settings":{{"portal_url":"{url}"}}}}"#),
            ).unwrap();
            portal_url(&dir)
        };
        assert_eq!(with("https://portal.example.in/").unwrap().as_deref(), Some("https://portal.example.in"));
        assert_eq!(with("http://127.0.0.1:8787").unwrap().as_deref(), Some("http://127.0.0.1:8787"));
        assert!(with("http://portal.example.in").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
