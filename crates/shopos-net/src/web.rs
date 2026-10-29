/// The door the storefront knocks on: the main till's web API, reached only
/// through a Cloudflare Tunnel.
///
/// A second listener beside the sync one (`http.rs`), not a mode of it. They
/// answer different callers with different rules, and keeping them apart
/// means nothing here can loosen what sync accepts: sync is POST-only, signed,
/// and on every interface so the shop's other tills can reach it; this is GET
/// and POST, signed by nothing it can check, and on loopback only.
///
/// ── Why loopback ───────────────────────────────────────────────────────────
///
/// The only caller is `cloudflared`, running on the same machine, which holds
/// the tunnel open to Cloudflare. Bound to 127.0.0.1, the port cannot be
/// reached from the shop's wifi or from anywhere else; a customer reaches it
/// through Cloudflare, which terminates TLS, filters, and stamps the caller's
/// real address into `cf-connecting-ip` (replacing whatever the caller sent).
///
/// ── What it refuses before the webview is woken ────────────────────────────
///
/// Anything outside `/api/`, `/catalog/` and `/img/`; any method but GET, POST
/// and OPTIONS; a head over 16 KB; a body over 64 KB -- a storefront order is
/// a few kilobytes. Like sync, every rule about what a request means is in
/// `packages/core` (`services/web/routes.ts`); this only carries it there and
/// the answer back.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::http::{Timed, MAX_HEAD, READ_TIMEOUT};

/// An order, a sign-in, a phone number. Nothing the storefront sends is larger.
pub const MAX_WEB_BODY: usize = 64 * 1024;

/// Requests answered at once. `cloudflared` multiplexes many customers onto a
/// few connections, and a shop's storefront is a handful of phones at a time.
/// One more than this is told `BUSY` (503) at once rather than cut off, which
/// a phone used to read as the till being off.
pub const MAX_WEB_CONNECTIONS: usize = 16;

/// The only paths a request may be for.
pub const WEB_PREFIXES: [&str; 3] = ["/api/", "/catalog/", "/img/"];

/// The request headers passed on, lower-cased. Everything else is dropped.
pub const WEB_HEADERS: [&str; 4] = ["authorization", "origin", "cf-connecting-ip", "content-type"];

const HEAD_DEADLINE: Duration = Duration::from_secs(10);
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const MAX_PATH: usize = 512;

pub struct WebRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub struct WebReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl WebReply {
    pub fn json(status: u16, body: &str) -> WebReply {
        WebReply {
            status,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("cache-control".into(), "no-store".into()),
            ],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn refuse(status: u16, code: &str) -> WebReply {
        WebReply::json(status, &format!("{{\"error\":\"{code}\"}}"))
    }
}

pub trait WebAnswerer: Send + Sync + 'static {
    fn answer(&self, request: WebRequest) -> WebReply;
}

/// Why a request was turned away before it reached the answerer.
#[derive(Debug, PartialEq, Eq)]
pub enum WebRefusal {
    Malformed,
    NoSuchPath,
    Method,
    TooLarge,
}

impl WebRefusal {
    pub fn reply(&self) -> WebReply {
        match self {
            WebRefusal::Malformed => WebReply::refuse(400, "MALFORMED"),
            WebRefusal::NoSuchPath => WebReply::refuse(404, "NOT_FOUND"),
            WebRefusal::Method => WebReply::refuse(405, "METHOD"),
            WebRefusal::TooLarge => WebReply::refuse(413, "TOO_LARGE"),
        }
    }
}

pub struct WebBound {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl WebBound {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port)).map(|s| s.shutdown(Shutdown::Both));
    }
}

/// Listens on 127.0.0.1 only. Port 0 asks the system for a free one.
pub fn serve_web(port: u16, answerer: Arc<dyn WebAnswerer>) -> Result<WebBound, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("Could not read the port back: {e}"))?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let active = Arc::new(AtomicUsize::new(0));

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) => {
                    let Some(slot) = Slot::take(&active) else {
                        turn_away(stream);
                        continue;
                    };
                    let answerer = Arc::clone(&answerer);
                    std::thread::spawn(move || {
                        let _held = slot;
                        let _ = handle(answerer.as_ref(), stream);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });

    Ok(WebBound { port: bound, stop })
}

