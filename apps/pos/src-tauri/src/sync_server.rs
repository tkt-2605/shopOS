/// The port another till knocks on, and nothing more than that.
///
/// This module deliberately knows nothing about replication. It accepts a
/// request, hands the bytes to the webview, waits for an answer, and writes it
/// back. Every rule about what a request means — who may make it, what it does,
/// which row wins — lives in `packages/core`, in one copy, tested over real
/// sockets without any of this existing.
///
/// That is the whole reason it is shaped this way. A second implementation of
/// the protocol in Rust would drift from the TypeScript one, and the drift would
/// show up as two tills that agree about everything except the one row that
/// matters.
///
/// ── Off unless a shop turns it on ──────────────────────────────────────────
///
/// Nothing listens until `sync_serve_start` is called. A shop with one till
/// never opens a port at all, which is the right default for the large majority
/// of them: an open port that nothing uses is a way in and no use to anybody.
///
/// ── What protects it ───────────────────────────────────────────────────────
///
/// Everything except `/pair` carries an HMAC made with a secret agreed when the
/// two tills were introduced, checked in `packages/core/src/services/syncAuth.ts`.
/// `/pair` is open by necessity — it is the request that agrees the secret — and
/// is refused unless somebody has just pressed a button on this machine to offer
/// a code, which lives ten minutes and is spent by one attempt right or wrong.
///
/// The bills themselves cross in clear. That is written down here, in the
/// migration and in the doc rather than implied away.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// A batch of two hundred bills with their lines is comfortably inside this.
/// Anything larger is not a till.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// How long the webview has to answer before the caller is told to come back.
/// Generous, because applying a batch is a real transaction on a real disk.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);

/// A connection that sends nothing is a connection that gets dropped.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

const PATHS: [&str; 4] = ["/pair", "/hello", "/fetch", "/offer"];

#[derive(Serialize, Clone)]
pub struct ServeInfo {
    pub port: u16,
    /// What to type into the other till, ready to be read out loud.
    pub address: Option<String>,
}

#[derive(Serialize, Clone)]
struct Forwarded {
    id: u64,
    path: String,
    body: String,
    auth: Option<String>,
}

#[derive(Deserialize)]
pub struct Reply {
    status: u16,
    body: String,
}

#[derive(Default)]
pub struct SyncHost {
    running: Mutex<Option<Running>>,
    waiting: Mutex<HashMap<u64, Sender<Reply>>>,
    next: AtomicU64,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[tauri::command]
pub fn sync_serve_start(app: tauri::AppHandle, port: u16) -> Result<ServeInfo, String> {
    let host = app.state::<SyncHost>();
    let mut running = host.running.lock().map_err(|_| "sync host is wedged")?;

    if let Some(current) = running.as_ref() {
        // Already answering. Saying so beats quietly starting a second one.
        return Ok(ServeInfo {
            port: current.port,
            address: lan_address().map(|ip| format!("{ip}:{}", current.port)),
        });
    }

    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("Could not read the port back: {e}"))?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let handle = app.clone();

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) => {
                    let to_app = handle.clone();
                    // A thread per connection. There are two tills in a shop, not
                    // two thousand, and a thread that blocks on one slow reader
                    // must not hold up the other till's sync.
                    std::thread::spawn(move || {
                        let _ = answer(&to_app, stream);
                    });
                }
                Err(_) => continue,
            }
        }
    });

    *running = Some(Running { port: bound, stop });

    Ok(ServeInfo {
        port: bound,
        address: lan_address().map(|ip| format!("{ip}:{bound}")),
    })
}

#[tauri::command]
pub fn sync_serve_stop(app: tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<SyncHost>();
    let mut running = host.running.lock().map_err(|_| "sync host is wedged")?;

    if let Some(current) = running.take() {
        current.stop.store(true, Ordering::SeqCst);
        /* `accept` is blocking, so setting the flag alone leaves the thread
           parked until somebody happens to connect. Knocking on the door once
           wakes it, it sees the flag, and it stops. */
        let _ = TcpStream::connect(("127.0.0.1", current.port))
            .map(|s| s.shutdown(Shutdown::Both));
    }
    Ok(())
}

