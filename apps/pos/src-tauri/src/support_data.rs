//! The shop's data, sent to support when the owner says so.
//!
//! Support sees a symptom and guesses; this is the end of guessing. The owner
//! presses a button, retypes their password, and the shop's database leaves the
//! building -- encrypted to the vendor's public key, so that only the vendor's
//! private key, kept off every server, can open it. The portal that carries it
//! holds ciphertext and nothing else, and deletes it after thirty days.
//!
//! ## What is taken out first
//!
//! Always, from a copy, never the shop's own file: every password hash, every
//! sync secret, the recovery code's hash. Support never needs them, and a copy
//! that held them would be a way into the shop. With "leave out customer
//! details", also every customer's name, phone, email, GSTIN and address --
//! replaced by placeholders that stay the same for the same customer, so the
//! books still add up -- and the copies of those in bills, documents, the
//! audit log and records set aside. What staff typed in notes and reasons
//! stays: there is no telling a name in free text from anything else.
//!
//! `secure_delete` is on while it scrubs and the copy is vacuumed after, so a
//! value taken out is not still sitting in a free page of the file.
//!
//! ## The file
//!
//! `SHOPOSD1`, a one-time X25519 public key, then the payload in 64 KiB chunks
//! sealed with ChaCha20-Poly1305 under a key HKDF derives from the agreement.
//! Each chunk's nonce is its number; the last says it is last, so a file cut
//! short does not open. The payload is `SOD1`, a JSON manifest, and the
//! database gzipped. `tools/support` opens it.

use std::io::Write;
use std::path::{Path, PathBuf};

use ring::{aead, agreement, hkdf, rand};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::db::DbState;
use crate::{device, files, paths, portal_out};

const MAGIC: &[u8; 8] = b"SHOPOSD1";
const PAYLOAD_MAGIC: &[u8; 4] = b"SOD1";
const CHUNK: usize = 64 * 1024;
const SALT: &[u8] = b"shopos-support-data-v1";
const OUT: &str = "support-out";
const BUILT_KEY: Option<&str> = option_env!("SHOPOS_SUPPORT_PUBKEY");
/// Raw bytes sent in one request: well under the portal's 2 MB once in base64.
const PART: usize = 768 * 1024;

#[derive(Serialize, Deserialize)]
struct Meta {
    shop: String,
    device: String,
    version: String,
    anonymised: bool,
    note: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    id: String,
    bytes: u64,
    customers_hidden: u64,
}

/* ------------------------------------------------------------ commands --- */

