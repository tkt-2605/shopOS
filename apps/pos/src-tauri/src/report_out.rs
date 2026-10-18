/// Sending a shop's reports out of the building, with no server of ours in
/// between: into a zip on this machine, into the folder backups already go to
/// (a Google Drive or OneDrive folder is the usual one), by email, and to a
/// Telegram chat.
///
/// The webview builds the files and hands them over; everything about *where*
/// they go is read here, from this machine's own settings, and never from the
/// request. A script in the webview can therefore choose what a report says
/// but not who receives it, which is the same rule `backup.rs` keeps for the
/// folder and the hook.
///
/// ## Email, without a mail library
///
/// The app has no TLS stack and cannot add one, so the message is handed to
/// Windows' own .NET `SmtpClient` through PowerShell. The password travels in
/// an environment variable of that one child process, never on its command
/// line, where any program on the machine could read it.
///
/// Telegram goes the same way, through .NET's `HttpClient`, with the bot token
/// in an environment variable and scrubbed from any error before it is shown.
///
/// ## What the shop sets up, and what comes with the build
///
/// The shop gives one thing: its mail login (Shop details), which sends the
/// reports to the shop's own address and the bills to the customers ticked
/// for them. Everything else comes with the build, from `.env` through
/// `build.rs`, so a new value reaches the shops in an update and nobody types
/// a token: the vendor's bot and chat, which take every report and the health
/// report (decided 19 Oct: the vendor receives the shops' reports), the mail
/// server for shops not on Gmail, and any address every pack is copied to.
///
/// ## Why there is an outbox
///
/// The shop's line is poor. A message is written to `outbox/` first and
/// removed only once the server has accepted it, so a report asked for during
/// an outage is sent when the line comes back rather than lost. Reports go
/// stale, so the queue keeps only the newest few.
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{backup, device, exports, files, paths};

const OUTBOX: &str = "outbox";
/// An older report is superseded by a newer one; a month of daily ones is plenty.
const KEEP_QUEUED: usize = 30;
const MAX_PACK_BYTES: usize = 20 * 1024 * 1024;
const SEND_DEADLINE: Duration = Duration::from_secs(120);

/// Device settings, on this machine only. Must match `core/reportOut.ts`.
const USER: &str = "mail_user";
const PASSWORD: &str = "mail_password";
/// The vendor's bot and chat, baked in by `build.rs` from a git-ignored `.env`.
const BUILT_TOKEN: Option<&str> = option_env!("SHOPOS_TG_TOKEN");
const BUILT_CHAT: Option<&str> = option_env!("SHOPOS_TG_CHAT");
/// The mail server, when the shops are not on Gmail. Baked in the same way.
const BUILT_MAIL_HOST: Option<&str> = option_env!("SHOPOS_MAIL_HOST");
const BUILT_MAIL_PORT: Option<&str> = option_env!("SHOPOS_MAIL_PORT");
/// Addresses every report pack is also copied to, besides the shop's own.
const BUILT_REPORTS_TO: Option<&str> = option_env!("SHOPOS_REPORTS_TO");
/// For a test against a stand-in server. Anything but https or this machine is refused.
const TG_API: &str = "tg_api";

/// One mail attempt at a time, and one flush at a time.
static SENDING: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
pub struct PackFile {
    name: String,
    contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    /// The zip kept on this machine.
    zip: String,
    /// Where the copy in the chosen folder landed, if a folder is chosen.
    folder: Option<String>,
    folder_error: Option<String>,
    /// `off` (no mail settings), `sent`, or `queued` (will retry).
    mail: &'static str,
    mail_error: Option<String>,
    /// The same three words for Telegram.
    telegram: &'static str,
    telegram_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxState {
    waiting: usize,
    sent: usize,
    error: Option<String>,
    /// Why each channel is stuck, by channel: `mail`, `telegram`, `invoice`.
    errors: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct Queued {
    /// `mail` or `telegram`. Absent in anything queued before Telegram existed.
    #[serde(default = "mail_channel")]
    channel: String,
    #[serde(default)]
    to: Vec<String>,
    subject: String,
    body: String,
    /// The zip's name as the recipient will see it.
    attach_name: String,
    // Anything queued by 0.3.1 or before also carries `vendor`, which is now
    // ignored: every Telegram message goes by the vendor's bot.
}

fn mail_channel() -> String {
    "mail".into()
}

/// A name that is safe on disk and in a mail: letters, digits, space and a few
/// marks, no separators, not starting or ending with a dot.
fn clean(name: &str, ext: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 120
        && !trimmed.starts_with('.')
        && !trimmed.ends_with('.')
        && trimmed
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | '(' | ')'));
    let Some((stem, got)) = trimmed.rsplit_once('.') else {
        return Err(format!("\"{name}\" is not a usable file name"));
    };
    if !ok || !got.eq_ignore_ascii_case(ext) || stem.is_empty() {
        return Err(format!("\"{name}\" is not a usable file name"));
    }
    Ok(trimmed.to_string())
}