#[tauri::command]
pub fn sync_serve_status(app: tauri::AppHandle) -> Option<ServeInfo> {
    let host = app.state::<SyncHost>();
    let running = host.running.lock().ok()?;
    running.as_ref().map(|current| ServeInfo {
        port: current.port,
        address: lan_address().map(|ip| format!("{ip}:{}", current.port)),
    })
}

/// The webview handing back what it decided.
#[tauri::command]
pub fn sync_reply(app: tauri::AppHandle, id: u64, status: u16, body: String) {
    let host = app.state::<SyncHost>();
    let sender = host.waiting.lock().ok().and_then(|mut w| w.remove(&id));
    if let Some(sender) = sender {
        // The receiver is gone if the caller already timed out and left.
        let _ = sender.send(Reply { status, body });
    }
}

fn answer(app: &tauri::AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));

    let request = match read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return write_response(&mut stream, 400, "{\"code\":\"MALFORMED\"}"),
        Err(_) => return Ok(()),
    };

    /* Only the four the protocol has. An unknown path never reaches the webview,
       so a scanner sweeping the shop's network cannot use this to find out
       anything except that something is listening. */
    if !PATHS.contains(&request.path.as_str()) {
        return write_response(&mut stream, 404, "{\"code\":\"NO_SUCH_REQUEST\"}");
    }

    let host = app.state::<SyncHost>();
    let id = host.next.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = channel::<Reply>();

    if let Ok(mut waiting) = host.waiting.lock() {
        waiting.insert(id, sender);
    }

    let forwarded = Forwarded {
        id,
        path: request.path,
        body: request.body,
        auth: request.auth,
    };

    if app.emit("sync-request", forwarded).is_err() {
        if let Ok(mut waiting) = host.waiting.lock() {
            waiting.remove(&id);
        }
        return write_response(&mut stream, 503, "{\"code\":\"NOT_READY\"}");
    }

    match receiver.recv_timeout(ANSWER_TIMEOUT) {
        Ok(reply) => write_response(&mut stream, reply.status, &reply.body),
        Err(_) => {
            /* The webview never answered — closed, asleep, or busy with a
               transaction that outlasted the wait. The other till is told to
               come back rather than left holding a connection. */
            if let Ok(mut waiting) = host.waiting.lock() {
                waiting.remove(&id);
            }
            write_response(&mut stream, 503, "{\"code\":\"NOT_READY\"}")
        }
    }
}

struct Request {
    path: String,
    body: String,
    auth: Option<String>,
}

/// Enough HTTP/1.1 for four POSTs carrying JSON, and deliberately not a byte
/// more. Everything it does not understand is a refusal rather than a guess.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }

    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method != "POST" || !path.starts_with('/') {
        return Ok(None);
    }

    let mut length: Option<usize> = None;
    let mut auth: Option<String> = None;

    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Ok(None);
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse::<usize>().ok(),
            "x-shopos-auth" => auth = Some(value.to_string()),
            _ => {}
        }
    }

    // No length, no body, no guessing. Chunked encoding is not something a till
    // sends, and accepting it would be a parser nobody needs.
    let Some(length) = length else {
        return Ok(None);
    };
    if length > MAX_BODY {
        return Ok(None);
    }

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;

    match String::from_utf8(body) {
        Ok(body) => Ok(Some(Request { path, body, auth })),
        Err(_) => Ok(None),
    }
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         content-type: application/json\r\n\
         content-length: {}\r\n\
         connection: close\r\n\
         \r\n\
         {body}",
        body.as_bytes().len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

