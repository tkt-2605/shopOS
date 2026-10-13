/// The vendor's Telegram bot, baked into the build so a shop pastes nothing.
///
/// Read from `src-tauri/.env` (git-ignored, see `.env.example` beside it) or
/// from the build's environment, which is how CI passes a secret. Never from a
/// file in git: the token is a key to the vendor's chat.
const BAKED: [&str; 2] = ["SHOPOS_TG_TOKEN", "SHOPOS_TG_CHAT"];

fn main() {
    let from_file = std::fs::read_to_string(".env").unwrap_or_default();
    for key in BAKED {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key).ok().filter(|v| !v.trim().is_empty()).or_else(|| {
            from_file.lines().find_map(|line| {
                let (k, v) = line.trim().split_once('=')?;
                // An editor may have saved it with a byte-order mark.
                (k.trim().trim_start_matches('\u{feff}') == key).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
            })
        });
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
    if std::path::Path::new(".env").exists() {
        println!("cargo:rerun-if-changed=.env");
    }
    tauri_build::build()
}