/// Makes the encrypted file and keeps it in `support-out/` until it is sent or saved.
#[tauri::command(async)]
pub fn support_data_make(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    shop_id: String,
    made_by: String,
    note: String,
    anonymise: bool,
    now: String,
) -> Result<Made, String> {
    let vendor = vendor_key()?;
    let data = paths::data_dir(&app)?;
    let out = data.join(OUT);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let id: String = now.chars().filter(char::is_ascii_digit).take(14).collect();
    let copy = out.join(format!("{id}.db"));
    let _ = std::fs::remove_file(&copy);

    let made = (|| -> Result<Made, String> {
        db.get()?.vacuum_into(&copy)?;
        let hidden = scrub(&copy, anonymise)?;
        let version = app.package_info().version.to_string();
        let device_id = device::identity_of(&data)?.id;
        let manifest = json!({
            "format": 1, "shopId": shop_id, "deviceId": device_id, "appVersion": version,
            "madeAt": now, "madeBy": made_by, "note": note, "anonymised": anonymise,
            "customersHidden": hidden,
        });
        let sealed = seal(&payload(&manifest, &std::fs::read(&copy).map_err(|e| e.to_string())?)?, &vendor)?;
        files::write_durably(&out.join(format!("{id}.sod")), &sealed)?;
        let meta = Meta {
            shop: shop_id.clone(), device: device_id, version, anonymised: anonymise, note: note.clone(),
            bytes: sealed.len() as u64, sha256: sha256_hex(&sealed),
        };
        files::write_durably(&out.join(format!("{id}.json")), &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
        Ok(Made { id: id.clone(), bytes: sealed.len() as u64, customers_hidden: hidden })
    })();
    let _ = std::fs::remove_file(&copy);
    made
}

/// Copies a made file to a folder the owner chose, to send by hand.
#[tauri::command(async)]
pub fn support_data_save(app: tauri::AppHandle, id: String, folder: String) -> Result<String, String> {
    let source = sod_path(&app, &id)?;
    let meta = read_meta(&app, &id)?;
    let name = format!("ShopOS data {} {id}.sod", meta.shop.chars().filter(char::is_ascii_alphanumeric).take(8).collect::<String>());
    let target = Path::new(&folder).join(name);
    std::fs::copy(&source, &target).map_err(|e| format!("Could not save it to {folder}: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    done: bool,
    received: u64,
    bytes: u64,
    error: Option<String>,
}

/// Sends a made file to the portal, carrying on from wherever an earlier try stopped.
#[tauri::command(async)]
pub fn support_data_send(app: tauri::AppHandle, id: String) -> Result<Upload, String> {
    let data = paths::data_dir(&app)?;
    let url = portal_out::portal_url(&data)?
        .ok_or("This build has no portal to send to. Save it to a file and send that instead.")?;
    let meta = read_meta(&app, &id)?;
    let file = sod_path(&app, &id)?;
    match upload(&data, &url, &file, &meta) {
        Ok(()) => {
            let _ = std::fs::remove_file(&file);
            let _ = std::fs::remove_file(data.join(OUT).join(format!("{id}.json")));
            Ok(Upload { done: true, received: meta.bytes, bytes: meta.bytes, error: None })
        }
        Err(e) => Ok(Upload { done: false, received: 0, bytes: meta.bytes, error: Some(e) }),
    }
}

/// Throws a made file away without sending it.
#[tauri::command]
pub fn support_data_discard(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let out = paths::data_dir(&app)?.join(OUT);
    let _ = std::fs::remove_file(out.join(format!("{}.sod", plain_id(&id)?)));
    let _ = std::fs::remove_file(out.join(format!("{}.json", plain_id(&id)?)));
    Ok(())
}

/// Whether this build can encrypt to the vendor at all.
#[tauri::command]
pub fn support_data_ready() -> bool {
    vendor_key().is_ok()
}

/* --------------------------------------------------------------- parts --- */

fn plain_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()) {
        Ok(id)
    } else {
        Err("That is not one of this machine's files.".into())
    }
}

fn sod_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let path = paths::data_dir(app)?.join(OUT).join(format!("{}.sod", plain_id(id)?));
    if path.is_file() { Ok(path) } else { Err("That file is no longer here. Make it again.".into()) }
}

