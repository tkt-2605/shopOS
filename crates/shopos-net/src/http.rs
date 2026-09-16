/// The port another till knocks on, and nothing more than that.
///
/// This module deliberately knows nothing about replication. It accepts a
/// request, hands it to whatever is answering, and writes the answer back.
/// Every rule about what a request means — who may make it, what it does, which
/// row wins — lives in `packages/core`, in one copy, tested over real sockets
/// without any of this existing.
///
/// That is the whole reason it is shaped this way. A second implementation of
/// the protocol in Rust would drift from the TypeScript one, and the drift
/// would show up as two tills that agree about everything except the one row
/// that matters.
///
/// ── Why it is a crate and not part of the app ──────────────────────────────
///
/// Because the bench has to run a till in a container, on a real network, with
/// no Tauri anywhere near it. `Answerer` is the seam: the app answers by
/// handing the request to its webview, and `shopos-net answer` answers by
/// forwarding to a Node till on localhost. One listener, one parser, one set of
/// refusals, both ways round — which is the only arrangement where Layer 2
/// proves something about the code Layer 1 ran.
///
/// ── What protects it ───────────────────────────────────────────────────────
///
/// Everything except `/pair` carries an HMAC made with a secret agreed when the
/// two tills were introduced, checked in `packages/core/src/services/syncAuth.ts`.
/// `/pair` is open by necessity — it is the request that agrees the secret — and
/// is refused unless somebody has just pressed a button on that machine to offer
/// a code, which lives ten minutes and is spent by one attempt right or wrong.
///
/// The bills themselves cross in clear. That is written down here, in the
/// migration and in the doc rather than implied away.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A batch of two hundred bills with their lines is comfortably inside this.
/// Anything larger is not a till.
pub const MAX_BODY: usize = 32 * 1024 * 1024;

/// A connection that sends nothing is a connection that gets dropped.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Only the four the protocol has. An unknown path never reaches the answerer,
/// so a scanner sweeping the shop's network cannot use this to find out
/// anything except that something is listening.
pub const PATHS: [&str; 4] = ["/pair", "/hello", "/fetch", "/offer"];

/// The header a till advertises its own listening port in.
///
/// Must match `LISTEN_PORT_HEADER` in `packages/core/src/services/syncServer.ts`.
/// It is how the till being contacted learns where to reach the caller: before
/// it existed, a till that had been *joined* held a peer row with a secret and
/// no address, `pairedPeers` filters on `address IS NOT NULL`, and so the front
/// counter had nobody it could start a sync with. It could receive and never
/// initiate, and its own screen reported that the tills agreed.
pub const LISTEN_PORT_HEADER: &str = "x-shopos-port";

pub struct Request {
    pub path: String,
    pub body: String,
    pub auth: Option<String>,
    /// The socket's own view of who called. Not taken from a header, because a
    /// header is whatever the caller wants it to be.
    pub remote_address: Option<String>,
    /// The port the caller says it answers on. This one *is* from a header, and
    /// unsigned — which buys an attacker nothing, since the address is only
    /// used to open a connection that must then authenticate.
    pub listen_port: Option<u16>,
}

pub struct Reply {
    pub status: u16,
    pub body: String,
}

impl Reply {
    pub fn refuse(status: u16, code: &str) -> Reply {
        Reply { status, body: format!("{{\"code\":\"{code}\"}}") }
    }
}

/// Whatever decides what a request means.
///
/// `Send + Sync` because a thread is spawned per connection: there are two
/// tills in a shop, not two thousand, and a thread blocked on one slow reader
/// must not hold up the other till's sync.
pub trait Answerer: Send + Sync + 'static {
    fn answer(&self, request: Request) -> Reply;
}

pub struct Bound {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Bound {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        /* `accept` is blocking, so setting the flag alone leaves the thread
           parked until somebody happens to connect. Knocking on the door once
           wakes it, it sees the flag, and it stops. */
        let _ = TcpStream::connect(("127.0.0.1", self.port))
            .map(|s| s.shutdown(Shutdown::Both));
    }

    /// Shared with the discovery responder, so that there is deliberately no
    /// state where a till announces itself and then does not answer the door.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }
}

pub fn serve(port: u16, answerer: Arc<dyn Answerer>) -> Result<Bound, String> {
    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("Could not read the port back: {e}"))?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) => {
                    let answerer = Arc::clone(&answerer);
                    std::thread::spawn(move || {
                        let _ = handle(answerer.as_ref(), stream);
                    });
                }
                Err(_) => continue,
            }
        }
    });

    Ok(Bound { port: bound, stop })
}

fn handle(answerer: &dyn Answerer, mut stream: TcpStream) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));

    let remote = stream.peer_addr().ok().map(|a| a.ip().to_string());

    let request = match read_request(&mut stream, remote) {
        Ok(Some(request)) => request,
        Ok(None) => return write_response(&mut stream, 400, "{\"code\":\"MALFORMED\"}"),
        Err(_) => return Ok(()),
    };

    if !PATHS.contains(&request.path.as_str()) {
        return write_response(&mut stream, 404, "{\"code\":\"NO_SUCH_REQUEST\"}");
    }

    let reply = answerer.answer(request);
    write_response(&mut stream, reply.status, &reply.body)
}

/// Enough HTTP/1.1 for four POSTs carrying JSON, and deliberately not a byte
/// more. Everything it does not understand is a refusal rather than a guess.
pub fn read_request(
    stream: &mut TcpStream,
    remote_address: Option<String>,
) -> std::io::Result<Option<Request>> {
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
    let mut listen_port: Option<u16> = None;

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
            LISTEN_PORT_HEADER => listen_port = value.parse::<u16>().ok(),
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
        Ok(body) => Ok(Some(Request { path, body, auth, remote_address, listen_port })),
        Err(_) => Ok(None),
    }
}

pub fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
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
pub fn lan_address() -> Option<String> {
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
    use std::net::TcpListener;
    use std::io::Read;

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
        let parsed = read_request(&mut stream, None).unwrap();
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
        let parsed = read_request(&mut stream, None).unwrap().unwrap();
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

    #[test]
    fn reads_the_port_a_till_says_it_answers_on() {
        // Without this the till being contacted has no address to record, and a
        // till that has been joined can receive a sync but never start one.
        let raw = post("/hello", "{}", "x-shopos-port: 7801
");
        assert_eq!(request_from(&raw).unwrap().listen_port, Some(7801));
    }

    #[test]
    fn treats_a_port_that_is_not_a_port_as_absent() {
        for value in ["0x1", "-1", "99999", "", "seven"] {
            let raw = post("/hello", "{}", &format!("x-shopos-port: {value}
"));
            let parsed = request_from(&raw).unwrap();
            assert_eq!(parsed.listen_port, None, "{value} should not parse");
        }
    }

    #[test]
    fn carries_the_callers_address_from_the_socket_and_not_a_header() {
        /* A header is whatever the caller wants it to be. The address has to
           come from the connection, or a till could point the shop's next sync
           at a machine of its choosing. */
        let raw = post("/hello", "{}", "x-forwarded-for: 10.0.0.1
");
        let parsed = request_from(&raw).unwrap();
        assert_eq!(parsed.remote_address, None);
    }
}
