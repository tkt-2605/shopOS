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
///
/// ── What it refuses before anybody has proved anything ────────────────────
///
/// The signature is checked in the webview, after the whole body has arrived
/// and been handed across. Everything in front of that is reachable by anyone
/// on the shop's wifi, so it is kept cheap: an unknown path, or a request
/// other than `/pair` with no signature on it at all, is turned away as soon
/// as its head has been read -- before a byte of body is accepted and before
/// the webview is woken. A `/pair` body is a few hundred bytes and is held to
/// that. A body is read as it arrives rather than allocated up front from
/// what the header claims. And a request has a deadline as a whole, not only
/// per read, so a caller trickling one byte every twenty-nine seconds cannot
/// hold a connection for ever.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A batch of two hundred bills with their lines is comfortably inside this.
/// Anything larger is not a till.
pub const MAX_BODY: usize = 32 * 1024 * 1024;

/// What a `/pair` body may come to.
///
/// A pairing request is a code, a device id, a label and a fingerprint -- a
/// few hundred bytes -- and it is the one request anybody may send unsigned.
/// This leaves room for a public key when pairing agrees its secret by key
/// exchange, and none for anything else.
pub const MAX_PAIR_BODY: usize = 8 * 1024;

/// A connection that sends nothing is a connection that gets dropped.
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the request line and headers may take to arrive, all of them.
///
/// A till sends its head in one packet. Ten seconds is generous for a busy
/// wifi and short enough that a caller dribbling a header a byte at a time
/// gives its connection back quickly.
const HEAD_DEADLINE: Duration = Duration::from_secs(10);

/// How long a whole request may take to arrive, head and body.
///
/// Per-read timeouts alone never end a connection that keeps sending a byte
/// just inside each one. This does: every read is given whatever is left of
/// this, never more.
const REQUEST_DEADLINE: Duration = Duration::from_secs(60);

/// The most a request line and its headers may come to.
///
/// A till's head is a few hundred bytes. Without a ceiling `read_line` reads
/// until it finds a newline, so a line that never ends -- trickled in faster
/// than the read timeout -- grows until the till runs out of memory. Anyone on
/// the shop's wifi can send one, before any signature is looked at.
pub const MAX_HEAD: u64 = 16 * 1024;

/// How many requests are answered at once.
///
/// Each connection is a thread held for up to `REQUEST_DEADLINE`. Unbounded, a
/// burst of connections that say nothing is a thread apiece until the process
/// cannot make another, and the till stops. A shop has a handful of tills; a
/// connection beyond this is closed at once rather than queued.
pub const MAX_CONNECTIONS: usize = 16;

/// How many of those may come from one address.
///
/// Without it one machine could take all sixteen and the other till in the
/// shop would find the door shut. A till has one round in flight, perhaps two
/// while a pairing is being polled.
pub const MAX_PER_PEER: usize = 4;

/// Only the four the protocol has. An unknown path never reaches the answerer,
/// so a scanner sweeping the shop's network cannot use this to find out
/// anything except that something is listening.
pub const PATHS: [&str; 4] = ["/pair", "/hello", "/fetch", "/offer"];

/// The one path that is answered unsigned.
pub const PAIR_PATH: &str = "/pair";

/// The header a signed request carries its signature in.
///
/// Must match what `syncClient.ts` sends and `syncFetch.ts` reads.
pub const AUTH_HEADER: &str = "x-shopos-auth";

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

/// Why a request was turned away before it reached the answerer.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Not the HTTP a till sends.
    Malformed,
    /// A path the protocol does not have.
    NoSuchRequest,
    /// Anything but `/pair` with no signature at all. The code is the one
    /// `syncAuth.verify` gives a missing header, so a caller hears the same
    /// thing whichever side said it.
    Unsigned,
    /// A body larger than that request can honestly be.
    TooLarge,
}