/// This machine's address on the shop's network, for a person to read out.
///
/// Asking a UDP socket where it would send from is the way to get this without
/// a crate that enumerates interfaces, and it is the right answer rather than a
/// clever one: a machine with a wifi card, an ethernet cable and a virtual
/// adapter has three addresses, and this picks the one the shop's traffic
/// actually leaves by. No packet is sent — `connect` on UDP only fixes a route.
fn lan_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.168.1.1:9").ok()?;
    let address = socket.local_addr().ok()?.ip();
    if address.is_loopback() || address.is_unspecified() {
        return None;
    }
    Some(address.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_from(raw: &str) -> Option<Request> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let raw = raw.to_string();

        let sender = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            client.write_all(raw.as_bytes()).unwrap();
            client.flush().unwrap();
            // Held open: read_exact must not race the socket closing.
            std::thread::sleep(Duration::from_millis(50));
        });

        let (mut stream, _) = listener.accept().unwrap();
        let parsed = read_request(&mut stream).unwrap();
        sender.join().unwrap();
        parsed
    }

    fn post(path: &str, body: &str, extra: &str) -> String {
        format!(
            "POST {path} HTTP/1.1\r\nhost: x\r\n{extra}content-length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn reads_a_post_with_a_body() {
        let parsed = request_from(&post("/hello", "{\"a\":1}", "")).unwrap();
        assert_eq!(parsed.path, "/hello");
        assert_eq!(parsed.body, "{\"a\":1}");
        assert!(parsed.auth.is_none());
    }

    #[test]
    fn carries_the_signature_through_untouched() {
        // It covers the body byte for byte, so anything done to it here would
        // show up as every request failing to verify.
        let signature = "device.1700000000000.abc123.deadbeef";
        let raw = post("/fetch", "{}", &format!("x-shopos-auth: {signature}\r\n"));
        assert_eq!(request_from(&raw).unwrap().auth.as_deref(), Some(signature));
    }

    #[test]
    fn finds_the_header_whatever_case_it_arrives_in() {
        let raw = post("/fetch", "{}", "X-ShopOS-Auth: signed\r\n");
        assert_eq!(request_from(&raw).unwrap().auth.as_deref(), Some("signed"));
    }

    #[test]
    fn refuses_anything_that_is_not_a_post() {
        for method in ["GET", "PUT", "DELETE", "OPTIONS"] {
            let raw = format!("{method} /hello HTTP/1.1\r\ncontent-length: 0\r\n\r\n");
            assert!(request_from(&raw).is_none(), "{method} should be refused");
        }
    }

    #[test]
    fn refuses_a_body_with_no_length_rather_than_guessing() {
        let raw = "POST /hello HTTP/1.1\r\nhost: x\r\n\r\n{\"a\":1}";
        assert!(request_from(raw).is_none());
    }

    #[test]
    fn refuses_a_body_larger_than_any_till_would_send() {
        let raw = format!(
            "POST /offer HTTP/1.1\r\ncontent-length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(request_from(&raw).is_none());
    }

    #[test]
    fn refuses_a_header_that_is_not_a_header() {
        let raw = "POST /hello HTTP/1.1\r\nthis is not a header\r\ncontent-length: 0\r\n\r\n";
        assert!(request_from(raw).is_none());
    }

    #[test]
    fn reads_a_body_that_arrives_in_pieces() {
        // Which is what a body larger than one packet does.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "x".repeat(200_000);
        let expected = body.clone();

        let sender = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            client
                .write_all(
                    format!(
                        "POST /offer HTTP/1.1\r\ncontent-length: {}\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
            for chunk in body.as_bytes().chunks(8192) {
                client.write_all(chunk).unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
            client.flush().unwrap();
            std::thread::sleep(Duration::from_millis(50));
        });

        let (mut stream, _) = listener.accept().unwrap();
        let parsed = read_request(&mut stream).unwrap().unwrap();
        sender.join().unwrap();
        assert_eq!(parsed.body.len(), expected.len());
    }

    #[test]
    fn only_the_four_paths_the_protocol_has() {
        for path in ["/pair", "/hello", "/fetch", "/offer"] {
            assert!(PATHS.contains(&path));
        }
        for path in ["/", "/admin", "/shop.db", "/../device.json"] {
            assert!(!PATHS.contains(&path), "{path} should not be served");
        }
    }

    #[test]
    fn writes_a_response_a_client_can_read() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();

        let reader = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            let mut got = String::new();
            client.read_to_string(&mut got).unwrap();
            got
        });

        let (mut stream, _) = listener.accept().unwrap();
        write_response(&mut stream, 401, "{\"code\":\"BAD_SIGNATURE\"}").unwrap();
        drop(stream);

        let got = reader.join().unwrap();
        assert!(got.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(got.contains("content-length: 24\r\n"));
        assert!(got.ends_with("{\"code\":\"BAD_SIGNATURE\"}"));
    }
}
