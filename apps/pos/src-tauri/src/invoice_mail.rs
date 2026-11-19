/// A bill emailed to its customer, as the shop's own A4 invoice in a PDF.
///
/// The webview hands over the invoice page it already prints (`billSheetHtml`)
/// and the customer's address; this turns the page into a PDF and puts it in the
/// outbox `report_out.rs` keeps, which holds it until the mail server takes it.
/// It is sent from the shop's own mail login, set up in Settings for the report
/// pack.
///
/// ## Why Edge makes the PDF
///
/// `pdf.rs` cannot print a rupee sign or a Tamil name, which is why the invoice
/// is HTML in the first place. The page needs a browser engine to become a PDF,
/// and every Windows 10 and 11 machine carries Microsoft Edge, which prints a
/// page to PDF with no window at all (`--headless --print-to-pdf`). It is the
/// same Chromium engine as the WebView2 the till runs in, so the PDF is the
/// page the shop sees in the preview, with the fonts this machine has -- Nirmala
/// UI for Tamil -- embedded. No crate, and nothing to keep up to date.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::{files, paths, report_out};

/// One PDF at a time: each is a browser process.
static RENDERING: Mutex<()> = Mutex::new(());
#[cfg_attr(not(windows), allow(dead_code))]
const RENDER_DEADLINE: Duration = Duration::from_secs(60);
/// What a bill's PDF can reasonably come to, logo and all.
const MAX_PDF_BYTES: usize = 10 * 1024 * 1024;

/// Several bills in one PDF (`bills_pdf`): two hundred pages take Edge a while,
/// and each carries the logo.
#[cfg_attr(not(windows), allow(dead_code))]
const MANY_DEADLINE: Duration = Duration::from_secs(10 * 60);
const MANY_MAX_BYTES: usize = 200 * 1024 * 1024;

/// Set by `bills_pdf_cancel`: the Edge printing now is stopped, and nothing is saved.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// How long Edge may take, and how big a PDF is believable.
#[derive(Clone, Copy)]
struct Limits {
    deadline: Duration,
    max_bytes: usize,
    /// Only `bills_pdf` listens to Cancel: a press left over must never stop
    /// the next bill being emailed.
    cancellable: bool,
}
const ONE_BILL: Limits = Limits { deadline: RENDER_DEADLINE, max_bytes: MAX_PDF_BYTES, cancellable: false };