impl Refusal {
    pub fn reply(&self) -> Reply {
        match self {
            Refusal::Malformed => Reply::refuse(400, "MALFORMED"),
            Refusal::NoSuchRequest => Reply::refuse(404, "NO_SUCH_REQUEST"),
            Refusal::Unsigned => Reply::refuse(401, "MALFORMED"),
            Refusal::TooLarge => Reply::refuse(413, "TOO_LARGE"),
        }
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
    let active = Arc::new(AtomicUsize::new(0));
    let peers = Peers::default();

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) => {
                    // Dropped, which closes it, when either limit is reached. A
                    // 503 would need a write that can itself be made to wait.
                    let Some(slot) = Slot::take(&active) else { continue };
                    let Some(peer) = stream.peer_addr().ok().and_then(|a| peers.take(a.ip())) else {
                        continue;
                    };
                    let answerer = Arc::clone(&answerer);
                    std::thread::spawn(move || {
                        let _held = (slot, peer);
                        let _ = handle(answerer.as_ref(), stream);
                    });
                }
                /* A pause rather than straight round again. The errors
                   `accept` gives are mostly "out of something" -- handles,
                   memory, buffers -- and retrying at once spins a core at
                   full tilt on a till that is already short of whatever it
                   ran out of. */
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });

    Ok(Bound { port: bound, stop })
}

/// One of `MAX_CONNECTIONS`, given back when the thread holding it ends --
/// however it ends, which is why it is a drop and not a line at the bottom.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(active: &Arc<AtomicUsize>) -> Option<Slot> {
        let taken = active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_CONNECTIONS).then_some(n + 1))
            .is_ok();
        taken.then(|| Slot(Arc::clone(active)))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Connections in flight, by the address they came from.
#[derive(Default, Clone)]
struct Peers(Arc<Mutex<HashMap<IpAddr, usize>>>);

impl Peers {
    fn take(&self, ip: IpAddr) -> Option<PeerSlot> {
        let mut open = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(ip).or_insert(0);
        if *count >= MAX_PER_PEER {
            return None;
        }
        *count += 1;
        Some(PeerSlot { peers: self.clone(), ip })
    }
}

/// One of `MAX_PER_PEER`, given back the same way a `Slot` is.
struct PeerSlot {
    peers: Peers,
    ip: IpAddr,
}

impl Drop for PeerSlot {
    fn drop(&mut self) {
        let mut open = self.peers.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.ip);
            }
        }
    }
}

/// The same, settling for any free port when the wanted one is taken.
///
/// A till that cannot have 7801 is still a till. The port it ends up on is
/// carried by everything that needs it -- the shout announces the one actually
/// bound, pairing advertises it in a header, and a peer is stored with its
/// address and port together -- so a second number is only a number, and the
/// screen says which one it got.
///
/// Without this, a shop whose 7801 is held by something else has a sync that
/// can never be turned on, and two tills on one machine is a collision with
/// nothing to be done about it. If an ephemeral port will not bind either, the
/// first refusal is the one returned: it names the port the shop and whoever
/// wrote its firewall rule are expecting.
pub fn serve_preferring(port: u16, answerer: Arc<dyn Answerer>) -> Result<Bound, String> {
    match serve(port, Arc::clone(&answerer)) {
        Ok(bound) => Ok(bound),
        Err(taken) => serve(0, answerer).map_err(|_| taken),
    }
}

fn handle(answerer: &dyn Answerer, mut stream: TcpStream) -> std::io::Result<()> {
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let remote = stream.peer_addr().ok().map(|a| a.ip().to_string());

    let started = Instant::now();
    match read_checked(&stream, remote, started + HEAD_DEADLINE, started + REQUEST_DEADLINE) {
        Ok(Ok(request)) => {
            let reply = answerer.answer(request);
            write_response(&mut stream, reply.status, &reply.body)
        }
        Ok(Err(refusal)) => {
            let reply = refusal.reply();
            write_response(&mut stream, reply.status, &reply.body)?;
            linger(&mut stream);
            Ok(())
        }
        Err(_) => Ok(()),
    }
}

/// Lets a refused caller read its refusal.
///
/// A socket closed with unread bytes in it is reset rather than closed, and a
/// reset can overtake the reply: the caller sees "connection reset" instead of
/// the 401 that would have told it what was wrong. So the write side is shut,
/// and a little of whatever is still arriving is read and thrown away -- a
/// little, and briefly, because this is exactly where a hostile caller would
/// like to be kept talking.
fn linger(stream: &mut TcpStream) {
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = std::io::copy(&mut stream.take(64 * 1024), &mut std::io::sink());
}

