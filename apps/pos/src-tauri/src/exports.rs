/// Writing a report out to a file the shopkeeper can hand to their CA.
///
/// The webview cannot save a file itself, and a download prompt would be the
/// wrong shape anyway — reports go to one known folder so they accumulate where
/// the shop can find them again.
use std::path::PathBuf;

use tauri::Manager;

/// Excel reads a CSV as the system codepage unless a byte-order mark says
/// otherwise, which turns ₹ and every Tamil name into mojibake.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Names Windows keeps for devices, whatever extension follows them. A file
/// called `CON.csv` cannot be created, and `NUL.pdf` is written into nothing
/// and reported as saved.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A file name from the webview, checked as a name and never taken as a path.
///
/// The extension is an allow-list of the three this module writes. Anything
/// else -- `.bat`, `.lnk`, `.exe` in a Documents folder the shopkeeper opens
/// by double-clicking -- is not a report. Windows drops a trailing dot without
/// saying so, so `report.csv.` would be written as `report.csv` and the name
/// on the screen would not be the name on the disk; that is refused, as are
/// control characters and the reserved device names. Surrounding spaces are
/// trimmed, as they always were, and the path handed back is the real one.
fn safe_name(name: &str, allowed: &[&str]) -> Result<String, String> {
    let trimmed = name.trim();
    let refuse = || Err(format!("\"{name}\" is not a usable file name"));

    if trimmed.is_empty()
        || trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || trimmed.chars().any(char::is_control)
        || trimmed.starts_with('.')
        || trimmed.ends_with('.')
    {
        return refuse();
    }
    let Some((stem, ext)) = trimmed.rsplit_once('.') else { return refuse() };
    if !allowed.iter().any(|a| ext.eq_ignore_ascii_case(a)) {
        return refuse();
    }
    let device = stem.split('.').next().unwrap_or(stem).trim_end();
    if RESERVED.iter().any(|r| device.eq_ignore_ascii_case(r)) {
        return refuse();
    }
    Ok(trimmed.to_string())
}

/// `Documents\ShopOS\exports`, and a folder of its own beneath that for a
/// shop started with `--shop`.
///
/// Two companies on one machine used to write their reports into the same
/// folder, where a GST summary for one sat beside the other's with the same
/// name and the later one quietly replaced the earlier. The original shop
/// keeps the folder it has always had, for the same reason `paths::data_dir`
/// does: somebody already knows where to look.
pub(crate) fn exports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Could not find a folder to save into: {e}"))?;

    let mut dir = base.join("ShopOS").join("exports");
    if let Some(shop) = crate::paths::shop_slug()? {
        dir = dir.join(shop);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn write(app: &tauri::AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    write_or_beside(&exports_dir(app)?.join(name), bytes)
}

fn write_or_beside(first: &std::path::Path, bytes: &[u8]) -> Result<String, String> {
    let first = first.to_path_buf();
    let mut tried = crate::files::write_durably(&first, bytes).map(|()| first.clone());
    /* Today's export, still open in Excel from an hour ago. Excel locks the
       file it has open, so writing over it fails with "access denied" -- and
       the shopkeeper did nothing wrong. The new copy goes beside it instead,
       as `name (2).csv`, and the path handed back says where. */
    let mut n = 2;
    while tried.is_err() && first.exists() && n <= 20 {
        let next = beside(&first, n);
        if !next.exists() {
            tried = crate::files::write_durably(&next, bytes).map(|()| next);
        }
        n += 1;
    }
    tried.map(|path| path.to_string_lossy().to_string())
}

/// `catalogue.csv` as `catalogue (2).csv`: the name Windows itself gives a second copy.
fn beside(path: &std::path::Path, n: u32) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match path.extension() {
        Some(ext) => format!("{stem} ({n}).{}", ext.to_string_lossy()),
        None => format!("{stem} ({n})"),
    };
    path.with_file_name(name)
}