/// The answer when every slot is taken: try again in a moment.
pub fn busy() -> WebReply {
    let mut reply = WebReply::refuse(503, "BUSY");
    reply.headers.push(("retry-after".into(), "1".into()));
    reply.headers.push(("access-control-allow-origin".into(), "*".into()));
    reply
}

/// Says `BUSY` on the listening thread, in a few tens of milliseconds at most.
///
/// The reply is small enough to fit the socket's buffer, so writing it does
/// not wait on the caller. The request is then read off and thrown away:
/// closing a socket with unread bytes in it makes Windows reset the
/// connection, and a reset can reach the caller before the reply it follows.
fn turn_away(mut stream: TcpStream) {
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    if write_web(&mut stream, &busy()).is_err() {
        return;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
    let mut sink = [0u8; 4096];
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(50) {
        match stream.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(active: &Arc<AtomicUsize>) -> Option<Slot> {
        let taken = active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_WEB_CONNECTIONS).then_some(n + 1))
            .is_ok();
        taken.then(|| Slot(Arc::clone(active)))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn handle(answerer: &dyn WebAnswerer, mut stream: TcpStream) -> std::io::Result<()> {
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let started = Instant::now();
    let reply = match read_web(&stream, started + HEAD_DEADLINE, started + REQUEST_DEADLINE) {
        Ok(Ok(request)) => answerer.answer(request),
        Ok(Err(refusal)) => refusal.reply(),
        Err(_) => return Ok(()),
    };
    write_web(&mut stream, &reply)
}

/// The request, or why it was refused, or an I/O error for a caller that went
/// away or ran out of time.
pub fn read_web(
    stream: &TcpStream,
    head_deadline: Instant,
    deadline: Instant,
) -> std::io::Result<Result<WebRequest, WebRefusal>> {
    let mut reader = BufReader::new(Timed { stream, deadline: head_deadline.min(deadline), idle: READ_TIMEOUT });
    let mut head = (&mut reader).take(MAX_HEAD);

    let mut line = String::new();
    if head.read_line(&mut line)? == 0 || !line.ends_with('\n') {
        return Ok(Err(WebRefusal::Malformed));
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if !path.starts_with('/') || path.len() > MAX_PATH {
        return Ok(Err(WebRefusal::Malformed));
    }

    let mut length: Option<usize> = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut header = String::new();
        if head.read_line(&mut header)? == 0 || !header.ends_with('\n') {
            return Ok(Err(WebRefusal::Malformed));
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Ok(Err(WebRefusal::Malformed));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            length = value.parse::<usize>().ok();
        } else if name == "transfer-encoding" {
            // Chunked bodies are not something the storefront sends.
            return Ok(Err(WebRefusal::Malformed));
        } else if WEB_HEADERS.contains(&name.as_str()) {
            headers.push((name, value.to_string()));
        }
    }

    if !WEB_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return Ok(Err(WebRefusal::NoSuchPath));
    }
    let length = match method.as_str() {
        "GET" | "OPTIONS" => length.unwrap_or(0),
        "POST" => match length {
            Some(n) => n,
            None => return Ok(Err(WebRefusal::Malformed)),
        },
        _ => return Ok(Err(WebRefusal::Method)),
    };
    if length > MAX_WEB_BODY {
        return Ok(Err(WebRefusal::TooLarge));
    }

    reader.get_mut().deadline = deadline;
    let mut body = Vec::with_capacity(length);
    reader.take(length as u64).read_to_end(&mut body)?;
    if body.len() != length {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the caller went away"));
    }
    match String::from_utf8(body) {
        Ok(body) => Ok(Ok(WebRequest { method, path, headers, body })),
        Err(_) => Ok(Err(WebRefusal::Malformed)),
    }
}

pub fn write_web(stream: &mut TcpStream, reply: &WebReply) -> std::io::Result<()> {
    let reason = match reply.status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", reply.status);
    for (name, value) in &reply.headers {
        // A header the answerer wrote with a line break in it would be a second header.
        if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("content-length: {}\r\nconnection: close\r\n\r\n", reply.body.len()));
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Echo(Mutex<Vec<String>>);

    impl WebAnswerer for Echo {
        fn answer(&self, request: WebRequest) -> WebReply {
            let headers: Vec<String> = request.headers.iter().map(|(n, v)| format!("{n}={v}")).collect();
            self.0.lock().unwrap().push(format!("{} {} {}", request.method, request.path, headers.join(",")));
            WebReply {
                status: 200,
                headers: vec![("content-type".into(), "text/plain".into()), ("bad\nheader".into(), "x".into())],
                body: request.body.into_bytes(),
            }
        }
    }

    fn send(port: u16, raw: &str) -> String {
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).unwrap();
        out
    }

    fn start() -> (WebBound, Arc<Echo>) {
        let echo = Arc::new(Echo(Mutex::new(Vec::new())));
        let bound = serve_web(0, echo.clone()).unwrap();
        (bound, echo)
    }

    #[test]
    fn answers_a_get_and_a_post_on_its_paths_passing_only_the_headers_it_names() {
        let (bound, echo) = start();
        let got = send(bound.port, "GET /api/status HTTP/1.1\r\nOrigin: https://shop.example\r\nCookie: x=1\r\n\r\n");
        assert!(got.starts_with("HTTP/1.1 200 OK"), "{got}");
        assert!(!got.contains("bad"), "a header with a line break is not written: {got}");
        let posted = send(bound.port, "POST /api/orders HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}");
        assert!(posted.ends_with("{}"), "{posted}");
        let seen = echo.0.lock().unwrap().clone();
        assert_eq!(seen[0], "GET /api/status origin=https://shop.example");
        assert_eq!(seen[1], "POST /api/orders ");
        bound.stop();
    }

    #[test]
    fn refuses_other_paths_methods_and_large_bodies_without_asking_the_answerer() {
        let (bound, echo) = start();
        assert!(send(bound.port, "GET /hello HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(send(bound.port, "DELETE /api/orders HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 405"));
        assert!(send(bound.port, "POST /api/orders HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 400"));
        let big = format!("POST /api/orders HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_WEB_BODY + 1);
        assert!(send(bound.port, &big).starts_with("HTTP/1.1 413"));
        assert!(echo.0.lock().unwrap().is_empty());
        bound.stop();
    }

    struct Slow;

    impl WebAnswerer for Slow {
        fn answer(&self, _: WebRequest) -> WebReply {
            std::thread::sleep(Duration::from_millis(800));
            WebReply::json(200, "{}")
        }
    }

    #[test]
    fn says_busy_rather_than_hanging_up_when_every_slot_is_taken() {
        let bound = serve_web(0, Arc::new(Slow)).unwrap();
        let held: Vec<TcpStream> = (0..MAX_WEB_CONNECTIONS)
            .map(|_| {
                let mut c = TcpStream::connect(("127.0.0.1", bound.port)).unwrap();
                c.write_all(b"GET /api/status HTTP/1.1\r\n\r\n").unwrap();
                c
            })
            .collect();
        std::thread::sleep(Duration::from_millis(200));
        let got = send(bound.port, "GET /api/status HTTP/1.1\r\n\r\n");
        assert!(got.starts_with("HTTP/1.1 503"), "{got}");
        assert!(got.contains("BUSY") && got.contains("retry-after: 1"), "{got}");
        drop(held);
        bound.stop();
    }

    #[test]
    fn listens_on_loopback_and_nowhere_else() {
        let (bound, _) = start();
        let lan = crate::http::lan_address();
        if let Some(lan) = lan.filter(|a| a != "127.0.0.1") {
            assert!(TcpStream::connect((lan.as_str(), bound.port)).is_err(), "reachable on {lan}");
        }
        bound.stop();
    }
}