/// Addresses from the setting: separated by commas, semicolons or lines, each
/// one plain `name@host` with nothing that could add a second recipient or a
/// header.
pub(crate) fn recipients(raw: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for part in raw.split([',', ';', '\n', '\r']) {
        let a = part.trim();
        if a.is_empty() {
            continue;
        }
        let bad = a.len() > 254
            || a.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '(' | ')'))
            || a.matches('@').count() != 1
            || a.starts_with('@')
            || a.ends_with('@')
            || !a.rsplit('@').next().unwrap_or("").contains('.');
        if bad {
            return Err(format!("\"{a}\" is not an email address"));
        }
        out.push(a.to_string());
    }
    Ok(out)
}

fn zip_of(files: &[PackFile]) -> Result<Vec<u8>, String> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut seen = std::collections::BTreeSet::new();
    for file in files {
        let name = clean(&file.name, "csv").or_else(|_| clean(&file.name, "txt"))?;
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("Two files are called \"{name}\""));
        }
        writer.start_file(name, options).map_err(|e| format!("Could not build the zip: {e}"))?;
        // Excel reads a CSV as the system codepage unless a byte-order mark says otherwise.
        if file.name.to_ascii_lowercase().ends_with(".csv") {
            writer.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
        }
        writer.write_all(file.contents.as_bytes()).map_err(|e| format!("Could not build the zip: {e}"))?;
    }
    let bytes = writer.finish().map_err(|e| format!("Could not build the zip: {e}"))?.into_inner();
    if bytes.len() > MAX_PACK_BYTES {
        return Err("The reports are too large to send in one message.".into());
    }
    Ok(bytes)
}

fn outbox_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = paths::data_dir(app)?.join(OUTBOX);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub(crate) struct Mail {
    to: Vec<String>,
    user: String,
    password: String,
    host: String,
    port: u16,
}

/// Where the report pack goes: the shop's own address, the one it sends from,
/// and whatever the build copies every pack to. `None` with no mail login.
fn mail_settings(app: &tauri::AppHandle) -> Result<Option<Mail>, String> {
    let Some(mut mail) = sender_settings(app)? else {
        return Ok(None);
    };
    let mut to = vec![mail.user.clone()];
    for extra in recipients(BUILT_REPORTS_TO.unwrap_or(""))? {
        if !to.iter().any(|t| t.eq_ignore_ascii_case(&extra)) {
            to.push(extra);
        }
    }
    mail.to = to;
    Ok(Some(mail))
}

/// The shop's mail login without the report pack's recipients: what a bill
/// emailed to a customer is sent with (`invoice_mail.rs`). `None` when this
/// machine has no login. The customer's address travels with each message.
pub(crate) fn sender_settings(app: &tauri::AppHandle) -> Result<Option<Mail>, String> {
    let data = paths::data_dir(app)?;
    let (Some(user), Some(password)) = (device::setting(&data, USER)?, device::setting(&data, PASSWORD)?) else {
        return Ok(None);
    };
    if user.trim().is_empty() || password.trim().is_empty() {
        return Ok(None);
    }
    let user = user.trim().to_string();
    if recipients(&user)?.len() != 1 {
        return Err("The shop's email should be one address.".into());
    }
    let (host, port) = mail_server(BUILT_MAIL_HOST, BUILT_MAIL_PORT)?;
    // Gmail shows app passwords in groups of four with spaces.
    let password: String = password.chars().filter(|c| !c.is_whitespace()).collect();
    Ok(Some(Mail { to: Vec::new(), user, password, host, port }))
}

/// The server the build names, or Gmail's.
fn mail_server(host: Option<&str>, port: Option<&str>) -> Result<(String, u16), String> {
    let host = host.map(str::trim).filter(|h| !h.is_empty()).unwrap_or("smtp.gmail.com");
    if host.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err(format!("\"{host}\" is not a mail server name"));
    }
    let port = match port.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => p.parse::<u16>().map_err(|_| format!("\"{p}\" is not a port number"))?,
        None => 587,
    };
    Ok((host.to_string(), port))
}

struct Telegram {
    token: String,
    chat: String,
    api: String,
}

