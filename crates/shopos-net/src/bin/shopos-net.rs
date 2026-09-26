/// The networking half of a till, on its own, for the test bench's containers.
///
/// Two jobs, matching the two things Layer 2 exists to prove:
///
/// `answer`  — listen on the sync port, announce on the discovery port, and
///             forward every request to a `virtual-till` on localhost. The
///             container runs the two side by side: Node holds the database and
///             the protocol, this holds the sockets.
///
/// `look-around` — shout, and print what answers. This is the assertion Layer 2
///             is built for: a till on `shop-a` must find the other till on
///             `shop-a` and must **not** find the one on `shop-b`. Loopback
///             cannot prove that, because UDP broadcast across separate network
///             namespaces is exactly the thing a single host does not exercise.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use shopos_net::discovery::{look_around, respond_while, Announcement};
use shopos_net::http::{self, Answerer, Reply, Request};

const USAGE: &str = "\
shopos-net answer --port N --sync-port N --device ID [--label L] [--shop S] [--shop-id I]
shopos-net look-around [--timeout MS] [--device ID]

  answer       listen on --port and forward to a virtual-till on --sync-port
  look-around  shout on the discovery port and print what answers, as JSON
               --device drops this till's own reply, as the app does
";

/// Answers by handing the request to the Node till beside it.
///
/// A second implementation of the protocol in Rust would drift from the
/// TypeScript one, and the drift would surface as two tills agreeing about
/// everything except the row that matters. So this does what the app does —
/// carries bytes to whatever holds the database — and the container's till is
/// the same `virtual-till` the in-process scenarios use.
struct ToVirtualTill {
    port: u16,
}

impl Answerer for ToVirtualTill {
    fn answer(&self, request: Request) -> Reply {
        match forward(self.port, &request) {
            Ok(reply) => reply,
            // The till beside it is not up, or died mid-request. The caller is
            // told to come back, exactly as the app does when its webview is
            // busy — never a 500, which reads as "the protocol went wrong".
            Err(_) => Reply::refuse(503, "NOT_READY"),
        }
    }
}

fn forward(port: u16, request: &Request) -> std::io::Result<Reply> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;

    let mut head = format!(
        "POST {} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n\
         content-length: {}\r\n",
        request.path,
        request.body.len()
    );
    if let Some(auth) = &request.auth {
        head.push_str(&format!("x-shopos-auth: {auth}\r\n"));
    }
    /* Carried through rather than re-derived. The till behind this binary has
       no socket of its own to the real caller, so if this did not pass the
       caller's address on, the joining till would be recorded with no address
       and the host could never start a sync with it — the whole bug Layer 1
       proves in `host-initiates.test.ts`. */
    if let Some(remote) = &request.remote_address {
        head.push_str(&format!("x-shopos-remote: {remote}\r\n"));
    }
    if let Some(listen) = request.listen_port {
        head.push_str(&format!("{}: {listen}\r\n", http::LISTEN_PORT_HEADER));
    }
    head.push_str("connection: close\r\n\r\n");

    stream.write_all(head.as_bytes())?;
    stream.write_all(request.body.as_bytes())?;
    stream.flush()?;

    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    Ok(parse_response(&raw))
}

/// Just enough of a response to carry the status and the JSON back.
///
/// Including the de-chunking, which is not optional however tidy the till is.
/// Node adds `Transfer-Encoding: chunked` to any response with no declared
/// length, and that is invisible to `fetch` — so Layer 1 never saw it, and the
/// first pairing inside a container came back as `d7\r\n{"secret":...` and
/// failed to parse. The till now sends `content-length`; this still handles the
/// other case, because a forwarder that works only against one cooperative
/// server breaks the next time somebody changes it.
fn parse_response(raw: &str) -> Reply {
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);

    let Some((head, body)) = raw.split_once("\r\n\r\n") else {
        return Reply { status, body: String::new() };
    };

    let chunked = head.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("transfer-encoding:") && line.contains("chunked")
    });

    Reply { status, body: if chunked { dechunk(body) } else { body.to_string() } }
}

