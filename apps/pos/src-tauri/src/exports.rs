/// Writing a report out to a file the shopkeeper can hand to their CA.
///
/// The webview cannot save a file itself, and a download prompt would be the
/// wrong shape anyway — reports go to one known folder so they accumulate where
/// the shop can find them again.
use tauri::Manager;

/// Excel reads a CSV as the system codepage unless a byte-order mark says
/// otherwise, which turns ₹ and every Tamil name into mojibake.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn safe_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || trimmed.starts_with('.')
    {
        return Err(format!("\"{name}\" is not a usable file name"));
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn export_file(app: tauri::AppHandle, filename: String, contents: String) -> Result<String, String> {
    let name = safe_name(&filename)?;

    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Could not find a folder to save into: {e}"))?;

    let dir = base.join("ShopOS").join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let path = dir.join(&name);
    let mut bytes = Vec::with_capacity(contents.len() + BOM.len());
    if name.to_lowercase().ends_with(".csv") {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(contents.as_bytes());

    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}