fn read_meta(app: &tauri::AppHandle, id: &str) -> Result<Meta, String> {
    let raw = std::fs::read(paths::data_dir(app)?.join(OUT).join(format!("{}.json", plain_id(id)?))).map_err(|e| e.to_string())?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

fn vendor_key() -> Result<[u8; 32], String> {
    use base64::Engine;
    let raw = BUILT_KEY.map(str::trim).filter(|k| !k.is_empty()).ok_or(
        "This copy of ShopOS has no support key, so it cannot send data safely. \
         Set SHOPOS_SUPPORT_PUBKEY in apps/pos/src-tauri/.env (tools/support/keygen.ts makes it) and build again.",
    )?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| "SHOPOS_SUPPORT_PUBKEY is not a key: it should be what tools/support/keygen.ts printed.")?;
    bytes.try_into().map_err(|_| "SHOPOS_SUPPORT_PUBKEY is the wrong length.".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Takes the secrets out of the copy, and with `anonymise` the customers too.
/// Returns how many customers were hidden.
pub fn scrub(path: &Path, anonymise: bool) -> Result<u64, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let run = |sql: &str| conn.execute_batch(sql).map_err(|e| format!("{e} in: {}", sql.lines().next().unwrap_or("")));
    run("PRAGMA secure_delete = ON")?;
    // These edits are not news: the change feed and the revisions stay as the shop had them.
    let applying: Option<i64> = conn.query_row("SELECT applying FROM sync_state WHERE id = 1", [], |r| r.get(0)).ok();
    if applying.is_some() {
        run("UPDATE sync_state SET applying = 1 WHERE id = 1")?;
    }
    run("UPDATE users SET password_hash = ''")?;
    run("UPDATE sync_peers SET secret = NULL")?;
    run("DELETE FROM settings WHERE key = 'recovery_code_hash' OR key LIKE '%password%' OR key LIKE '%secret%'")?;

    let mut hidden = 0;
    if anonymise {
        hidden = conn.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? as u64;
        run("
            UPDATE customers SET
              name = 'Customer ' || substr(id, -6),
              phone = CASE WHEN phone IS NULL OR phone = '' THEN phone ELSE '9' || substr('000000000' || rowid, -9) END,
              email = CASE WHEN email IS NULL OR email = '' THEN email ELSE 'customer-' || substr(id, -6) || '@example.invalid' END,
              gstin = CASE WHEN gstin IS NULL OR gstin = '' THEN gstin ELSE substr(gstin, 1, 2) || 'AAAAA0000A1Z5' END,
              address = CASE WHEN address IS NULL OR address = '' THEN address ELSE 'Address ' || substr(id, -6) END;
            UPDATE bills SET
              customer_name = CASE WHEN customer_name IS NULL THEN NULL
                ELSE COALESCE((SELECT c.name FROM customers c WHERE c.id = bills.customer_id), 'Customer') END,
              customer_gstin = CASE WHEN customer_gstin IS NULL OR customer_gstin = '' THEN customer_gstin
                ELSE substr(customer_gstin, 1, 2) || 'AAAAA0000A1Z5' END,
              customer_address = CASE WHEN customer_address IS NULL OR customer_address = '' THEN customer_address
                ELSE 'Address' END;
            UPDATE documents SET
              customer_name = CASE WHEN customer_name IS NULL THEN NULL
                ELSE COALESCE((SELECT c.name FROM customers c WHERE c.id = documents.customer_id), 'Customer') END;
            UPDATE audit_log SET diff = NULL WHERE entity IN ('customers', 'customer');
            UPDATE sync_quarantine SET record = NULL WHERE table_name IN ('customers', 'bills', 'documents');
            UPDATE sync_conflicts SET explain = NULL WHERE table_name IN ('customers', 'bills', 'documents');
        ")?;
    }

    if let Some(was) = applying {
        conn.execute("UPDATE sync_state SET applying = ?1 WHERE id = 1", [was]).map_err(|e| e.to_string())?;
    }
    run("VACUUM")?;
    Ok(hidden)
}

fn payload(manifest: &serde_json::Value, db: &[u8]) -> Result<Vec<u8>, String> {
    let manifest = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(db.len() / 3 + manifest.len() + 8);
    out.extend_from_slice(PAYLOAD_MAGIC);
    out.extend_from_slice(&(manifest.len() as u32).to_be_bytes());
    out.extend_from_slice(&manifest);
    let mut gz = flate2::write::GzEncoder::new(out, flate2::Compression::default());
    gz.write_all(db).map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}

/// Seals `plain` so that only the holder of the private half of `vendor` can open it.
pub fn seal(plain: &[u8], vendor: &[u8; 32]) -> Result<Vec<u8>, String> {
    let rng = rand::SystemRandom::new();
    let mine = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).map_err(|_| "no randomness")?;
    let my_public = mine.compute_public_key().map_err(|_| "no public key")?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::X25519, vendor);
    let mut info = Vec::with_capacity(64);
    info.extend_from_slice(my_public.as_ref());
    info.extend_from_slice(vendor);
    let key = agreement::agree_ephemeral(mine, &peer, |shared| derive(shared, &info))
        .map_err(|_| "the support key was refused")??;

    let mut out = Vec::with_capacity(plain.len() + plain.len() / CHUNK * 20 + 64);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(my_public.as_ref());
    let chunks: Vec<&[u8]> = if plain.is_empty() { vec![&[][..]] } else { plain.chunks(CHUNK).collect() };
    let last = chunks.len() - 1;
    for (i, chunk) in chunks.into_iter().enumerate() {
        let mut sealed = chunk.to_vec();
        key.seal_in_place_append_tag(nonce(i as u64), aead::Aad::from([u8::from(i == last)]), &mut sealed)
            .map_err(|_| "could not seal")?;
        out.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        out.extend_from_slice(&sealed);
    }
    Ok(out)
}

