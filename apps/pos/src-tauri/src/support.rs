//! Reaching the vendor: the number to ring, a WhatsApp chat that already says
//! which shop is asking, and the remote-help program when somebody has to look.
//!
//! The number is baked in at build, like the vendor's bot (`build.rs`), so a
//! shop types nothing. A build without one says so and names the file, rather
//! than showing a blank where the number should be.
//!
//! **The webview never chooses what is opened.** It hands over the words for
//! the message; the address is built here from the baked number, and the only
//! programs started are the two remote-help programs at the places they install
//! themselves. A command that opened whatever URL it was given would be a way
//! out of the CSP for anything that ever ran in the webview.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

const BUILT_PHONE: Option<&str> = option_env!("SHOPOS_SUPPORT_PHONE");
const BUILT_WHATSAPP: Option<&str> = option_env!("SHOPOS_SUPPORT_WHATSAPP");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportContact {
    /// As it should be read and dialled, e.g. `+91 98765 43210`. None when this build has none.
    phone: Option<String>,
    /// Whether a WhatsApp number is baked in; the number itself is the phone's unless set apart.
    whatsapp: bool,
}

#[tauri::command]
pub fn support_contact() -> SupportContact {
    SupportContact {
        phone: baked(BUILT_PHONE),
        whatsapp: whatsapp_number().is_some(),
    }
}

/// Opens a WhatsApp chat with the vendor, the message already typed.
///
/// Through the machine's own browser, which hands `wa.me` to the WhatsApp app
/// when it is installed and opens WhatsApp Web when it is not.
#[tauri::command]
pub fn support_whatsapp(text: String) -> Result<(), String> {
    let number = whatsapp_number().ok_or_else(|| {
        "This build has no support number. Set SHOPOS_SUPPORT_WHATSAPP in apps/pos/src-tauri/.env and build again.".to_string()
    })?;
    open_in_browser(&wa_link(&number, &text))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum RemoteHelp {
    Started { program: &'static str },
    NotInstalled,
}

/// Starts RustDesk or AnyDesk, whichever is here, RustDesk first.
#[tauri::command]
pub fn start_remote_help() -> Result<RemoteHelp, String> {
    for (program, path) in remote_programs() {
        if path.is_file() {
            return Command::new(&path)
                .spawn()
                .map(|_| RemoteHelp::Started { program })
                .map_err(|e| format!("{program} would not start: {e}"));
        }
    }
    Ok(RemoteHelp::NotInstalled)
}

fn baked(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Digits only, as `wa.me` wants them: country code first, no `+`, no spaces.
fn whatsapp_number() -> Option<String> {
    let raw = baked(BUILT_WHATSAPP).or_else(|| baked(BUILT_PHONE))?;
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    (digits.len() >= 10).then_some(digits)
}

fn wa_link(number: &str, text: &str) -> String {
    format!("https://wa.me/{number}?text={}", encode(text))
}

/// Percent-encoding for a query value: everything but the unreserved set.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        // `explorer` with a URL hands it to the default browser, and says
        // nothing back either way -- so its exit code is not read.
        let mut c = Command::new("explorer.exe");
        c.arg(url);
        c
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    command.spawn().map(|_| ()).map_err(|e| format!("The browser would not open: {e}"))
}

/// Where the two programs put themselves, in the order they are tried.
fn remote_programs() -> Vec<(&'static str, PathBuf)> {
    let mut found = Vec::new();
    #[cfg(windows)]
    {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        for base in [env("ProgramFiles"), env("ProgramFiles(x86)")].into_iter().flatten() {
            found.push(("RustDesk", base.join("RustDesk").join("rustdesk.exe")));
        }
        for base in [env("ProgramFiles(x86)"), env("ProgramFiles")].into_iter().flatten() {
            found.push(("AnyDesk", base.join("AnyDesk").join("AnyDesk.exe")));
        }
        // AnyDesk is most often run straight from the download, never installed.
        if let Some(home) = env("USERPROFILE") {
            found.push(("AnyDesk", home.join("Downloads").join("AnyDesk.exe")));
            found.push(("AnyDesk", home.join("Desktop").join("AnyDesk.exe")));
        }
    }
    #[cfg(not(windows))]
    {
        found.push(("RustDesk", PathBuf::from("/usr/bin/rustdesk")));
        found.push(("AnyDesk", PathBuf::from("/usr/bin/anydesk")));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_survives_the_trip_into_the_address() {
        let link = wa_link("919876543210", "Shop 0192f4a1 · FC · 0.3.0\nBills not crossing & stuck?");
        assert_eq!(
            link,
            "https://wa.me/919876543210?text=Shop%200192f4a1%20%C2%B7%20FC%20%C2%B7%200.3.0%0ABills%20not%20crossing%20%26%20stuck%3F",
        );
    }

    #[test]
    fn nothing_in_the_message_can_add_to_the_address() {
        let link = wa_link("919876543210", "x&phone=1#y");
        assert!(link.ends_with("?text=x%26phone%3D1%23y"));
    }

    #[test]
    fn a_number_is_digits_only() {
        let digits: String = "+91 98765-43210".chars().filter(char::is_ascii_digit).collect();
        assert_eq!(digits, "919876543210");
    }
}