/// A socket that will not let a read outlast `deadline`.
///
/// Each read is given the smaller of `idle` and whatever is left of the
/// deadline, so the deadline holds however the bytes are paced.
pub(crate) struct Timed<'s> {
    pub(crate) stream: &'s TcpStream,
    pub(crate) deadline: Instant,
    /// The longest one read may wait for its first byte.
    pub(crate) idle: Duration,
}

impl Read for Timed<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the request took longer than any till's does",
            ));
        }
        self.stream.set_read_timeout(Some(left.min(self.idle)))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

/// Enough HTTP/1.1 for four POSTs carrying JSON, and deliberately not a byte
/// more. Everything it does not understand is a refusal rather than a guess.
///
/// `None` for anything refused; `read_checked` says why.
pub fn read_request(
    stream: &mut TcpStream,
    remote_address: Option<String>,
) -> std::io::Result<Option<Request>> {
    let started = Instant::now();
    Ok(read_checked(stream, remote_address, started + HEAD_DEADLINE, started + REQUEST_DEADLINE)?.ok())
}

/// The request, or why it was refused, or an I/O error for a caller that went
/// away or ran out of time -- which gets no answer at all.
///
/// The order is the point. Path and signature are looked at as soon as the
/// head is in, and the body is only read for a request that has got that far:
/// an unsigned `/offer` claiming thirty-two megabytes is refused having cost
/// sixteen kilobytes of head and nothing else.
pub fn read_checked(
    stream: &TcpStream,
    remote_address: Option<String>,
    head_deadline: Instant,
    deadline: Instant,
) -> std::io::Result<Result<Request, Refusal>> {
    let mut reader = BufReader::new(Timed {
        stream,
        deadline: head_deadline.min(deadline),
        idle: READ_TIMEOUT,
    });
    // The head is read through a ceiling; the body has its own, `MAX_BODY`.
    let mut head = (&mut reader).take(MAX_HEAD);

    let mut line = String::new();
    if head.read_line(&mut line)? == 0 || !line.ends_with('\n') {
        return Ok(Err(Refusal::Malformed));
    }

    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method != "POST" || !path.starts_with('/') {
        return Ok(Err(Refusal::Malformed));
    }

    let mut length: Option<usize> = None;
    let mut auth: Option<String> = None;
    let mut listen_port: Option<u16> = None;

    loop {
        let mut header = String::new();
        // A line cut off by the ceiling has no newline, and is not a header.
        if head.read_line(&mut header)? == 0 || !header.ends_with('\n') {
            return Ok(Err(Refusal::Malformed));
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Ok(Err(Refusal::Malformed));
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse::<usize>().ok(),
            AUTH_HEADER => auth = Some(value.to_string()).filter(|v| !v.is_empty()),
            LISTEN_PORT_HEADER => listen_port = value.parse::<u16>().ok(),
            _ => {}
        }
    }

    if !PATHS.contains(&path.as_str()) {
        return Ok(Err(Refusal::NoSuchRequest));
    }
    let pairing = path == PAIR_PATH;
    if !pairing && auth.is_none() {
        return Ok(Err(Refusal::Unsigned));
    }

    // No length, no body, no guessing. Chunked encoding is not something a till
    // sends, and accepting it would be a parser nobody needs.
    let Some(length) = length else {
        return Ok(Err(Refusal::Malformed));
    };
    if length > if pairing { MAX_PAIR_BODY } else { MAX_BODY } {
        return Ok(Err(Refusal::TooLarge));
    }

    /* Read as it arrives, into a buffer that grows with what has actually been
       sent. It used to be allocated in full from the header -- thirty-two
       megabytes on the strength of one line of text, sixteen connections at a
       time, from anybody. */
    reader.get_mut().deadline = deadline;
    let mut body = Vec::with_capacity(length.min(64 * 1024));
    reader.take(length as u64).read_to_end(&mut body)?;
    if body.len() != length {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the caller went away before the body arrived",
        ));
    }

    match String::from_utf8(body) {
        Ok(body) => Ok(Ok(Request { path, body, auth, remote_address, listen_port })),
        Err(_) => Ok(Err(Refusal::Malformed)),
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
        413 => "Payload Too Large",
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
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

pub use crate::client::{lan_address, request, Answer};
#[cfg(test)]
use crate::client::{literal, read_answer, MAX_REPLY_HEADERS};

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    /// What `read_checked` makes of `raw`, sent whole over a real socket.
    fn checked(raw: &str) -> Result<Request, Refusal> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let raw = raw.to_string();

        let sender = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            client.write_all(raw.as_bytes()).unwrap();
            client.flush().unwrap();
            // Held open: the body read must not race the socket closing.
            std::thread::sleep(Duration::from_millis(50));
        });

        let (stream, _) = listener.accept().unwrap();
        let now = Instant::now();
        let parsed = read_checked(&stream, None, now + HEAD_DEADLINE, now + REQUEST_DEADLINE).unwrap();
        sender.join().unwrap();
        parsed
    }

    fn request_from(raw: &str) -> Option<Request> {
        checked(raw).ok()
    }

    fn post(path: &str, body: &str, extra: &str) -> String {
        format!(
            "POST {path} HTTP/1.1\r\nhost: x\r\n{extra}content-length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    const SIGNED: &str = "x-shopos-auth: device.1700000000000.abc123.deadbeef\r\n";

    #[test]
    fn reads_a_post_with_a_body() {
        let parsed = request_from(&post("/pair", "{\"a\":1}", "")).unwrap();
        assert_eq!(parsed.path, "/pair");
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
        let raw = format!("POST /hello HTTP/1.1\r\nhost: x\r\n{SIGNED}\r\n{{\"a\":1}}");
        assert_eq!(checked(&raw).err(), Some(Refusal::Malformed));
    }

    #[test]
    fn refuses_a_body_larger_than_any_till_would_send() {
        let raw = format!(
            "POST /offer HTTP/1.1\r\n{SIGNED}content-length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert_eq!(checked(&raw).err(), Some(Refusal::TooLarge));
    }

    #[test]
    fn refuses_a_header_that_is_not_a_header() {
        let raw = "POST /hello HTTP/1.1\r\nthis is not a header\r\ncontent-length: 0\r\n\r\n";
        assert!(request_from(raw).is_none());
    }

    #[test]
    fn refuses_a_head_longer_than_any_till_sends() {
        let padding = "a".repeat(MAX_HEAD as usize);
        let raw = format!("POST /pair HTTP/1.1\r\nx-padding: {padding}\r\ncontent-length: 0\r\n\r\n");
        assert!(request_from(&raw).is_none());
    }

    #[test]
    fn gives_a_connection_slot_back_when_it_is_done() {
        let active = Arc::new(AtomicUsize::new(0));
        let held: Vec<Slot> = (0..MAX_CONNECTIONS).filter_map(|_| Slot::take(&active)).collect();
        assert_eq!(held.len(), MAX_CONNECTIONS);
        assert!(Slot::take(&active).is_none());
        drop(held);
        assert!(Slot::take(&active).is_some());
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
                    format!("POST /offer HTTP/1.1\r\n{SIGNED}content-length: {}\r\n\r\n", body.len()).as_bytes(),
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
        let raw = post("/pair", "{}", "x-shopos-port: 7801\r\n");
        assert_eq!(request_from(&raw).unwrap().listen_port, Some(7801));
    }

    #[test]
    fn treats_a_port_that_is_not_a_port_as_absent() {
        for value in ["0x1", "-1", "99999", "", "seven"] {
            let raw = post("/pair", "{}", &format!("x-shopos-port: {value}\r\n"));
            let parsed = request_from(&raw).unwrap();
            assert_eq!(parsed.listen_port, None, "{value} should not parse");
        }
    }

    #[test]
    fn carries_the_callers_address_from_the_socket_and_not_a_header() {
        /* A header is whatever the caller wants it to be. The address has to
           come from the connection, or a till could point the shop's next sync
           at a machine of its choosing. */
        let raw = post("/pair", "{}", "x-forwarded-for: 10.0.0.1\r\n");
        let parsed = request_from(&raw).unwrap();
        assert_eq!(parsed.remote_address, None);
    }

    // ── What is refused before anybody has proved anything ────────────────

    /* Every one of these used to be read in full, handed to the webview, and
       only then turned away by the signature check. */

    #[test]
    fn an_unsigned_request_is_refused_before_its_body_is_read() {
        for path in ["/hello", "/fetch", "/offer"] {
            assert_eq!(checked(&post(path, "{}", "")).err(), Some(Refusal::Unsigned), "{path}");
            // An empty signature is no signature.
            assert_eq!(checked(&post(path, "{}", "x-shopos-auth: \r\n")).err(), Some(Refusal::Unsigned));
        }
        // The claim of thirty-two megabytes is never acted on: nothing follows
        // the head, and it is refused all the same, at once.
        let raw = format!("POST /offer HTTP/1.1\r\ncontent-length: {MAX_BODY}\r\n\r\n");
        assert_eq!(checked(&raw).err(), Some(Refusal::Unsigned));
        // And it says so in the words the webview would have used.
        assert_eq!(Refusal::Unsigned.reply().status, 401);
        assert_eq!(Refusal::Unsigned.reply().body, "{\"code\":\"MALFORMED\"}");
    }

    /// Pairing stays reachable without a signature, because it is the request
    /// that agrees one.
    #[test]
    fn pairing_is_answered_unsigned_and_held_to_the_size_of_a_pairing() {
        assert!(checked(&post("/pair", "{\"code\":\"ABC-123\"}", "")).is_ok());

        let big = "x".repeat(MAX_PAIR_BODY + 1);
        assert_eq!(checked(&post("/pair", &big, "")).err(), Some(Refusal::TooLarge));
        let fits = "x".repeat(MAX_PAIR_BODY);
        assert!(checked(&post("/pair", &fits, "")).is_ok());
    }

    #[test]
    fn an_unknown_path_is_refused_from_its_head_alone() {
        let raw = format!("POST /admin HTTP/1.1\r\n{SIGNED}content-length: 1000000\r\n\r\n");
        assert_eq!(checked(&raw).err(), Some(Refusal::NoSuchRequest));
    }

    /// Slowloris: a byte just inside every read timeout, for ever. The whole
    /// head has a deadline, and it holds.
    #[test]
    fn a_caller_that_trickles_its_head_is_cut_off_at_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);

        let sender = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            let _ = client.write_all(b"POST /pair HTTP/1.1\r\n");
            while !stopping.load(Ordering::SeqCst) {
                if client.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });

        let (stream, _) = listener.accept().unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(400);
        let result = read_checked(&stream, None, deadline, started + REQUEST_DEADLINE);
        stop.store(true, Ordering::SeqCst);
        sender.join().unwrap();

        assert!(result.is_err(), "a head that never finishes must end in an error");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    /// The same for a body: the deadline covers the whole request, not each
    /// read of it.
    #[test]
    fn a_caller_that_trickles_its_body_is_cut_off_at_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);

        let sender = std::thread::spawn(move || {
            let mut client = TcpStream::connect(address).unwrap();
            let _ = client.write_all(format!("POST /offer HTTP/1.1\r\n{SIGNED}content-length: 100000\r\n\r\n").as_bytes());
            while !stopping.load(Ordering::SeqCst) {
                if client.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });

        let (stream, _) = listener.accept().unwrap();
        let started = Instant::now();
        let result = read_checked(&stream, None, started + HEAD_DEADLINE, started + Duration::from_millis(500));
        stop.store(true, Ordering::SeqCst);
        sender.join().unwrap();

        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    /// One machine cannot take every connection the till has.
    #[test]
    fn one_address_cannot_hold_every_connection() {
        let peers = Peers::default();
        let one: IpAddr = "192.168.1.50".parse().unwrap();
        let other: IpAddr = "192.168.1.51".parse().unwrap();

        let held: Vec<PeerSlot> = (0..MAX_PER_PEER).filter_map(|_| peers.take(one)).collect();
        assert_eq!(held.len(), MAX_PER_PEER);
        assert!(peers.take(one).is_none(), "a fifth from the same machine is turned away");
        assert!(peers.take(other).is_some(), "while the other till still gets in");

        drop(held);
        assert!(peers.take(one).is_some(), "and the slots come back when the connections end");
    }

    /// End to end over a real listener: a flood of unsigned requests is
    /// answered 401 at the door and never reaches whatever is answering.
    #[test]
    fn an_unsigned_request_never_reaches_the_answerer() {
        let (bound, recorder) = answering(200, "{}");
        let address = format!("127.0.0.1:{}", bound.port);

        let answer = request(&address, "/offer", "{\"rows\":[]}", None, None).unwrap();
        assert_eq!(answer.status, 401);
        assert_eq!(answer.body, "{\"code\":\"MALFORMED\"}");
        assert!(recorder.seen.lock().unwrap().is_none(), "the webview must not have been woken");

        let answer = request(&address, "/nowhere", "{}", Some("signed"), None).unwrap();
        assert_eq!(answer.status, 404);
        bound.stop();
    }

    // ── The asking half ────────────────────────────────────────────────────

    /* The asking half, against the answering one. Both sides are hand-written
       here, so a round trip is the test that matters: a client that agreed with
       nothing but itself would pass every test above and reach no till. */

    struct Recorder {
        seen: std::sync::Mutex<Option<Request>>,
        status: u16,
        body: String,
    }

    impl Answerer for Arc<Recorder> {
        fn answer(&self, request: Request) -> Reply {
            *self.seen.lock().unwrap() = Some(request);
            Reply { status: self.status, body: self.body.clone() }
        }
    }

    fn answering(status: u16, body: &str) -> (Bound, Arc<Recorder>) {
        let recorder = Arc::new(Recorder {
            seen: std::sync::Mutex::new(None),
            status,
            body: body.to_string(),
        });
        let bound = serve(0, Arc::new(Arc::clone(&recorder))).unwrap();
        (bound, recorder)
    }

    #[test]
    fn asks_a_till_and_reads_what_it_said() {
        let (bound, recorder) = answering(200, "{\"upTo\":41}");
        let address = format!("127.0.0.1:{}", bound.port);

        let answer = request(&address, "/offer", "{\"rows\":[]}", Some("signed"), Some(7801))
            .unwrap();
        bound.stop();

        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, "{\"upTo\":41}");

        let seen = recorder.seen.lock().unwrap();
        let seen = seen.as_ref().expect("the till should have been asked");
        assert_eq!(seen.path, "/offer");
        assert_eq!(seen.body, "{\"rows\":[]}");
        assert_eq!(seen.auth.as_deref(), Some("signed"));
        assert_eq!(seen.listen_port, Some(7801));
    }

    #[test]
    fn sends_a_body_larger_than_one_packet_whole() {
        let (bound, recorder) = answering(200, "{}");
        let address = format!("127.0.0.1:{}", bound.port);
        let body = "x".repeat(200_000);

        request(&address, "/offer", &body, Some("signed"), None).unwrap();
        bound.stop();

        let seen = recorder.seen.lock().unwrap();
        assert_eq!(seen.as_ref().unwrap().body.len(), body.len());
    }

    #[test]
    fn brings_a_refusal_back_rather_than_failing() {
        // A till that says no has answered. Only one that cannot be reached at
        // all is an error, because the screen words the two differently.
        let (bound, _) = answering(401, "{\"code\":\"BAD_SIGNATURE\"}");
        let address = format!("127.0.0.1:{}", bound.port);

        let answer = request(&address, "/fetch", "{}", Some("wrong"), None).unwrap();
        bound.stop();

        assert_eq!(answer.status, 401);
        assert_eq!(answer.body, "{\"code\":\"BAD_SIGNATURE\"}");
    }

    #[test]
    fn says_which_till_it_could_not_reach() {
        // The port is bound and then dropped, so it is certainly nobody's.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("127.0.0.1:{}", closed.local_addr().unwrap().port());
        drop(closed);

        let refused = request(&address, "/hello", "{}", Some("signed"), None).unwrap_err();
        assert!(refused.contains(&address), "{refused}");
    }

    #[test]
    fn takes_another_port_when_the_one_it_wanted_is_taken() {
        // Two tills on one machine, which is a developer's laptop and also a
        // shop whose 7801 belongs to something else.
        let (first, _) = answering(200, "{}");
        let second = serve_preferring(first.port, Arc::new(Arc::new(Recorder {
            seen: std::sync::Mutex::new(None),
            status: 200,
            body: "{}".into(),
        })))
        .unwrap();

        assert_ne!(second.port, first.port);
        assert_ne!(second.port, 0, "it should report the port it actually got");

        // And it is a till, not just a bound socket: it answers.
        let address = format!("127.0.0.1:{}", second.port);
        assert_eq!(request(&address, "/hello", "{}", Some("signed"), None).unwrap().status, 200);

        first.stop();
        second.stop();
    }

    #[test]
    fn keeps_the_port_it_asked_for_when_nothing_holds_it() {
        // The shop's case, and the one a firewall rule is written for.
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);

        let bound = serve_preferring(port, Arc::new(Arc::new(Recorder {
            seen: std::sync::Mutex::new(None),
            status: 200,
            body: "{}".into(),
        })))
        .unwrap();
        assert_eq!(bound.port, port);
        bound.stop();
    }

    #[test]
    fn leaves_out_the_headers_it_was_given_nothing_for() {
        /* A till that is not listening sends no port, and pairing sends no
           signature. Sending the header empty instead would have the far side
           record an address of nowhere. */
        let (bound, recorder) = answering(200, "{}");
        let address = format!("127.0.0.1:{}", bound.port);

        request(&address, "/pair", "{}", None, None).unwrap();
        bound.stop();

        let seen = recorder.seen.lock().unwrap();
        let seen = seen.as_ref().unwrap();
        assert_eq!(seen.auth, None);
        assert_eq!(seen.listen_port, None);
    }

    /// A name would be looked up through a resolver that can block for half a
    /// minute and has a say in where the bills go. Numbers only.
    #[test]
    fn a_till_is_asked_by_number_and_never_by_name() {
        assert_eq!(literal("192.168.1.20:7801").unwrap(), "192.168.1.20:7801".parse().unwrap());
        assert_eq!(literal("[::1]:7801").unwrap(), "[::1]:7801".parse().unwrap());
        // `URL.host` drops a default port.
        assert_eq!(literal("192.168.1.20").unwrap().port(), 80);

        for name in ["localhost:7801", "till-a:7801", "example.com", "", "192.168.1:7801"] {
            let said = literal(name).unwrap_err();
            assert!(said.contains("by its number"), "{name}: {said}");
        }
    }

    /// A reply read by `read_answer` from whatever `raw` is.
    fn answer_from(raw: Vec<u8>) -> std::io::Result<Answer> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let replier = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(&raw);
            let _ = stream.shutdown(Shutdown::Write);
            std::thread::sleep(Duration::from_millis(100));
        });
        let stream = TcpStream::connect(address).unwrap();
        let got = read_answer(&stream, Instant::now() + Duration::from_secs(5));
        replier.join().unwrap();
        got
    }

    /* Whatever has the address of a till gets to write the reply, and the
       asking side used to read its head without any ceiling at all. */

    #[test]
    fn a_reply_with_a_head_that_never_ends_is_refused() {
        let mut raw = b"HTTP/1.1 200 OK\r\nx-padding: ".to_vec();
        raw.extend(vec![b'a'; MAX_HEAD as usize]);
        assert!(answer_from(raw).is_err());
    }

    #[test]
    fn a_reply_with_endless_headers_is_refused() {
        let mut raw = b"HTTP/1.1 200 OK\r\n".to_vec();
        for i in 0..(MAX_REPLY_HEADERS + 1) {
            raw.extend_from_slice(format!("x-{i}: y\r\n").as_bytes());
        }
        raw.extend_from_slice(b"content-length: 2\r\n\r\n{}");
        assert!(answer_from(raw).is_err());
    }

    #[test]
    fn a_reply_that_claims_more_than_any_till_sends_is_refused() {
        let raw = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{{}}", MAX_BODY + 1).into_bytes();
        assert!(answer_from(raw).is_err());
        // And one that stops short of what it claimed is not taken as whole.
        let raw = b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{}".to_vec();
        assert!(answer_from(raw).is_err());
    }

    #[test]
    fn an_ordinary_reply_is_read() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"upTo\":41}".to_vec();
        let answer = answer_from(raw).unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, "{\"upTo\":41}");
    }

    /// A far side that says nothing at all is given up on at the deadline.
    #[test]
    fn a_reply_that_never_comes_is_given_up_on_at_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let silent = std::thread::spawn(move || {
            let held = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            drop(held);
        });
        let stream = TcpStream::connect(address).unwrap();
        let started = Instant::now();
        assert!(read_answer(&stream, started + Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_millis(1400));
        silent.join().unwrap();
    }
}