fn derive(shared: &[u8], info: &[u8]) -> Result<aead::LessSafeKey, String> {
    let info = [info];
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, SALT).extract(shared);
    let okm = prk.expand(&info, &aead::CHACHA20_POLY1305).map_err(|_| "could not derive a key")?;
    Ok(aead::LessSafeKey::new(aead::UnboundKey::from(okm)))
}

fn nonce(i: u64) -> aead::Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&i.to_be_bytes());
    aead::Nonce::assume_unique_for_key(n)
}

/* -------------------------------------------------------------- upload --- */

#[cfg(windows)]
const UPLOAD_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  $script:key = $env:SHOPOS_DATA_KEY
  function Post($url, $obj) {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
    $req.Content = New-Object System.Net.Http.StringContent((ConvertTo-Json -Compress -InputObject $obj), [Text.Encoding]::UTF8, 'application/json')
    [void]$req.Headers.TryAddWithoutValidation('X-ShopOS-Device', $env:SHOPOS_DATA_DEVICE)
    if ($script:key) {
      $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $script:key)
    }
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $body = $null; try { $body = ConvertFrom-Json $text } catch {}
    return @{ status = [int]$resp.StatusCode; body = $body; text = $text }
  }
  $bytes = [IO.File]::ReadAllBytes($env:SHOPOS_DATA_FILE)
  $start = Post $env:SHOPOS_DATA_START @{
    shopId = $env:SHOPOS_DATA_SHOP; deviceId = $env:SHOPOS_DATA_DEVICE; bytes = $bytes.Length
    sha256 = $env:SHOPOS_DATA_SHA; anonymised = ($env:SHOPOS_DATA_ANON -eq '1'); note = $env:SHOPOS_DATA_NOTE
  }
  if ($start.status -ne 200) { throw ('The portal said ' + $start.status + ': ' + $start.text) }
  # A till heard from for the first time is given its key here, and uses it for the parts that follow.
  # Written down at once, not printed: an upload that fails later must not lose it.
  if ($start.body.key) { $script:key = $start.body.key; [IO.File]::WriteAllText($env:SHOPOS_DATA_KEYFILE, $start.body.key) }
  $id = $start.body.uploadId
  $at = [long]$start.body.received
  $part = [int]$env:SHOPOS_DATA_PART
  while ($at -lt $bytes.Length) {
    $n = [Math]::Min($part, $bytes.Length - $at)
    $chunk = New-Object byte[] $n
    [Array]::Copy($bytes, $at, $chunk, 0, $n)
    $r = Post ($env:SHOPOS_DATA_BASE + '/v1/data/' + $id + '/part') @{ offset = $at; data = [Convert]::ToBase64String($chunk) }
    if ($r.status -eq 409 -or $r.status -eq 200) { $at = [long]$r.body.received } else { throw ('The portal said ' + $r.status + ': ' + $r.text) }
  }
  [Console]::Out.WriteLine('DONE')
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

