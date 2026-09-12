/// The bytes behind an attachment.
///
/// The webview hands over a photograph as base64 and gets back a hash; the row
/// that points at it is written by the TypeScript core afterwards. Files are
/// named by their own SHA-256, so attaching the same UPI screenshot to two bills
/// writes it once and a backup carries it once.
///
/// Nothing here trusts what the webview says a file is. The declared type is
/// ignored and the first bytes are read instead, because a name and a MIME
/// string are only a claim — and this module's whole job is deciding what gets
/// written to disk.
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::paths;

/// Ten megabytes, checked against the decoded bytes rather than the base64.
/// A phone photograph is two; a scan of a supplier invoice is under one.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Serialize)]
pub struct Stored {
    #[serde(rename = "fileName")]
    file_name: String,
    mime: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: usize,
    sha256: String,
    #[serde(rename = "storedPath")]
    stored_path: String,
    /// True when the bytes were already there under another document. The screen
    /// says so rather than pretending to have saved a second copy.
    existed: bool,
}

/// What the first bytes say the file actually is.
///
/// An allow-list of five: photographs and PDF. A shop's evidence folder, not a
/// file share — and an executable that arrives named `.jpg` is refused here
/// rather than discovered later.
fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(("image/png", "png"));
    }
    if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    if bytes.starts_with(b"%PDF-") {
        return Some(("application/pdf", "pdf"));
    }
    // HEIC is what an iPhone takes by default: an ISO base media file whose
    // brand, at offset 8, says which flavour.
    if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1") {
            return Some(("image/heic", "heic"));
        }
    }
    None
}

fn digest_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            use std::fmt::Write as _;
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Cleans up a name for display. The name never reaches the filesystem — the
/// hash decides where the file goes — so this only has to be something a
/// shopkeeper can read back.
fn display_name(name: &str, ext: &str) -> String {
    let base: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | '"' | '|'))
        .take(120)
        .collect();
    let trimmed = base.trim();
    if trimmed.is_empty() {
        format!("attachment.{ext}")
    } else {
        trimmed.to_string()
    }
}

fn write_atomically(target: &Path, work: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }

    // Written under a temporary name and renamed in, so a crash or a full disk
    // never leaves a half-written file wearing the hash of the whole one — which
    // is what every later read, and every backup, would trust.
    let part = crate::archive::Temp(work.join(format!(
        "{}.part",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("attachment")
    )));
    let mut file =
        std::fs::File::create(&part.0).map_err(|e| format!("Could not create {}: {e}", part.0.display()))?;
    file.write_all(bytes).map_err(|e| format!("Could not write the file: {e}"))?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    std::fs::rename(&part.0, target).map_err(|e| format!("Could not save {}: {e}", target.display()))
}

pub fn store_bytes(root: &Path, work: &Path, bytes: &[u8], file_name: &str) -> Result<Stored, String> {
    if bytes.is_empty() {
        return Err("That file is empty.".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "That file is {:.1} MB. ShopOS keeps attachments up to {} MB.",
            bytes.len() as f64 / 1_048_576.0,
            MAX_BYTES / 1_048_576
        ));
    }

    let (mime, ext) = sniff(bytes)
        .ok_or_else(|| "ShopOS keeps photographs and PDFs against a document, and that is neither.".to_string())?;

    let sha = digest_of(bytes);
    let rel = format!("{}/{}.{ext}", &sha[..2], sha);
    let target = paths::in_attachments(root, &rel)?;

    let existed = target.exists();
    if !existed {
        write_atomically(&target, work, bytes)?;
    }

    Ok(Stored {
        file_name: display_name(file_name, ext),
        mime: mime.to_string(),
        size_bytes: bytes.len(),
        sha256: sha,
        stored_path: rel,
        existed,
    })
}

#[tauri::command]
pub fn attachment_store(
    app: tauri::AppHandle,
    data: String,
    file_name: String,
) -> Result<Stored, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "That file did not arrive intact.".to_string())?;

    let root = paths::attachments_dir(&app)?;
    let work = paths::work_dir(&app)?;
    store_bytes(&root, &work, &bytes, &file_name)
}

