/// Sending a shop's reports out of the building, with no server of ours in
/// between: into a zip on this machine, into the folder backups already go to
/// (a Google Drive or OneDrive folder is the usual one), and by email.
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
/// ## What the shop sets up, and what comes with the build
///
/// The shop gives one thing: its mail login (Shop details), which sends the
/// reports to the shop's own address and the bills to the customers ticked
/// for them. Everything else comes with the build, from `.env` through
/// `build.rs`, so a new value reaches the shops in an update and nobody types
/// a token: the vendor's own address, which every report pack and the health
/// report are copied to (`SHOPOS_REPORTS_TO`; decided 19 Oct that the vendor
/// receives the shops' reports, and the same day that they come by mail, not
/// by a Telegram bot whose token sat in every installer), and the mail server
/// for shops not on Gmail. Every message is sent from the shop's own login, so
/// nothing secret of the vendor's is in the build.
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
/// The mail server, when the shops are not on Gmail. Baked in by `build.rs`
/// from a git-ignored `.env`.
const BUILT_MAIL_HOST: Option<&str> = option_env!("SHOPOS_MAIL_HOST");
const BUILT_MAIL_PORT: Option<&str> = option_env!("SHOPOS_MAIL_PORT");
/// The vendor's addresses: every report pack and the health report are also
/// copied to these, besides the shop's own.
const BUILT_REPORTS_TO: Option<&str> = option_env!("SHOPOS_REPORTS_TO");

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxState {
    waiting: usize,
    sent: usize,
    error: Option<String>,
    /// Why each channel is stuck, by channel: `mail`, `invoice`.
    errors: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct Queued {
    /// `mail` or `invoice`; `telegram` in anything queued by 0.3.2 or before,
    /// which `flush` drops. Absent in anything queued before Telegram existed.
    #[serde(default = "mail_channel")]
    channel: String,
    #[serde(default)]
    to: Vec<String>,
    subject: String,
    body: String,
    /// The zip's name as the recipient will see it.
    attach_name: String,
    // Anything queued by 0.3.1 or before also carries `vendor`, which is ignored.
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

/// What is set up on this machine, read once per call.
struct Settings {
    /// The shop's login, to the shop's own address and the build's copies.
    mail: Option<Mail>,
    /// The shop's mail login alone, for bills emailed to customers.
    sender: Option<Mail>,
}

impl Settings {
    /// Everything set up on this machine. A setting that is wrong is read as
    /// not set up, and its channel waits.
    fn all(app: &tauri::AppHandle) -> Self {
        Settings {
            mail: mail_settings(app).unwrap_or(None),
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
    })
}

/// How one file fared on each channel.
pub(crate) struct Sent {
    pub mail: &'static str,
    pub mail_error: Option<String>,
}

/// Queues one zip for mail, when this machine has a mail login, and tries it.
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

    let queue = |channel: &str, to: Vec<String>| -> Result<String, String> {
        let id = format!("{stem}-{channel}");
        let queued = Queued {
            channel: channel.into(),
            to,
            subject: subject.clone(),
            body: body.clone(),
            attach_name: name.clone(),
        };
        let meta = serde_json::to_vec(&queued).map_err(|e| e.to_string())?;
        files::write_durably(&outbox.join(format!("{id}.zip")), &bytes)?;
        files::write_durably(&outbox.join(format!("{id}.json")), &meta)?;
        Ok(id)
    };

    let mut settings = Settings { mail: None, sender: None };
    let (mut mail, mut mail_error) = ("off", None);
    let mut mail_id = None;

    match mail_settings(&app) {
        Err(e) => mail_error = Some(e),
        Ok(None) => {}
        Ok(Some(m)) => {
            mail_id = Some(queue("mail", m.to.clone())?);
            settings.mail = Some(m);
        }
    }
    trim_queue(&outbox);

    if let Some(id) = &mail_id {
        let state = flush(&outbox, &settings);
        if outbox.join(format!("{id}.json")).exists() {
            mail = "queued";
            mail_error = state.errors.get("mail").cloned();
        } else {
            mail = "sent";
        }
    }

    Ok(Sent { mail, mail_error })
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
    /// The addresses it goes to.
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
}

#[tauri::command(async)]
pub fn report_destinations(app: tauri::AppHandle) -> Destinations {
    let (sender, reports_to, mail_error) = match mail_settings(&app) {
        Ok(Some(m)) => (Some(m.user), m.to, None),
        Ok(None) => (None, Vec::new(), None),
        Err(e) => (None, Vec::new(), Some(e)),
    };
    Destinations { sender, reports_to, mail_error }
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
    for channel in ["mail"] {
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
            /* Queued for the vendor's bot by 0.3.2 or before. There is no bot
               now, and the same pack was queued for mail beside it whenever
               the shop had a login, so it goes rather than waiting for ever. */
            "telegram" => {
                let _ = std::fs::remove_file(outbox.join(format!("{id}.json")));
                let _ = std::fs::remove_file(outbox.join(format!("{id}.zip")));
                continue;
            }
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

/// Whether the health report goes out daily from this build: it does when the
/// build names the vendor's address or the vendor's portal. It names no
/// customer, so it needs nobody's say-so. By mail it still needs the shop's
/// login, and waits in the outbox until there is one.
#[tauri::command]
pub fn report_health_daily() -> bool {
    vendor_addressed() || crate::portal_out::built_in()
}

/// Whether this build copies the reports to the vendor by mail.
fn vendor_addressed() -> bool {
    recipients(BUILT_REPORTS_TO.unwrap_or("")).is_ok_and(|to| !to.is_empty())
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

#[cfg(not(windows))]
fn send_mail(_: &Path, _: &str, _: &Queued, _: &Mail) -> Result<(), String> {
    Err("Sending mail is only available on Windows.".into())
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
        let none = Settings { mail: None, sender: None };
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

    /// A pack queued for the vendor's bot by 0.3.2 or before still reads, and
    /// is dropped rather than left waiting for a bot that is gone.
    #[test]
    fn a_message_queued_for_the_old_bot_is_dropped() {
        let outbox = std::env::temp_dir().join(format!("shopos-outbox-tg-{}", stamp()));
        std::fs::create_dir_all(&outbox).unwrap();
        std::fs::write(outbox.join("0001760000000000-telegram.zip"), b"PK").unwrap();
        std::fs::write(
            outbox.join("0001760000000000-telegram.json"),
            r#"{"channel":"telegram","subject":"s","body":"b","attach_name":"a.zip","vendor":false}"#,
        )
        .unwrap();
        let state = flush(&outbox, &Settings { mail: None, sender: None });
        assert_eq!((state.waiting, state.sent), (0, 0));
        assert!(state.errors.is_empty());
        assert!(!outbox.join("0001760000000000-telegram.zip").exists());
        let _ = std::fs::remove_dir_all(&outbox);
    }
}