#[cfg(windows)]
fn upload(data: &Path, url: &str, file: &Path, meta: &Meta) -> Result<(), String> {
    let key = portal_out::key(data);
    let fresh = data.join("portal-key.new");
    let _ = std::fs::remove_file(&fresh);
    let answer = crate::report_out::run_powershell(
        UPLOAD_SCRIPT,
        &[
            ("SHOPOS_DATA_BASE", url.to_string()),
            ("SHOPOS_DATA_START", format!("{url}/v1/shops/{}/data", portal_out::segment(&meta.shop))),
            ("SHOPOS_DATA_FILE", file.to_string_lossy().to_string()),
            ("SHOPOS_DATA_SHOP", meta.shop.clone()),
            ("SHOPOS_DATA_DEVICE", meta.device.clone()),
            ("SHOPOS_DATA_SHA", meta.sha256.clone()),
            ("SHOPOS_DATA_ANON", if meta.anonymised { "1" } else { "0" }.into()),
            ("SHOPOS_DATA_NOTE", meta.note.clone()),
            ("SHOPOS_DATA_PART", PART.to_string()),
            ("SHOPOS_DATA_KEY", key.unwrap_or_default()),
            ("SHOPOS_DATA_KEYFILE", fresh.to_string_lossy().to_string()),
        ],
        "The portal did not take the file.",
    );
    /* A key the portal gave on this first contact is kept whether or not the
       rest went: without it this till could never send again. */
    if let Ok(new_key) = std::fs::read_to_string(&fresh) {
        portal_out::keep_key(data, &new_key);
        let _ = std::fs::remove_file(&fresh);
    }
    let answer = answer?;
    if answer.lines().any(|l| l.trim() == "DONE") { Ok(()) } else { Err("The upload stopped part of the way. Press Send again to carry on.".into()) }
}