impl Limits {
    fn cancelled(&self) -> bool {
        self.cancellable && CANCELLED.load(Ordering::SeqCst)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillMailed {
    /// `sent`, or `queued` (the outbox will retry).
    mail: &'static str,
    /// Why it is still waiting, when it is.
    error: Option<String>,
}

/// Why this machine cannot email bills, or `None` when it can. Asked before a
/// bill is rendered, so a till with no mail login does not start a browser for
/// every bill only to keep it.
#[tauri::command(async)]
pub fn bill_mail_ready(app: tauri::AppHandle) -> Option<String> {
    if !cfg!(windows) {
        return Some("Bills are emailed from a Windows till.".into());
    }
    match report_out::sender_settings(&app) {
        Ok(Some(_)) => {}
        Ok(None) => return Some("Set up the shop's email in Settings, under reports, to email bills.".into()),
        Err(e) => return Some(e),
    }
    if edge().is_none() {
        return Some("Microsoft Edge is not on this PC, and it is what turns a bill into a PDF.".into());
    }
    None
}

/// Renders the invoice to a PDF and queues it for the customer.
#[tauri::command(async)]
pub fn bill_mail(
    app: tauri::AppHandle,
    doc_no: String,
    to: String,
    subject: String,
    body: String,
    html: String,
) -> Result<BillMailed, String> {
    // Checked before a browser is started for it.
    let one = report_out::recipients(&to)?;
    if one.len() != 1 {
        return Err("A bill is emailed to one address.".into());
    }
    let pdf = render_pdf(&app, &html, ONE_BILL)?;
    let (mail, error) = report_out::queue_invoice(&app, &to, &subject, &body, &attach_name(&doc_no), &pdf)?;
    Ok(BillMailed { mail, error })
}

/// Several bills' invoices as one PDF, a page or more each, saved beside the
/// other exports. The webview hands over the pages already joined (one
/// document, each bill starting a new page); a reference only, so nothing is
/// written to the books. `bills_pdf_cancel` stops it partway.
#[tauri::command(async)]
pub fn bills_pdf(app: tauri::AppHandle, filename: String, html: String) -> Result<String, String> {
    let name = crate::exports::safe_name(&filename, &["pdf"])?;
    if edge().is_none() {
        return Err("Microsoft Edge is not on this PC, and it is what turns a bill into a PDF.".into());
    }
    CANCELLED.store(false, Ordering::SeqCst);
    let pdf = render_pdf(&app, &html, Limits { deadline: MANY_DEADLINE, max_bytes: MANY_MAX_BYTES, cancellable: true })?;
    crate::exports::write(&app, &name, &pdf)
}

/// Stops the `bills_pdf` under way, if there is one.
#[tauri::command]
pub fn bills_pdf_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

/// What a stopped PDF says; the screen knows it and shows no error for it.
const STOPPED: &str = "Stopped.";

/// `BMR/2627/00012` as a file name a mail client shows: `BMR-2627-00012.pdf`.
fn attach_name(doc_no: &str) -> String {
    let stem: String = doc_no
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(80)
        .collect();
    let stem = stem.trim_matches('-');
    format!("{}.pdf", if stem.is_empty() { "invoice" } else { stem })
}

/// Where Edge is, if it is installed.
fn edge() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
        .iter()
        .filter_map(|v| std::env::var_os(v))
        .map(|root| PathBuf::from(root).join("Microsoft").join("Edge").join("Application").join("msedge.exe"))
        .find(|p| p.is_file())
}

fn render_pdf(app: &tauri::AppHandle, html: &str, limits: Limits) -> Result<Vec<u8>, String> {
    let _one = RENDERING.lock().unwrap_or_else(|e| e.into_inner());
    let edge = edge().ok_or("Microsoft Edge is not on this PC, and it is what turns a bill into a PDF.")?;
    let data = paths::data_dir(app)?;
    let work = data.join("pdf-work").join(report_out::stamp());
    std::fs::create_dir_all(&work).map_err(|e| format!("Could not create {}: {e}", work.display()))?;
    let result = render_in(&edge, &data.join("pdf-browser"), &work, html, limits);
    // Kept when it failed: the page and Edge's log are what explain it.
    if result.is_ok() {
        let _ = std::fs::remove_dir_all(&work);
    }
    result
}

/// Writes the page, has Edge print it, and reads the PDF back.
fn render_in(edge: &Path, profile: &Path, work: &Path, html: &str, limits: Limits) -> Result<Vec<u8>, String> {
    let page = work.join("invoice.html");
    let out = work.join("invoice.pdf");
    files::write_durably(&page, html.as_bytes())?;
    let url = format!("file:///{}", page.to_string_lossy().replace('\\', "/"));
    let log = work.join("edge.log");
    let ended = run(edge, &log, limits, &[
        "--headless=new".into(),
        "--disable-gpu".into(),
        "--no-first-run".into(),
        "--no-pdf-header-footer".into(),
        // Edge's own account of itself, read back into the error when no PDF comes.
        "--enable-logging=stderr".into(),
        // Its own profile: never the shop's browser, its sign-ins or its history.
        format!("--user-data-dir={}", profile.display()),
        format!("--print-to-pdf={}", out.display()),
        url,
    ])?;
    if limits.cancelled() {
        return Err(STOPPED.into());
    }
    let pdf = settled(&out, PDF_WAIT, limits).ok_or_else(|| {
        let said = std::fs::read_to_string(&log).unwrap_or_default();
        let tail: String = said.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
        let tail: String = tail.chars().take(400).collect();
        format!("Edge did not produce the PDF ({ended}){}", if tail.is_empty() { String::new() } else { format!(": {tail}") })
    })?;
    if !pdf.starts_with(b"%PDF") || pdf.len() > limits.max_bytes {
        return Err("The PDF Edge produced is not usable.".into());
    }
    Ok(pdf)
}

/// How long the PDF may take to appear after the Edge that was started exits.
const PDF_WAIT: Duration = Duration::from_secs(20);

/// The file once it is there and has stopped growing, or `None` after `wait`.
///
/// The `msedge.exe` this starts is not always the one that prints. With a
/// browser folder it has not used before -- the first bill a till ever emails
/// -- Edge hands the work to a process of its own and the first one exits at
/// once. Reading the file then found nothing, and the shop's first two emailed
/// bills on till 1 failed with "Edge did not produce the PDF" while every test,
/// which waited on the whole process tree, passed.
fn settled(path: &Path, wait: Duration, limits: Limits) -> Option<Vec<u8>> {
    let started = std::time::Instant::now();
    let mut last: Option<u64> = None;
    loop {
        let size = std::fs::metadata(path).ok().map(|m| m.len()).filter(|&n| n > 0);
        if size.is_some() && size == last {
            return std::fs::read(path).ok();
        }
        if started.elapsed() > wait || limits.cancelled() {
            return None;
        }
        last = size;
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Runs Edge and says how it ended, for an error that has to explain itself.
#[cfg(windows)]
fn run(program: &Path, log: &Path, limits: Limits, args: &[String]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    // A file rather than a pipe: a pipe nobody reads fills, and Edge stops.
    let err = std::fs::File::create(log).map(Stdio::from).unwrap_or_else(|_| Stdio::null());
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(err)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("Could not start Edge to make the PDF: {e}"))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(format!("Edge ended with {status}")),
            None if limits.cancelled() => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(STOPPED.into());
            }
            None if started.elapsed() > limits.deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Edge took too long to make the PDF.".into());
            }
            None => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

#[cfg(not(windows))]
fn run(_: &Path, _: &Path, _: Limits, _: &[String]) -> Result<String, String> {
    Err("Bills are emailed from a Windows till.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bill_number_becomes_a_file_name() {
        assert_eq!(attach_name("BMR/2627/00012"), "BMR-2627-00012.pdf");
        assert_eq!(attach_name("  ../x  "), "x.pdf");
        assert_eq!(attach_name("///"), "invoice.pdf");
    }

    /// Edge's own process can write the PDF after the one started has exited.
    #[test]
    fn a_pdf_written_late_is_waited_for() {
        let dir = std::env::temp_dir().join(format!("shopos-late-{}", report_out::stamp()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("invoice.pdf");
        let writer = {
            let out = out.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                std::fs::write(&out, b"%PDF-1.4 late").unwrap();
            })
        };
        assert_eq!(settled(&out, Duration::from_secs(5), ONE_BILL).as_deref(), Some(&b"%PDF-1.4 late"[..]));
        writer.join().unwrap();
        assert!(settled(&dir.join("never.pdf"), Duration::from_millis(600), ONE_BILL).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real thing, on a machine with Edge: the rupee sign and Tamil reach the
    /// PDF as embedded fonts, not as boxes.
    #[cfg(windows)]
    #[test]
    fn edge_prints_the_invoice_page_with_its_fonts() {
        let Some(edge) = edge() else { return };
        let root = std::env::temp_dir().join(format!("shopos-pdf-{}", report_out::stamp()));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let html = "<!doctype html><html><head><meta charset='utf-8'></head><body style=\"font-family:'Segoe UI','Nirmala UI'\">\
                    <h1>Tax Invoice BMR/2627/00012</h1><p>Total \u{20b9}1,234.50</p><p>\u{0BA4}\u{0BAE}\u{0BBF}\u{0BB4}\u{0BCD}</p></body></html>";
        let pdf = render_in(&edge, &root.join("profile"), &work, html, ONE_BILL).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(pdf.starts_with(b"%PDF"));
        assert!(text.contains("NirmalaUI"), "the Tamil font is embedded");
        let _ = std::fs::remove_dir_all(&root);
    }
}