/// `123456:ABC-def_...`: digits, a colon, then letters, digits, `-` and `_`.
fn token_shape(token: &str) -> bool {
    token.split_once(':').is_some_and(|(id, secret)| {
        !id.is_empty()
            && id.chars().all(|c| c.is_ascii_digit())
            && !secret.is_empty()
            && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// The vendor's bot and chat baked into this build, or `None`. It carries
/// every Telegram message: the report packs and the health report.
fn telegram_settings(app: &tauri::AppHandle) -> Result<Option<Telegram>, String> {
    if !report_telegram_builtin() {
        return Ok(None);
    }
    let data = paths::data_dir(app)?;
    telegram_of(&data, BUILT_TOKEN.map(str::to_string), BUILT_CHAT.map(str::to_string))
}

fn telegram_of(data: &Path, token: Option<String>, chat: Option<String>) -> Result<Option<Telegram>, String> {
    let (Some(token), Some(chat)) = (token, chat) else {
        return Ok(None);
    };
    let token: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    let shape = token_shape(&token);
    if !shape {
        return Err("The Telegram bot token this copy was built with does not look right.".into());
    }
    let chat = chat.trim().to_string();
    let chat_ok = !chat.is_empty()
        && chat.len() <= 40
        && chat.chars().enumerate().all(|(i, c)| c.is_ascii_digit() || (i == 0 && c == '-') || (i == 0 && c == '@') || (c.is_ascii_alphanumeric() || c == '_'));
    if !chat_ok {
        return Err("The Telegram chat id this copy was built with should be a number like 123456789, or -100… for a group.".into());
    }
    let api = telegram_api(data)?;
    Ok(Some(Telegram { token, chat, api }))
}

/// Telegram's address: https, unless a test has pointed it at this machine.
fn telegram_api(data: &Path) -> Result<String, String> {
    let api = device::setting(data, TG_API)?.unwrap_or_else(|| "https://api.telegram.org".into());
    let api = api.trim_end_matches('/').to_string();
    let local = api.starts_with("http://127.0.0.1") || api.starts_with("http://localhost");
    if !(api.starts_with("https://") || local) || api.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The Telegram address must be https.".into());
    }
    Ok(api)
}

/// What is set up on this machine, read once per call.
struct Settings {
    /// The shop's login, to the shop's own address and the build's copies.
    mail: Option<Mail>,
    /// The vendor's baked-in bot.
    telegram: Option<Telegram>,
    /// The shop's mail login alone, for bills emailed to customers.
    sender: Option<Mail>,
}

impl Settings {
    /// Everything set up on this machine. A setting that is wrong is read as
    /// not set up, and its channel waits.
    fn all(app: &tauri::AppHandle) -> Self {
        Settings {
            mail: mail_settings(app).unwrap_or(None),
            telegram: telegram_settings(app).unwrap_or(None),
            sender: sender_settings(app).unwrap_or(None),
        }
    }
}

pub(crate) fn stamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{now:016}")
}

/// Builds the zip, keeps it here, copies it to the chosen folder, and queues
/// it for email. Each destination reports for itself: a Drive folder that is
/// not mounted must not stop the mail, nor the mail the local copy.
#[tauri::command(async)]
pub fn report_deliver(
    app: tauri::AppHandle,
    pack_name: String,
    files: Vec<PackFile>,
    subject: String,
    body: String,
) -> Result<Delivery, String> {
    let name = clean(&pack_name, "zip")?;
    if files.is_empty() {
        return Err("There is nothing to send.".into());
    }
    let subject: String = subject.chars().filter(|c| !c.is_control()).take(200).collect();
    let bytes = zip_of(&files)?;

    let local = exports::exports_dir(&app)?.join("reports");
    std::fs::create_dir_all(&local).map_err(|e| format!("Could not create {}: {e}", local.display()))?;
    let zip = local.join(&name);
    files::write_durably(&zip, &bytes)?;

    let (folder, folder_error) = match backup::chosen_folder(&app) {
        Ok(chosen) => {
            let dir = chosen.join("reports");
            match std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))
                .and_then(|()| files::write_durably(&dir.join(&name), &bytes).map(|()| dir.join(&name)))
            {
                Ok(path) => (Some(path.to_string_lossy().to_string()), None),
                Err(e) => (None, Some(e)),
            }
        }
        // No folder chosen is not a failure; a chosen one that is missing is.
        Err(e) if e.starts_with("No folder") => (None, None),
        Err(e) => (None, Some(e)),
    };

    let sent = send_out(&app, &name, &bytes, &subject, &body)?;
    Ok(Delivery {
        zip: zip.to_string_lossy().to_string(),
        folder,
        folder_error,
        mail: sent.mail,
        mail_error: sent.mail_error,
        telegram: sent.telegram,
        telegram_error: sent.telegram_error,
    })
}

/// How one file fared on each channel.
pub(crate) struct Sent {
    pub mail: &'static str,
    pub mail_error: Option<String>,
    pub telegram: &'static str,
    pub telegram_error: Option<String>,
}

/// Telegram refuses a bot's file above 50 MB.
const TELEGRAM_MAX_BYTES: usize = 49 * 1024 * 1024;