/// `async`, as is `export_pdf`: a year of bills is a large file, and writing
/// it was a frozen window.
#[tauri::command(async)]
pub fn export_file(app: tauri::AppHandle, filename: String, contents: String) -> Result<String, String> {
    // Text as well as CSV: the licence card saves the shop's id and its
    // licence code as `.txt` for the owner to send on.
    let name = safe_name(&filename, &["csv", "txt"])?;

    let mut bytes = Vec::with_capacity(contents.len() + BOM.len());
    if name.to_ascii_lowercase().ends_with(".csv") {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(contents.as_bytes());
    write(&app, &name, &bytes)
}

/// The same folder, but bytes rather than text, so a PDF lands beside the CSVs
/// a shop already knows where to find.
#[tauri::command(async)]
pub fn export_pdf(
    app: tauri::AppHandle,
    filename: String,
    doc: crate::pdf::PdfDoc,
) -> Result<String, String> {
    let name = safe_name(&filename, &["pdf"])?;
    write(&app, &name, &crate::pdf::render(&doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_report_name_is_kept_as_it_is() {
        assert_eq!(safe_name("GSTR-1 Sep 2026.csv", &["csv"]).unwrap(), "GSTR-1 Sep 2026.csv");
        assert_eq!(safe_name("  statement C0001.PDF ", &["pdf"]).unwrap(), "statement C0001.PDF");
    }

    #[test]
    fn a_name_that_is_not_a_report_is_refused() {
        for bad in [
            "",
            "..csv",
            ".hidden.csv",
            "../escape.csv",
            r"C:\Windows\x.csv",
            "report.csv.",
            "report.csv . ",
            "report",
            "run.bat",
            "report.csv.lnk",
            "report.exe",
            "CON.csv",
            "nul.csv",
            "com1.report.csv",
            "LPT9.csv",
            "line\nbreak.csv",
            "tab\there.csv",
        ] {
            assert!(safe_name(bad, &["csv"]).is_err(), "{bad:?} should be refused");
        }
        // The extension is per command: a CSV name is not a PDF name.
        assert!(safe_name("statement.csv", &["pdf"]).is_err());
        assert!(safe_name("shopos-licence.txt", &["csv", "txt"]).is_ok());
    }

    #[test]
    fn a_second_copy_is_named_the_way_windows_names_one() {
        let dir = std::path::Path::new("exports");
        assert_eq!(beside(&dir.join("catalogue-2026-10-24.csv"), 2), dir.join("catalogue-2026-10-24 (2).csv"));
        assert_eq!(beside(&dir.join("GSTR-1 Sep 2026.csv"), 3), dir.join("GSTR-1 Sep 2026 (3).csv"));
    }

    /// Excel opens a file without letting anyone delete or replace it, which is what makes a rename over it fail.
    #[cfg(windows)]
    #[test]
    fn a_report_open_in_excel_is_left_alone_and_the_new_one_saved_beside_it() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join("shopos-exports-tests");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("catalogue.csv");
        std::fs::write(&target, b"yesterday").unwrap();
        const FILE_SHARE_READ: u32 = 1;
        let excel = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&target).unwrap();

        let saved = write_or_beside(&target, b"today").unwrap();

        assert_eq!(saved, dir.join("catalogue (2).csv").to_string_lossy());
        assert_eq!(std::fs::read(dir.join("catalogue (2).csv")).unwrap(), b"today");
        drop(excel);
        assert_eq!(std::fs::read(&target).unwrap(), b"yesterday");
    }

    /// Only the whole first part is a device. `CONSOLE.csv` and `console-log.csv`
    /// are ordinary names.
    #[test]
    fn a_name_that_merely_starts_like_a_device_is_fine() {
        assert!(safe_name("CONSOLE.csv", &["csv"]).is_ok());
        assert!(safe_name("con-sales.csv", &["csv"]).is_ok());
    }
}