#[cfg(not(windows))]
fn upload(_: &Path, _: &str, _: &Path, _: &Meta) -> Result<(), String> {
    Err("Sending to the portal is only available on Windows. Save it to a file instead.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vendor's half, for a test: ring makes a key that can agree once, which is all one open needs.
    fn open(sealed: &[u8], vendor: agreement::EphemeralPrivateKey, vendor_public: &[u8]) -> Result<Vec<u8>, String> {
        assert_eq!(&sealed[..8], MAGIC);
        let their = &sealed[8..40];
        let mut info = their.to_vec();
        info.extend_from_slice(vendor_public);
        let key = agreement::agree_ephemeral(vendor, &agreement::UnparsedPublicKey::new(&agreement::X25519, their), |s| derive(s, &info))
            .map_err(|_| "agree")??;
        let mut at = 40;
        let mut i = 0u64;
        let mut out = Vec::new();
        let mut saw_last = false;
        while at < sealed.len() {
            let len = u32::from_be_bytes(sealed[at..at + 4].try_into().unwrap()) as usize;
            at += 4;
            let is_last = at + len == sealed.len();
            let mut chunk = sealed[at..at + len].to_vec();
            let plain = key.open_in_place(nonce(i), aead::Aad::from([u8::from(is_last)]), &mut chunk).map_err(|_| "bad chunk")?;
            out.extend_from_slice(plain);
            saw_last = is_last;
            at += len;
            i += 1;
        }
        if saw_last { Ok(out) } else { Err("cut short".into()) }
    }

    fn vendor() -> (agreement::EphemeralPrivateKey, [u8; 32]) {
        let k = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rand::SystemRandom::new()).unwrap();
        let p: [u8; 32] = k.compute_public_key().unwrap().as_ref().try_into().unwrap();
        (k, p)
    }

    #[test]
    fn only_the_vendor_key_opens_it() {
        let plain: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let (key, public) = vendor();
        let sealed = seal(&plain, &public).unwrap();
        assert_eq!(open(&sealed, key, &public).unwrap(), plain);

        let (other, other_public) = vendor();
        let _ = other_public;
        assert!(open(&sealed, other, &public).is_err(), "another key opens nothing");
    }

    #[test]
    fn a_file_cut_short_or_changed_does_not_open() {
        let plain = vec![7u8; CHUNK * 3 + 10];
        let (key, public) = vendor();
        let sealed = seal(&plain, &public).unwrap();
        let cut = &sealed[..sealed.len() - (10 + 16 + 4)];
        assert!(open(cut, key, &public).is_err());

        let (key, public) = vendor();
        let mut sealed = seal(&plain, &public).unwrap();
        let mid = sealed.len() / 2;
        sealed[mid] ^= 1;
        assert!(open(&sealed, key, &public).is_err());
    }

    #[test]
    fn nothing_readable_is_left_in_the_file() {
        let (_, public) = vendor();
        let sealed = seal(b"Customer Ravi Kumar 9876543210", &public).unwrap();
        assert!(!sealed.windows(4).any(|w| w == b"Ravi"));
    }

    /// Writes `tools/support/test/fixture.sod`, sealed to the test-only key
    /// beside it, for `tools/support/test/sod.test.ts` to open: the till's
    /// format and the vendor's tool are held to each other by a file both
    /// sides read. Run again only when the format changes:
    /// `cargo test --lib -- --ignored support_data::tests::make_the_fixture`.
    #[test]
    #[ignore]
    fn make_the_fixture() {
        use base64::Engine;
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/support/test");
        let key: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("fixture-key.json")).unwrap()).unwrap();
        let x = key["jwk"]["x"].as_str().unwrap();
        let public: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(x).unwrap().try_into().unwrap();
        let manifest = json!({
            "format": 1, "shopId": "fixture-shop", "deviceId": "fixture-till", "appVersion": "0.3.0",
            "madeAt": "2026-10-16T00:00:00Z", "madeBy": "admin", "note": "made by support_data.rs",
            "anonymised": true, "customersHidden": 2,
        });
        let db: Vec<u8> = (0..150_000u32).map(|i| (i % 97) as u8).collect();
        let sealed = seal(&payload(&manifest, &db).unwrap(), &public).unwrap();
        std::fs::write(dir.join("fixture.sod"), sealed).unwrap();
    }

    /// End to end on a real shop's database, by hand: copy, scrub, seal, and
    /// upload through the real PowerShell sender to a running portal. Reads
    /// `SHOPOS_E2E_DB` (a shop.db, only read), `SHOPOS_E2E_PUB`, `SHOPOS_E2E_URL`
    /// and `SHOPOS_E2E_DIR` (a scratch folder for the copy and the key).
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn a_real_shop_end_to_end() {
        use base64::Engine;
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let dir = PathBuf::from(var("SHOPOS_E2E_DIR"));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("copy.db");
        let _ = std::fs::remove_file(&copy);
        let source = Connection::open_with_flags(var("SHOPOS_E2E_DB"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        source.execute_batch(&format!("VACUUM INTO '{}'", copy.to_string_lossy().replace('\'', "''"))).unwrap();
        let shop: String = source.query_row("SELECT value FROM settings WHERE key = 'shop_id'", [], |r| r.get(0)).unwrap();

        let hidden = scrub(&copy, true).unwrap();
        let public: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(var("SHOPOS_E2E_PUB")).unwrap().try_into().unwrap();
        let manifest = json!({
            "format": 1, "shopId": shop, "deviceId": "e2e-till", "appVersion": "e2e", "madeAt": "now",
            "madeBy": "e2e", "note": "end to end", "anonymised": true, "customersHidden": hidden,
        });
        let sealed = seal(&payload(&manifest, &std::fs::read(&copy).unwrap()).unwrap(), &public).unwrap();
        let file = dir.join("e2e.sod");
        std::fs::write(&file, &sealed).unwrap();
        let till = format!("e2e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        let meta = Meta {
            shop, device: till, version: "e2e".into(), anonymised: true,
            note: "end to end".into(), bytes: sealed.len() as u64, sha256: sha256_hex(&sealed),
        };
        upload(&dir, &var("SHOPOS_E2E_URL"), &file, &meta).unwrap();
        assert!(portal_out::key(&dir).is_some(), "the portal's key was kept");
        // Again: the portal has it whole, so this sends nothing and says done.
        upload(&dir, &var("SHOPOS_E2E_URL"), &file, &meta).unwrap();
        println!("sealed {} bytes, {hidden} customers hidden", sealed.len());
    }

    fn a_shop(dir: &Path) -> PathBuf {
        let path = dir.join("shop.db");
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("
            CREATE TABLE sync_state (id INTEGER PRIMARY KEY, applying INTEGER NOT NULL DEFAULT 0);
            INSERT INTO sync_state VALUES (1, 0);
            CREATE TABLE users (id TEXT, username TEXT, password_hash TEXT);
            INSERT INTO users VALUES ('u1', 'admin', '$2b$10$secrethashsecrethash');
            CREATE TABLE sync_peers (device_id TEXT, secret TEXT);
            INSERT INTO sync_peers VALUES ('d1', 'peer-secret-value');
            CREATE TABLE settings (key TEXT, value TEXT);
            INSERT INTO settings VALUES ('recovery_code_hash', 'rc-hash-value'), ('shop_name', 'Sri Vidya');
            CREATE TABLE customers (id TEXT, name TEXT, phone TEXT, email TEXT, gstin TEXT, address TEXT);
            INSERT INTO customers VALUES ('c-000001', 'Ravi Kumar', '9876543210', 'ravi@mail.in', '33ABCDE1234F1Z5', '12 Car Street');
            CREATE TABLE bills (id TEXT, customer_id TEXT, customer_name TEXT, customer_gstin TEXT, customer_address TEXT, notes TEXT);
            INSERT INTO bills VALUES ('b1', 'c-000001', 'Ravi Kumar', '33ABCDE1234F1Z5', '12 Car Street', 'paid by GPay');
            CREATE TABLE documents (id TEXT, customer_id TEXT, customer_name TEXT);
            INSERT INTO documents VALUES ('o1', 'c-000001', 'Ravi Kumar');
            CREATE TABLE audit_log (entity TEXT, diff TEXT);
            INSERT INTO audit_log VALUES ('customers', '{\"name\":\"Ravi Kumar\"}');
            CREATE TABLE sync_quarantine (table_name TEXT, record TEXT);
            INSERT INTO sync_quarantine VALUES ('customers', '{\"name\":\"Ravi Kumar\"}');
            CREATE TABLE sync_conflicts (table_name TEXT, explain TEXT);
            INSERT INTO sync_conflicts VALUES ('customers', 'Ravi Kumar vs Ravi K');
        ").unwrap();
        path
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-support-data-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_secrets_never_leave_and_the_file_does_not_keep_them_in_a_free_page() {
        let dir = scratch("secrets");
        let path = a_shop(&dir);
        scrub(&path, false).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        for secret in ["secrethashsecrethash", "peer-secret-value", "rc-hash-value"] {
            assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()), "{secret} is still in the file");
        }
        // Without "leave out customers", the customers are there for support to see.
        assert!(bytes.windows(10).any(|w| w == b"Ravi Kumar"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaving_out_customers_leaves_no_trace_of_them() {
        let dir = scratch("anon");
        let path = a_shop(&dir);
        assert_eq!(scrub(&path, true).unwrap(), 1);
        let bytes = std::fs::read(&path).unwrap();
        for trace in ["Ravi", "9876543210", "ravi@mail.in", "ABCDE1234F", "Car Street"] {
            assert!(!bytes.windows(trace.len()).any(|w| w == trace.as_bytes()), "{trace} is still in the file");
        }
        let conn = Connection::open(&path).unwrap();
        let (bill, customer): (String, String) = conn
            .query_row("SELECT b.customer_name, c.name FROM bills b JOIN customers c ON c.id = b.customer_id", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(bill, customer, "the same customer reads the same everywhere");
        assert_eq!(customer, "Customer 000001");
        let gstin: String = conn.query_row("SELECT gstin FROM customers", [], |r| r.get(0)).unwrap();
        assert!(gstin.starts_with("33"), "the state stays, so tax still works out");
        let applying: i64 = conn.query_row("SELECT applying FROM sync_state", [], |r| r.get(0)).unwrap();
        assert_eq!(applying, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