/// Queues one zip for every channel set up on this machine and tries them.
/// Shared by the report pack and the health report; who receives it is read
/// here, never passed in.
pub(crate) fn send_out(
    app: &tauri::AppHandle,
    name: &str,
    bytes: &[u8],
    subject: &str,
    body: &str,
) -> Result<Sent, String> {
    let name = clean(name, "zip")?;
    let subject: String = subject.chars().filter(|c| !c.is_control()).take(200).collect();
    let body = body.to_string();
    let app = app.clone();
    let outbox = outbox_dir(&app)?;
    let stem = stamp();
    let caption: String = format!("{subject}\n\n{body}").chars().take(1000).collect();

    // Each channel is queued on its own, so a dead mail server never holds up
    // Telegram and a wrong bot token never holds up the mail.
    let queue = |channel: &str, to: Vec<String>| -> Result<String, String> {
        let id = format!("{stem}-{channel}");
        let queued = Queued {
            channel: channel.into(),
            to,
            subject: subject.clone(),
            body: if channel == "telegram" { caption.clone() } else { body.clone() },
            attach_name: name.clone(),
        };
        let meta = serde_json::to_vec(&queued).map_err(|e| e.to_string())?;
        files::write_durably(&outbox.join(format!("{id}.zip")), &bytes)?;
        files::write_durably(&outbox.join(format!("{id}.json")), &meta)?;
        Ok(id)
    };

    let mut settings = Settings { mail: None, telegram: None, sender: None };
    let (mut mail, mut mail_error) = ("off", None);
    let (mut telegram, mut telegram_error) = ("off", None);
    let (mut mail_id, mut telegram_id) = (None, None);

    match mail_settings(&app) {
        Err(e) => mail_error = Some(e),
        Ok(None) => {}
        Ok(Some(m)) => {
            mail_id = Some(queue("mail", m.to.clone())?);
            settings.mail = Some(m);
        }
    }
    match telegram_settings(&app) {
        Err(e) => telegram_error = Some(e),
        Ok(None) => {}
        Ok(Some(_)) if bytes.len() > TELEGRAM_MAX_BYTES => {
            telegram_error = Some(format!(
                "{name} is {} MB, larger than Telegram takes from a bot (50 MB).",
                bytes.len() / (1024 * 1024)
            ));
        }
        Ok(Some(t)) => {
            telegram_id = Some(queue("telegram", Vec::new())?);
            settings.telegram = Some(t);
        }
    }
    trim_queue(&outbox);

    if mail_id.is_some() || telegram_id.is_some() {
        let state = flush(&outbox, &settings);
        let pending = |id: &Option<String>| id.as_ref().is_some_and(|i| outbox.join(format!("{i}.json")).exists());
        if mail_id.is_some() {
            mail = if pending(&mail_id) { "queued" } else { "sent" };
            if pending(&mail_id) {
                mail_error = state.errors.get("mail").cloned();
            }
        }
        if telegram_id.is_some() {
            telegram = if pending(&telegram_id) { "queued" } else { "sent" };
            if pending(&telegram_id) {
                telegram_error = state.errors.get("telegram").cloned();
            }
        }
    }

    Ok(Sent { mail, mail_error, telegram, telegram_error })
}

/// The outbox channel for a bill emailed to its customer. Never trimmed:
/// `trim_queue` drops stale report packs, and a customer's invoice is not stale.
pub(crate) const INVOICE: &str = "invoice";

/// Queues one bill's PDF for one customer, from the shop's mail login, and
/// tries it at once. `to` is checked to be a single plain address: the
/// customer's, which the webview read from the customer record.
pub(crate) fn queue_invoice(
    app: &tauri::AppHandle,
    to: &str,
    subject: &str,
    body: &str,
    attach_name: &str,
    pdf: &[u8],
) -> Result<(&'static str, Option<String>), String> {
    let to = recipients(to)?;
    if to.len() != 1 {
        return Err("A bill is emailed to one address.".into());
    }
    let attach_name = clean(attach_name, "pdf")?;
    let subject: String = subject.chars().filter(|c| !c.is_control()).take(200).collect();
    let outbox = outbox_dir(app)?;
    let id = format!("{}-{INVOICE}", stamp());
    let queued = Queued {
        channel: INVOICE.into(),
        to,
        subject,
        body: body.to_string(),
        attach_name,
    };
    // The attachment keeps the outbox's one file name; `with_named_copy` gives
    // it the bill's name for the send.
    files::write_durably(&outbox.join(format!("{id}.zip")), pdf)?;
    files::write_durably(&outbox.join(format!("{id}.json")), &serde_json::to_vec(&queued).map_err(|e| e.to_string())?)?;

    let state = flush(&outbox, &Settings::all(app));
    if outbox.join(format!("{id}.json")).exists() {
        Ok(("queued", state.errors.get(INVOICE).cloned()))
    } else {
        Ok(("sent", None))
    }
}

/// Tries whatever is waiting. Called on a timer, and again by the person.
#[tauri::command(async)]
pub fn report_outbox(app: tauri::AppHandle) -> Result<OutboxState, String> {
    let outbox = outbox_dir(&app)?;
    let state = flush(&outbox, &Settings::all(&app));
    // The portal's queue retries on the same beat (`portal_out.rs`).
    if let Some(e) = crate::portal_out::flush(&app) {
        crate::log::write("warn", "portal", &e);
    }
    Ok(OutboxState {
        waiting: state.waiting,
        sent: state.sent,
        error: state.errors.values().next().cloned(),
        errors: state.errors,
    })
}

/// One message waiting in the outbox, for Settings to list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    channel: String,
    subject: String,
    /// The addresses, for mail; empty for Telegram.
    to: Vec<String>,
    /// When it was queued, in milliseconds since 1970.
    at: u64,
}

/// What is waiting, oldest first, without trying to send any of it.
#[tauri::command(async)]
pub fn report_outbox_list(app: tauri::AppHandle) -> Result<Vec<Waiting>, String> {
    let outbox = outbox_dir(&app)?;
    Ok(listed(&outbox))
}