/// Reads a file back as a data URL.
///
/// `assetProtocol` is off and the CSP allows `data:` for images, so this is how a
/// photograph reaches the screen without opening a second way into the
/// filesystem. Large images pay for it in memory; the answer then is the asset
/// protocol scoped to this one directory, not a looser CSP.
#[tauri::command]
pub fn attachment_read(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = paths::attachments_dir(&app)?;
    let file = paths::in_attachments(&root, &path)?;
    let bytes = std::fs::read(&file).map_err(|_| "That file is no longer on this machine.".to_string())?;

    let mime = sniff(&bytes).map(|(m, _)| m).unwrap_or("application/octet-stream");
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Deletes the bytes, once the core has confirmed no row still points at them.
/// A file that is already gone is not an error — the row is the record.
#[tauri::command]
pub fn attachment_delete(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = paths::attachments_dir(&app)?;
    paths::remove_if_present(&paths::in_attachments(&root, &path)?)
}

/// Whether the bytes are actually there, for telling a shopkeeper that a
/// photograph is missing rather than showing them a broken frame.
#[tauri::command]
pub fn attachment_present(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let root = paths::attachments_dir(&app)?;
    Ok(paths::in_attachments(&root, &path)?.exists())
}

/// The full path, for adding a file to a backup archive.
pub fn file_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    paths::in_attachments(root, rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("shopos-attachment-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("work")).unwrap();
        std::fs::create_dir_all(dir.join("root")).unwrap();
        dir
    }

    #[test]
    fn the_same_photograph_is_written_once() {
        let dir = scratch("dedup");
        let (root, work) = (dir.join("root"), dir.join("work"));

        let first = store_bytes(&root, &work, JPEG, "IMG_0001.JPG").unwrap();
        assert!(!first.existed);
        let second = store_bytes(&root, &work, JPEG, "whatsapp-image.jpg").unwrap();
        assert!(second.existed);

        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.stored_path, second.stored_path);
        // The names differ; the bytes do not, and only the bytes are on disk.
        assert_eq!(second.file_name, "whatsapp-image.jpg");
        assert!(root.join(&first.stored_path).exists());
    }

    #[test]
    fn the_file_lands_under_its_own_hash() {
        let dir = scratch("shard");
        let (root, work) = (dir.join("root"), dir.join("work"));
        let stored = store_bytes(&root, &work, JPEG, "a.jpg").unwrap();

        assert_eq!(stored.stored_path, format!("{}/{}.jpg", &stored.sha256[..2], stored.sha256));
        assert_eq!(std::fs::read(root.join(&stored.stored_path)).unwrap(), JPEG);
    }

    /* The declared type is a claim. These are the bytes. */
    #[test]
    fn what_is_not_a_photograph_is_refused_however_it_is_named() {
        let dir = scratch("sniff");
        let (root, work) = (dir.join("root"), dir.join("work"));

        assert!(store_bytes(&root, &work, b"MZ\x90\x00 this is a windows binary", "holiday.jpg").is_err());
        assert!(store_bytes(&root, &work, b"<html><body>hello", "invoice.pdf").is_err());
        assert!(store_bytes(&root, &work, b"", "empty.jpg").is_err());
    }

    #[test]
    fn each_accepted_kind_keeps_its_own_extension() {
        let dir = scratch("kinds");
        let (root, work) = (dir.join("root"), dir.join("work"));

        let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        let pdf = b"%PDF-1.4 something";
        let webp = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

        assert!(store_bytes(&root, &work, png, "x").unwrap().stored_path.ends_with(".png"));
        assert!(store_bytes(&root, &work, pdf, "x").unwrap().stored_path.ends_with(".pdf"));
        assert!(store_bytes(&root, &work, webp, "x").unwrap().stored_path.ends_with(".webp"));
    }

    #[test]
    fn a_name_from_the_webview_never_becomes_a_path() {
        let dir = scratch("names");
        let (root, work) = (dir.join("root"), dir.join("work"));

        let stored = store_bytes(&root, &work, JPEG, r"..\..\windows\system32\evil.jpg").unwrap();
        assert_eq!(stored.file_name, "evil.jpg");
        // Whatever it was called, it went where its hash says.
        assert!(stored.stored_path.starts_with(&stored.sha256[..2]));
    }

    #[test]
    fn an_over_large_file_is_refused_before_it_is_written() {
        let dir = scratch("size");
        let (root, work) = (dir.join("root"), dir.join("work"));

        let mut big = JPEG.to_vec();
        big.resize(MAX_BYTES + 1, 0);
        assert!(store_bytes(&root, &work, &big, "huge.jpg").is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
}
