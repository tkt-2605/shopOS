//! The asking half: one request to another till, and its answer.
//!
//! Apart from `http.rs`, which answers, because the two share a wire format and
//! nothing else -- the server's limits are about strangers on the shop's wifi,
//! the client's about a till that has gone quiet mid-reply -- and a change to
//! one should not have to be read past the other.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};

use crate::http::{Timed, AUTH_HEADER, LISTEN_PORT_HEADER, MAX_BODY, MAX_HEAD, READ_TIMEOUT};

/// What a till said when it was asked something.
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub body: String,
}

/// How long to wait for a till that is switched off but whose address still
/// resolves. Short, because a person is watching a spinner while it runs.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long an asking till waits, all told, for its answer.
///
/// It must be longer than `ANSWER_TIMEOUT` in the app's `sync_server.rs`, which
/// is how long the far side waits for its own webview to finish a merge --
/// timeouts grow outward, and the caller is the outermost. It used to be a
/// thirty-second timeout per read, which on a merge that legitimately took a
/// minute gave up on an answer that was on its way.
const ASK_DEADLINE: Duration = Duration::from_secs(150);

/// How many header lines a reply may have. A till sends four.
pub(crate) const MAX_REPLY_HEADERS: usize = 64;

/// Where to knock, as a literal address and nothing else.
///
/// A name would be looked up through the system resolver, which blocks for as
/// long as it likes -- thirty seconds and more on a shop PC whose DNS is a
/// router that has lost its line -- and hands whoever answers the lookup a say
/// in which machine receives the shop's bills. Tills are found by discovery and
/// stored by number, so a number is all this needs to accept.
pub(crate) fn literal(address: &str) -> Result<SocketAddr, String> {
    let address = address.trim();
    if let Ok(socket) = address.parse::<SocketAddr>() {
        return Ok(socket);
    }
    // `URL.host` leaves the port off when it is the scheme's default.
    if let Ok(ip) = address.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, 80));
    }
    Err(format!(
        "{address} is not an address this machine can use. A till is reached by its number, like 192.168.1.20:7801."
    ))
}

/// The asking half, in Rust rather than in the webview.
///
/// The webview cannot make this call itself. The app's CSP takes `connect-src`
/// from `default-src 'self'`, so a `fetch` aimed at another till is refused
/// before a packet leaves -- which is the rule the program is built on, that
/// network code lives here. `syncClient.ts` takes the fetch it uses as an
/// argument for exactly this reason: the app hands it one that arrives here.
///
/// Enough HTTP/1.1 for the POSTs in `PATHS` and deliberately not a byte
/// more, which is the same bargain `read_request` makes on the other side.
pub fn request(
    address: &str,
    path: &str,
    body: &str,
    auth: Option<&str>,
    listen_port: Option<u16>,
) -> Result<Answer, String> {
    let resolved = literal(address)?;

    let mut stream = TcpStream::connect_timeout(&resolved, CONNECT_TIMEOUT)
        .map_err(|e| format!("Could not reach {address}: {e}"))?;
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));

    let mut head = format!(
        "POST {path} HTTP/1.1\r\n\
         host: {address}\r\n\
         content-type: application/json\r\n\
         content-length: {}\r\n\
         connection: close\r\n",
        body.len()
    );
    if let Some(auth) = auth {
        head.push_str(&format!("{AUTH_HEADER}: {auth}\r\n"));
    }
    if let Some(port) = listen_port {
        head.push_str(&format!("{LISTEN_PORT_HEADER}: {port}\r\n"));
    }
    head.push_str("\r\n");

    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body.as_bytes()))
        .and_then(|()| stream.flush())
        .map_err(|e| format!("Could not send to {address}: {e}"))?;

    read_answer(&stream, Instant::now() + ASK_DEADLINE).map_err(|e| format!("No answer from {address}: {e}"))
}

fn invalid(what: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, what.to_string())
}

/// The reply, read under the same ceilings the server side reads under.
///
/// The asking till is on the other end of the same wifi, and a machine that
/// has taken over a till's address can answer with a header that never ends or
/// a body that never stops. So: a limit on the head, a limit on how many lines
/// it has, a limit on the body, and a deadline for the lot.
pub(crate) fn read_answer(stream: &TcpStream, deadline: Instant) -> std::io::Result<Answer> {
    // No idle limit short of the deadline: the far side says nothing at all
    // until its webview has finished the merge, which is the whole wait.
    let mut reader = BufReader::new(Timed { stream, deadline, idle: ASK_DEADLINE });
    let mut head = (&mut reader).take(MAX_HEAD);

    let mut line = String::new();
    if head.read_line(&mut line)? == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the connection closed before anything was said",
        ));
    }
    if !line.ends_with('\n') {
        return Err(invalid("the reply's first line never ended"));
    }

    // "HTTP/1.1 200 OK" -- the middle word is the whole of what matters.
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| invalid("not an HTTP reply"))?;

    let mut length: Option<usize> = None;
    let mut lines = 0;
    loop {
        let mut header = String::new();
        if head.read_line(&mut header)? == 0 {
            break;
        }
        if !header.ends_with('\n') {
            return Err(invalid("the reply's head is longer than any till sends"));
        }
        lines += 1;
        if lines > MAX_REPLY_HEADERS {
            return Err(invalid("the reply has more headers than any till sends"));
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }

    /* The far side always sends a length and closes after the body. Reading to
       the end when it does not is the reply of a till, not of a parser that
       guesses: `connection: close` is what makes the end unambiguous. */
    let mut body = Vec::new();
    match length {
        Some(length) if length > MAX_BODY => {
            return Err(invalid("the reply is larger than any till sends"));
        }
        Some(length) => {
            reader.take(length as u64).read_to_end(&mut body)?;
            if body.len() != length {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the reply stopped before its body was complete",
                ));
            }
        }
        None => {
            reader.take(MAX_BODY as u64 + 1).read_to_end(&mut body)?;
            if body.len() > MAX_BODY {
                return Err(invalid("the reply is larger than any till sends"));
            }
        }
    }

    let body = String::from_utf8(body).map_err(|_| invalid("the reply is not text"))?;
    Ok(Answer { status, body })
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