fn listed(outbox: &Path) -> Vec<Waiting> {
    waiting(outbox)
        .into_iter()
        .filter_map(|id| {
            let raw = std::fs::read(outbox.join(format!("{id}.json"))).ok()?;
            let q: Queued = serde_json::from_slice(&raw).ok()?;
            let at = id.split('-').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
            Some(Waiting { channel: q.channel, subject: q.subject, to: q.to, at })
        })
        .collect()
}

/// Where things go from this machine, for Settings to say in words.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destinations {
    /// The shop's login, when there is one.
    sender: Option<String>,
    /// Where a report pack is emailed: the shop's own address and the build's copies.
    reports_to: Vec<String>,
    /// Why mail cannot go, when the login or the build's settings are wrong.
    mail_error: Option<String>,
    /// Whether the vendor's bot is in this build.
    telegram: bool,
}

#[tauri::command(async)]
pub fn report_destinations(app: tauri::AppHandle) -> Destinations {
    let (sender, reports_to, mail_error) = match mail_settings(&app) {
        Ok(Some(m)) => (Some(m.user), m.to, None),
        Ok(None) => (None, Vec::new(), None),
        Err(e) => (None, Vec::new(), Some(e)),
    };
    Destinations { sender, reports_to, mail_error, telegram: report_telegram_builtin() }
}

/// Sends the shop's own address one short email from its own login, at once
/// and not through the outbox, so the person setting it up sees the server's
/// answer. Returns the address it went to.
#[tauri::command(async)]
pub fn report_mail_test(app: tauri::AppHandle) -> Result<String, String> {
    let mail = sender_settings(&app)?.ok_or("Enter the shop's email and its app password first.")?;
    let _only_one = SENDING.lock().unwrap_or_else(|e| e.into_inner());
    test_mail(&mail)?;
    Ok(mail.user)
}

#[cfg(windows)]
fn test_mail(mail: &Mail) -> Result<(), String> {
    run_powershell(
        MAIL_SCRIPT,
        &[
            ("SHOPOS_MAIL_HOST", mail.host.clone()),
            ("SHOPOS_MAIL_PORT", mail.port.to_string()),
            ("SHOPOS_MAIL_USER", mail.user.clone()),
            ("SHOPOS_MAIL_PASS", mail.password.clone()),
            ("SHOPOS_MAIL_TO", mail.user.clone()),
            ("SHOPOS_MAIL_SUBJECT", "ShopOS can send from this address".into()),
            ("SHOPOS_MAIL_BODY", "A test from ShopOS. Reports and bills will be sent from this address.".into()),
            ("SHOPOS_MAIL_ATTACH", String::new()),
        ],
        "The mail server did not accept the message.",
    )
    .map(|_| ())
}

#[cfg(not(windows))]
fn test_mail(_: &Mail) -> Result<(), String> {
    Err("Sending mail is only available on Windows.".into())
}

fn waiting(outbox: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(outbox)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json").map(str::to_string)))
        .collect();
    ids.sort();
    ids
}

/// An older report is superseded by a newer one, per channel.
fn trim_queue(outbox: &Path) {
    for channel in ["mail", "telegram"] {
        let ids: Vec<String> = waiting(outbox).into_iter().filter(|i| i.ends_with(&format!("-{channel}"))).collect();
        for id in ids.iter().take(ids.len().saturating_sub(KEEP_QUEUED)) {
            let _ = std::fs::remove_file(outbox.join(format!("{id}.json")));
            let _ = std::fs::remove_file(outbox.join(format!("{id}.zip")));
        }
    }
}

struct Flushed {
    waiting: usize,
    sent: usize,
    /// The first failure per channel.
    errors: std::collections::BTreeMap<String, String>,
}

/// Oldest first, each channel on its own. A channel stops at its first
/// failure: the line is down or the password is wrong, and the rest would fail
/// the same way. A channel nothing is set up for is left alone, waiting.
fn flush(outbox: &Path, settings: &Settings) -> Flushed {
    let _only_one = SENDING.lock().unwrap_or_else(|e| e.into_inner());
    let mut sent = 0;
    let mut errors = std::collections::BTreeMap::new();
    for id in waiting(outbox) {
        let attempt = std::fs::read(outbox.join(format!("{id}.json")))
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_slice::<Queued>(&raw).map_err(|e| e.to_string()));
        let queued = match attempt {
            Ok(q) => q,
            Err(e) => {
                errors.entry("mail".to_string()).or_insert(e);
                continue;
            }
        };
        if errors.contains_key(&queued.channel) {
            continue;
        }
        let result = match queued.channel.as_str() {
            "telegram" => match &settings.telegram {
                Some(t) => send_telegram(outbox, &id, &queued, t),
                None => continue,
            },
            INVOICE => match &settings.sender {
                Some(m) => send_mail(outbox, &id, &queued, m),
                None => continue,
            },
            _ => match &settings.mail {
                Some(m) => send_mail(outbox, &id, &queued, m),
                None => continue,
            },
        };
        match result {
            Ok(()) => {
                let _ = std::fs::remove_file(outbox.join(format!("{id}.json")));
                let _ = std::fs::remove_file(outbox.join(format!("{id}.zip")));
                sent += 1;
            }
            Err(e) => {
                let e = match &settings.telegram {
                    Some(t) => e.replace(&t.token, "..."),
                    None => e,
                };
                errors.insert(queued.channel.clone(), e);
            }
        }
    }
    Flushed { waiting: waiting(outbox).len(), sent, errors }
}