/// `<size in hex>\r\n<bytes>\r\n`, repeated, ending at a zero-length chunk.
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;

    while let Some((size, after)) = rest.split_once("\r\n") {
        let size = size.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size, 16) else { break };
        if size == 0 || after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        rest = after[size..].trim_start_matches("\r\n");
    }
    out
}

fn arg(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    args.iter().position(|a| a == &flag).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("");

    match command {
        "answer" => {
            let Some(device) = arg(&args, "device") else {
                eprintln!("shopos-net: missing --device\n\n{USAGE}");
                std::process::exit(2);
            };
            let port: u16 = arg(&args, "port").and_then(|p| p.parse().ok()).unwrap_or(7801);
            let sync_port: u16 =
                arg(&args, "sync-port").and_then(|p| p.parse().ok()).unwrap_or(7803);

            let bound = match http::serve(port, Arc::new(ToVirtualTill { port: sync_port })) {
                Ok(bound) => bound,
                Err(why) => {
                    eprintln!("shopos-net: {why}");
                    std::process::exit(1);
                }
            };

            let found = respond_while(
                Announcement {
                    v: 1,
                    device: device.clone(),
                    label: arg(&args, "label").unwrap_or(device),
                    shop: arg(&args, "shop"),
                    shop_id: arg(&args, "shop-id"),
                    port: bound.port,
                    // In a container this is the address on the bench's network,
                    // which is the one the other containers dial.
                    host: http::lan_address(),
                },
                bound.stop_flag(),
            );
            // Answering without being findable is still answering; the bench
            // will say which half is missing.
            if let Err(why) = found {
                eprintln!("shopos-net: {why}");
            }

            // One line, parseable, so `run.sh` can wait for readiness rather
            // than sleeping and hoping.
            println!("{{\"ok\":true,\"port\":{}}}", bound.port);

            // Nothing else to do. The listener and the responder are on their
            // own threads; this one parks until the container is stopped.
            loop {
                std::thread::park();
            }
        }

        "look-around" => {
            let wait = arg(&args, "timeout").and_then(|t| t.parse::<u64>().ok()).unwrap_or(3_000);
            let me = arg(&args, "device");
            match look_around(Duration::from_millis(wait)) {
                Ok(mut found) => {
                    /* A till answers its own broadcast, because the responder
                       has no way to recognise the asker — they are different
                       sockets. The app drops its own reply in the webview,
                       which knows what machine it is; here the caller says so
                       with `--device`. Without it a single-till shop looks like
                       a shop with a till to pair with, and the puzzle lands on
                       whoever is reading the screen. */
                    if let Some(me) = &me {
                        found.retain(|f| &f.device != me);
                    }
                    // JSON on stdout so `run.sh` asserts on it rather than on
                    // prose that a later edit would quietly reword.
                    match serde_json::to_string(&found) {
                        Ok(json) => println!("{json}"),
                        Err(e) => {
                            eprintln!("shopos-net: {e}");
                            std::process::exit(1);
                        }
                    }
                }
                Err(why) => {
                    eprintln!("shopos-net: {why}");
                    std::process::exit(1);
                }
            }
        }

        _ => {
            eprint!("{USAGE}");
            std::process::exit(if command.is_empty() { 1 } else { 2 });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_reply_with_a_declared_length() {
        let raw = "HTTP/1.1 200 OK\r\ncontent-length: 8\r\n\r\n{\"ok\":1}";
        let reply = parse_response(raw);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, "{\"ok\":1}");
    }

    #[test]
    fn reads_a_chunked_reply() {
        // What Node sends when nothing declares a length, and what broke the
        // first pairing inside a container.
        let raw = "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n8\r\n{\"ok\":1}\r\n0\r\n\r\n";
        let reply = parse_response(raw);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, "{\"ok\":1}");
    }

    #[test]
    fn reads_a_chunked_reply_that_arrived_in_several_chunks() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                   5\r\n{\"a\":\r\n2\r\n1,\r\n5\r\n\"b\":2\r\n1\r\n}\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).body, "{\"a\":1,\"b\":2}");
    }

    #[test]
    fn a_reply_with_no_body_is_not_a_panic() {
        assert_eq!(parse_response("HTTP/1.1 503 Service Unavailable\r\n").body, "");
        assert_eq!(parse_response("").status, 502);
    }
}
