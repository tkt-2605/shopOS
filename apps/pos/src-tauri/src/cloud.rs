/// The online shop's public side, kept in Cloudflare so it is there when the
/// till is not: the item list, the shop's status and settings, and the photos.
///
/// The storefront reads them from `shop.thiruvengadam.me/data/...` (a Pages
/// Function over a Workers KV namespace, `apps/storefront/functions/`), and
/// only orders, sign-in and order status still need the till. So a setting
/// changed and the till switched off a minute later is still what every phone
/// sees tonight. What to upload, and when, is decided in the webview
/// (`core/cloudShop.ts`); this file only carries bytes to Cloudflare's API.
///
/// The token is read at run time from `%USERPROFILE%\.shopos\cloudflare.env`
/// (`CF_ACCOUNT`, `CF_KV`, `CF_TOKEN`), never built into the exe: every till
/// is built from one folder, and a copy of an exe should not carry the key to
/// the shop's Cloudflare account. No file, nothing is uploaded and the
/// storefront falls back to asking the till, as before.
use std::path::PathBuf;

use crate::paths;

struct Keys {
    account: String,
    namespace: String,
    token: String,
}

fn keys() -> Option<Keys> {
    let file = std::env::var_os("USERPROFILE").map(PathBuf::from)?.join(".shopos").join("cloudflare.env");
    parse_keys(&std::fs::read_to_string(file).ok()?)
}

fn parse_keys(text: &str) -> Option<Keys> {
    let get = |name: &str| {
        text.lines().find_map(|l| {
            let (k, v) = l.trim().split_once('=')?;
            (k.trim().trim_start_matches('\u{feff}') == name).then(|| v.trim().trim_matches('"').to_string())
        }).filter(|v| !v.is_empty())
    };
    Some(Keys { account: get("CF_ACCOUNT")?, namespace: get("CF_KV")?, token: get("CF_TOKEN")? })
}

/// Whether this PC can upload the shop to Cloudflare.
#[tauri::command]
pub fn cloud_ready() -> bool {
    keys().is_some()
}

/// One text value (the item list, the status), stored under `key`.
#[tauri::command(async)]
pub fn cloud_put_text(app: tauri::AppHandle, key: String, text: String) -> Result<(), String> {
    let dir = paths::data_dir(&app)?.join("work");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("cloud-{}.json", safe(&key)?));
    std::fs::write(&file, text.as_bytes()).map_err(|e| e.to_string())?;
    let sent = put(&key, &file);
    let _ = std::fs::remove_file(&file);
    sent
}

/// A product photo by its content hash, stored as `img-<hash>`. False when
/// this till has no file for it (a photo added on another till).
#[tauri::command(async)]
pub fn cloud_put_photo(app: tauri::AppHandle, hash: String) -> Result<bool, String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("not a photo hash".into());
    }
    let root = paths::attachments_dir(&app)?;
    for ext in ["webp", "jpg", "png"] {
        let Ok(path) = paths::in_attachments(&root, &format!("{}/{hash}.{ext}", &hash[..2])) else { continue };
        if path.is_file() {
            put(&format!("img-{hash}"), &path)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn safe(key: &str) -> Result<&str, String> {
    if !key.is_empty() && key.len() <= 80 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(key)
    } else {
        Err(format!("not a key Cloudflare is given: {key}"))
    }
}

#[cfg(windows)]
const PUT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $u = "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT/storage/kv/namespaces/$env:CF_KV/values/$env:CF_KEY"
  $r = Invoke-WebRequest -UseBasicParsing -Method Put -Uri $u -InFile $env:CF_FILE -ContentType 'application/octet-stream' `
    -Headers @{ Authorization = "Bearer $env:CF_TOKEN" } -TimeoutSec 60
  [Console]::Out.Write($r.StatusCode)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

#[cfg(windows)]
fn put(key: &str, file: &std::path::Path) -> Result<(), String> {
    let k = keys().ok_or("This computer has no Cloudflare key (.shopos\\cloudflare.env).")?;
    crate::report_out::run_powershell(
        PUT_SCRIPT,
        &[
            ("CF_ACCOUNT", k.account),
            ("CF_KV", k.namespace),
            ("CF_TOKEN", k.token),
            ("CF_KEY", safe(key)?.to_string()),
            ("CF_FILE", file.to_string_lossy().to_string()),
        ],
        "Cloudflare did not take the upload.",
    )
    .map(|_| ())
}

#[cfg(not(windows))]
fn put(_: &str, _: &std::path::Path) -> Result<(), String> {
    Err("Uploading to Cloudflare is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::{parse_keys, safe};

    #[test]
    fn reads_the_three_keys_and_needs_all_of_them() {
        let k = parse_keys("\u{feff}# note\nCF_ACCOUNT=acc\nCF_KV = ns \nCF_TOKEN=\"tok\"\n").unwrap();
        assert_eq!((k.account.as_str(), k.namespace.as_str(), k.token.as_str()), ("acc", "ns", "tok"));
        assert!(parse_keys("CF_ACCOUNT=acc\nCF_KV=ns\n").is_none());
        assert!(parse_keys("CF_ACCOUNT=acc\nCF_KV=ns\nCF_TOKEN=\n").is_none());
    }

    #[test]
    fn only_plain_keys_reach_cloudflare() {
        assert!(safe("catalog").is_ok());
        assert!(safe(&format!("img-{}", "a".repeat(64))).is_ok());
        let long = "k".repeat(81);
        for bad in ["", "img/abc", "../x", "a b", "status?x=1", long.as_str()] {
            assert!(safe(bad).is_err(), "{bad}");
        }
    }
}