#[cfg(windows)]
const MAIL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $m = New-Object System.Net.Mail.MailMessage
  $m.From = New-Object System.Net.Mail.MailAddress($env:SHOPOS_MAIL_USER)
  foreach ($t in ($env:SHOPOS_MAIL_TO -split ',')) { if ($t.Trim()) { $m.To.Add($t.Trim()) } }
  $m.Subject = $env:SHOPOS_MAIL_SUBJECT
  $m.Body = $env:SHOPOS_MAIL_BODY
  $m.SubjectEncoding = [Text.Encoding]::UTF8
  $m.BodyEncoding = [Text.Encoding]::UTF8
  if ($env:SHOPOS_MAIL_ATTACH) { $m.Attachments.Add((New-Object System.Net.Mail.Attachment($env:SHOPOS_MAIL_ATTACH))) }
  $c = New-Object System.Net.Mail.SmtpClient($env:SHOPOS_MAIL_HOST, [int]$env:SHOPOS_MAIL_PORT)
  $c.EnableSsl = $true
  $c.Timeout = 90000
  $c.Credentials = New-Object System.Net.NetworkCredential($env:SHOPOS_MAIL_USER, $env:SHOPOS_MAIL_PASS)
  $c.Send($m)
  $m.Dispose()
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

/// `sendDocument` as a multipart form. Windows PowerShell 5.1 has no
/// `-Form`, so .NET's `HttpClient` is used directly.
#[cfg(windows)]
const TELEGRAM_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(100)
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $form.Add((New-Object System.Net.Http.StringContent($env:SHOPOS_TG_CHAT)), 'chat_id')
  $form.Add((New-Object System.Net.Http.StringContent($env:SHOPOS_TG_CAPTION, [Text.Encoding]::UTF8)), 'caption')
  $bytes = [IO.File]::ReadAllBytes($env:SHOPOS_TG_FILE)
  $file = New-Object System.Net.Http.ByteArrayContent(,$bytes)
  $file.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/zip')
  $form.Add($file, 'document', $env:SHOPOS_TG_NAME)
  $resp = $client.PostAsync($env:SHOPOS_TG_URL, $form).GetAwaiter().GetResult()
  $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) {
    $why = $text
    try { $why = (ConvertFrom-Json $text).description } catch {}
    throw ('Telegram said ' + [int]$resp.StatusCode + ': ' + $why)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
"#;

/// Runs one PowerShell script with these environment variables and waits for
/// it, killing it if the far end goes quiet. The variables carry every secret:
/// nothing sensitive is ever on the command line.
#[cfg(windows)]
pub(crate) fn run_powershell(script: &str, env: &[(&str, String)], quiet: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start PowerShell to send the report: {e}"))?;

    let started = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if status.success() {
                    // Small by construction: the scripts print one line of JSON, or nothing.
                    let mut out = String::new();
                    if let Some(mut pipe) = child.stdout.take() {
                        use std::io::Read;
                        let _ = pipe.read_to_string(&mut out);
                    }
                    return Ok(out.trim().to_string());
                }
                let mut text = String::new();
                if let Some(mut err) = child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_string(&mut text);
                }
                let text = text.trim();
                return Err(if text.is_empty() { quiet.to_string() } else { text.chars().take(300).collect() });
            }
            None if started.elapsed() > SEND_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The server did not answer in time.".into());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Whether this build carries the vendor's bot, so Settings can say where the
/// reports go. Says yes or no and never the token itself.
#[tauri::command]
pub fn report_telegram_builtin() -> bool {
    BUILT_TOKEN.is_some_and(token_shape) && BUILT_CHAT.is_some_and(|c| !c.trim().is_empty())
}

/// Whether the health report goes out daily from this build whatever the shop
/// has set up: it does when the build carries the vendor's bot or the
/// vendor's portal. It names no customer, so it needs nobody's say-so.
#[tauri::command]
pub fn report_health_daily() -> bool {
    report_telegram_builtin() || crate::portal_out::built_in()
}

/// The attachment is shown to the recipient under its file name, so it is
/// copied to that name inside a folder of its own for the one send.
fn with_named_copy(
    outbox: &Path,
    id: &str,
    queued: &Queued,
    send: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let scratch = outbox.join(format!("send-{id}"));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let attach = scratch.join(&queued.attach_name);
    let result = std::fs::copy(outbox.join(format!("{id}.zip")), &attach)
        .map_err(|e| e.to_string())
        .and_then(|_| send(&attach));
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

#[cfg(windows)]
fn send_mail(outbox: &Path, id: &str, queued: &Queued, settings: &Mail) -> Result<(), String> {
    with_named_copy(outbox, id, queued, |attach| {
        run_powershell(
            MAIL_SCRIPT,
            &[
                ("SHOPOS_MAIL_HOST", settings.host.clone()),
                ("SHOPOS_MAIL_PORT", settings.port.to_string()),
                ("SHOPOS_MAIL_USER", settings.user.clone()),
                ("SHOPOS_MAIL_PASS", settings.password.clone()),
                ("SHOPOS_MAIL_TO", queued.to.join(",")),
                ("SHOPOS_MAIL_SUBJECT", queued.subject.clone()),
                ("SHOPOS_MAIL_BODY", queued.body.clone()),
                ("SHOPOS_MAIL_ATTACH", attach.to_string_lossy().to_string()),
            ],
            "The mail server did not accept the message.",
        )
        .map(|_| ())
    })
}

#[cfg(windows)]
fn send_telegram(outbox: &Path, id: &str, queued: &Queued, settings: &Telegram) -> Result<(), String> {
    with_named_copy(outbox, id, queued, |attach| {
        run_powershell(
            TELEGRAM_SCRIPT,
            &[
                ("SHOPOS_TG_URL", format!("{}/bot{}/sendDocument", settings.api, settings.token)),
                ("SHOPOS_TG_CHAT", settings.chat.clone()),
                ("SHOPOS_TG_CAPTION", queued.body.clone()),
                ("SHOPOS_TG_FILE", attach.to_string_lossy().to_string()),
                ("SHOPOS_TG_NAME", queued.attach_name.clone()),
            ],
            "Telegram did not accept the file.",
        )
        .map(|_| ())
    })
}

#[cfg(not(windows))]
fn send_mail(_: &Path, _: &str, _: &Queued, _: &Mail) -> Result<(), String> {
    Err("Sending mail is only available on Windows.".into())
}

#[cfg(not(windows))]
fn send_telegram(_: &Path, _: &str, _: &Queued, _: &Telegram) -> Result<(), String> {
    Err("Sending to Telegram is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_raw(outbox: &Path, id: &str, channel: &str) {
        let queued = Queued {
            channel: channel.into(), to: vec!["ravi@example.com".into()], subject: "s".into(),
            body: "b".into(), attach_name: "BMR-1.pdf".into(),
        };
        std::fs::write(outbox.join(format!("{id}.zip")), b"%PDF-1.4").unwrap();
        std::fs::write(outbox.join(format!("{id}.json")), serde_json::to_vec(&queued).unwrap()).unwrap();
    }

    /// A customer's invoice is not a stale report: however many wait, none is dropped.
    #[test]
    fn invoices_are_never_trimmed_away() {
        let outbox = std::env::temp_dir().join(format!("shopos-outbox-trim-{}", stamp()));
        std::fs::create_dir_all(&outbox).unwrap();
        for i in 0..KEEP_QUEUED + 5 {
            queue_raw(&outbox, &format!("{i:016}-{INVOICE}"), INVOICE);
        }
        trim_queue(&outbox);
        assert_eq!(waiting(&outbox).len(), KEEP_QUEUED + 5);
        let _ = std::fs::remove_dir_all(&outbox);
    }

    /// With no mail login an invoice waits in the outbox rather than failing or vanishing.
    #[test]
    fn an_invoice_waits_for_a_mail_login() {
        let outbox = std::env::temp_dir().join(format!("shopos-outbox-wait-{}", stamp()));
        std::fs::create_dir_all(&outbox).unwrap();
        queue_raw(&outbox, &format!("{}-{INVOICE}", stamp()), INVOICE);
        let none = Settings { mail: None, telegram: None, sender: None };
        let state = flush(&outbox, &none);
        assert_eq!((state.waiting, state.sent), (1, 0));
        assert!(state.errors.is_empty(), "nothing set up is not a failure");
        let _ = std::fs::remove_dir_all(&outbox);
    }

    #[test]
    fn addresses_are_plain_and_only_plain() {
        assert_eq!(recipients("a@b.com; c@d.in,\n e@f.org").unwrap(), vec!["a@b.com", "c@d.in", "e@f.org"]);
        assert!(recipients("a@b.com, bad").is_err());
        assert!(recipients("Name <a@b.com>").is_err());
        assert!(recipients("a@b.com\r\nBcc: x@y.com").is_err());
        assert!(recipients("a@@b.com").is_err());
        assert!(recipients("a@localhost").is_err());
        assert!(recipients("").unwrap().is_empty());
    }

    #[test]
    fn file_names_cannot_leave_the_folder() {
        assert!(clean("Shop (ab12cd34) 2026-10-11.zip", "zip").is_ok());
        for bad in ["../x.zip", r"C:\x.zip", "x.exe", ".zip", "x.zip.", "a/b.zip", "", "x"] {
            assert!(clean(bad, "zip").is_err(), "{bad}");
        }
    }

    #[test]
    fn a_pack_is_one_zip_of_the_files_given() {
        let bytes = zip_of(&[
            PackFile { name: "days.csv".into(), contents: "a,b\n1,2\n".into() },
            PackFile { name: "tax.csv".into(), contents: "x\n".into() },
        ])
        .unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("days.csv").unwrap(), &mut text).unwrap();
        assert!(text.starts_with('\u{feff}'), "a CSV carries the byte-order mark");
        assert!(zip_of(&[
            PackFile { name: "a.csv".into(), contents: String::new() },
            PackFile { name: "A.csv".into(), contents: String::new() },
        ])
        .is_err());
    }

    /// A stand-in for Telegram on this machine: answers one request with the
    /// given status and hands back what it was sent.
    #[cfg(windows)]
    fn fake_telegram(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 8192];
            // Until the closing boundary of the form has arrived.
            while !String::from_utf8_lossy(&seen).trim_end().ends_with("--") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => seen.extend_from_slice(&buf[..n]),
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).to_string()
        });
        (api, handle)
    }

    #[cfg(windows)]
    fn sandbox(tag: &str) -> (PathBuf, Queued) {
        let dir = std::env::temp_dir().join(format!("shopos-report-out-{tag}-{}", stamp()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("one.zip"), b"PK-not-really-a-zip").unwrap();
        let queued = Queued {
            channel: "telegram".into(),
            to: Vec::new(),
            subject: "s".into(),
            body: "Shop: Test \u{20b9}".into(),
            attach_name: "Test (ab12cd34) 2026-10-11.zip".into(),
        };
        (dir, queued)
    }

    #[cfg(windows)]
    #[test]
    fn a_report_reaches_telegram_as_a_document_with_its_caption() {
        let (dir, queued) = sandbox("ok");
        let (api, server) = fake_telegram("200 OK", r#"{"ok":true}"#);
        let settings = Telegram { token: "123456:ABC-def_ghi".into(), chat: "-1001".into(), api };

        send_telegram(&dir, "one", &queued, &settings).unwrap();

        let seen = server.join().unwrap();
        assert!(seen.starts_with("POST /bot123456:ABC-def_ghi/sendDocument "), "{seen}");
        assert!(seen.contains("name=chat_id") && seen.contains("-1001"));
        assert!(seen.contains("name=caption") && seen.contains("Shop: Test"));
        assert!(seen.contains("filename=\"Test (ab12cd34) 2026-10-11.zip\"") || seen.contains("filename=Test (ab12cd34) 2026-10-11.zip"));
        assert!(!dir.join("send-one").exists(), "the scratch copy is removed");
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn telegram_refusing_is_reported_in_its_own_words_without_the_token() {
        let (dir, queued) = sandbox("refused");
        let (api, server) = fake_telegram(
            "401 Unauthorized",
            r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
        );
        let settings = Telegram { token: "123456:ABC-def_ghi".into(), chat: "1".into(), api };

        let failure = send_telegram(&dir, "one", &queued, &settings).unwrap_err();
        server.join().unwrap();

        assert!(failure.contains("401") && failure.contains("Unauthorized"), "{failure}");
        assert!(!failure.contains("ABC-def_ghi"));
        std::fs::remove_dir_all(dir).ok();
    }

    /// A build made with a `.env` carries a usable bot; one made without carries none.
    #[test]
    fn a_baked_in_bot_is_whole_or_absent() {
        match (BUILT_TOKEN, BUILT_CHAT) {
            (None, None) => assert!(!report_telegram_builtin()),
            (Some(_), Some(_)) => assert!(report_telegram_builtin(), "the baked-in token or chat is malformed"),
            _ => panic!("only one of SHOPOS_TG_TOKEN and SHOPOS_TG_CHAT was baked in"),
        }
    }

    /// A pack queued by 0.3.1 or before, marked for the shop's own bot, still
    /// reads, and goes by the vendor's now.
    #[test]
    fn a_message_queued_before_carries_on() {
        let queued_before: Queued = serde_json::from_str(
            r#"{"channel":"telegram","subject":"s","body":"b","attach_name":"a.zip","vendor":false}"#,
        )
        .unwrap();
        assert_eq!(queued_before.channel, "telegram");
    }

    #[test]
    fn the_mail_server_is_gmail_unless_the_build_names_one() {
        assert_eq!(mail_server(None, None).unwrap(), ("smtp.gmail.com".to_string(), 587));
        assert_eq!(mail_server(Some(" "), Some("")).unwrap(), ("smtp.gmail.com".to_string(), 587));
        assert_eq!(mail_server(Some("smtp.zoho.in"), Some("465")).unwrap(), ("smtp.zoho.in".to_string(), 465));
        assert!(mail_server(Some("smtp.x.com; rm"), None).is_err());
        assert!(mail_server(None, Some("port")).is_err());
    }

    #[test]
    fn the_outbox_lists_what_waits_with_when_it_was_queued() {
        let outbox = std::env::temp_dir().join(format!("shopos-outbox-list-{}", stamp()));
        std::fs::create_dir_all(&outbox).unwrap();
        queue_raw(&outbox, "0001760000000000-invoice", INVOICE);
        let list = listed(&outbox);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].channel.as_str(), list[0].at), (INVOICE, 1_760_000_000_000));
        assert_eq!(list[0].to, vec!["ravi@example.com".to_string()]);
        let _ = std::fs::remove_dir_all(&outbox);
    }

    #[test]
    fn a_bot_token_must_look_like_one() {
        let shape = token_shape;
        assert!(shape("123456:ABC-def_ghi"));
        for bad in ["", "abc", "123:", ":abc", "12 3:abc", "123:ab c", "123:a/b"] {
            assert!(!shape(bad), "{bad}");
        }
    }
}
