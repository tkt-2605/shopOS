/// Finding the other till, so nobody has to read an IP address off a screen.
///
/// A shopkeeper should not have to know what 192.168.1.11 is, and asking them to
/// type it is asking them to get it wrong — the address also changes whenever the
/// router feels like it, which turns a one-off setup into a thing that breaks on
/// a Tuesday for no visible reason.
///
/// So a till that is answering also listens for a shout on the local network and
/// says where it is. A till looking for one shouts and collects the replies.
///
/// ── UDP broadcast rather than mDNS ────────────────────────────────────────
///
/// mDNS is the proper answer and it is a dependency, a second protocol, and a
/// service that Windows, routers and antivirus all have opinions about. What is
/// needed here is one question — "is there a ShopOS till on this wire?" — asked
/// across a single shop's network by at most a handful of machines. A broadcast
/// and a reply is the whole of it, in a file this size, with no crate.
///
/// ── What it gives away ────────────────────────────────────────────────────
///
/// The shop's name, its opaque id, and the port. Anybody already on the shop's
/// wifi could find the open port with a scanner in seconds, so this reveals no
/// access — and the shop's name is printed on every receipt it hands out.
///
/// What it does **not** do is grant anything. Finding a till tells you where to
/// knock; pairing still needs a code somebody reads off the screen, and every
/// request after that is signed. Discovery is a convenience laid on top of the
/// security, never part of it.
///
/// It answers **only while the till is answering HTTP**. A shop that has not
/// turned sync on is silent, and says nothing about itself to anyone.
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The port tills shout on. One above the one they talk on, so that a firewall
/// rule for "ShopOS" is two adjacent numbers rather than two unrelated ones.
///
/// Fixed, which is what makes it findable. Nothing in the tests below binds it —
/// they use `respond_on(0, ..)` and their own ephemeral ports, because sharing
/// this one made them stop each other's responder. The helper in the test module
/// carries that story.
pub const DISCOVERY_PORT: u16 = 7802;

/// Anything not beginning with this is somebody else's traffic, and is ignored
/// without a reply — a responder that answers everything is a responder that can
/// be pointed at a victim.
const PROBE: &[u8] = b"SHOPOS-WHO-IS-THERE/1";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Announcement {
    /// The protocol, so a later version can be told apart rather than misread.
    pub v: u8,
    /// Which machine this is. Lets a till ignore its own reply.
    pub device: String,
    /// What the machine calls itself, for a person choosing between two.
    pub label: String,
    /// The shop, so two shops on one network are not offered to each other.
    pub shop: Option<String>,
    pub shop_id: Option<String>,
    /// Where to knock.
    pub port: u16,
    /// Where this till believes it is, on the network the shop runs on.
    ///
    /// The asker used to take the address straight off the reply packet, which
    /// is right whenever the shout went out the way the shop's traffic does,
    /// and wrong on a machine with more than one card. A laptop with WSL on it
    /// answered from `172.24.224.1` — its Hyper-V switch — while listening on
    /// the wifi address it was showing on its own screen, so the till that
    /// found it was handed an address that went nowhere.
    ///
    /// Sent rather than deduced, because this side is the only one that can
    /// look at its own routing table. Optional and still checked: a till that
    /// does not send one, or sends something unusable, is reached at the packet
    /// address as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub address: String,
    pub device: String,
    pub label: String,
    pub shop: Option<String>,
    pub shop_id: Option<String>,
    pub port: u16,
}

/// Answers the shout, for as long as the flag says to.
///
/// Returns immediately; the work is on its own thread. The flag is the same one
/// the HTTP listener uses, so discovery and answering start and stop together
/// and there is no state where one is on without the other.
pub fn respond_while(announcement: Announcement, stop: Arc<AtomicBool>) {
    let _ = respond_on(DISCOVERY_PORT, announcement, stop);
}

/// The same, on a port of the caller's choosing, waiting until it is listening.
///
/// Two things the fixed-port version cannot give: a port that is certainly free,
/// and the knowledge that the socket is actually bound before anybody probes it.
/// Both matter to the tests below and to nothing else — UDP has no retransmit,
/// so a probe sent a millisecond early is simply lost, which is a timeout with
/// no explanation rather than a failure with one.
///
/// Returns the port it bound, or the reason it could not.
pub fn respond_on(
    port: u16,
    announcement: Announcement,
    stop: Arc<AtomicBool>,
) -> Result<u16, String> {
    let socket = UdpSocket::bind(("0.0.0.0", port))
        .map_err(|e| format!("Could not listen for tills on port {port}: {e}"))?;
    let bound = socket
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    spawn_responder(socket, announcement, stop);
    Ok(bound)
}

fn spawn_responder(socket: UdpSocket, announcement: Announcement, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        // So the loop notices the flag rather than blocking on recv for ever.
        let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));

        let reply = match serde_json::to_vec(&announcement) {
            Ok(reply) => reply,
            Err(_) => return,
        };

        let mut buffer = [0u8; 512];
        while !stop.load(Ordering::SeqCst) {
            match socket.recv_from(&mut buffer) {
                Ok((read, from)) => {
                    if buffer[..read].starts_with(PROBE) {
                        // Only ever back to whoever asked.
                        let _ = socket.send_to(&reply, from);
                    }
                }
                Err(_) => continue,
            }
        }
    });
}

/// Shouts, and collects whoever answers within `wait`.
pub fn look_around(wait: Duration) -> Result<Vec<Found>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", 0))
        .map_err(|e| format!("Could not open a socket to look with: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("This machine will not broadcast: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;

    /* Both the global broadcast and the one for this subnet. Windows and some
       routers drop one or the other, and which one is not knowable from here. */
    for target in broadcast_targets() {
        let _ = socket.send_to(PROBE, target);
    }

    let deadline = Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    let mut buffer = [0u8; 2048];

    while Instant::now() < deadline {
        match socket.recv_from(&mut buffer) {
            Ok((read, from)) => {
                let Ok(announcement) = serde_json::from_slice::<Announcement>(&buffer[..read])
                else {
                    continue;
                };
                if announcement.v != 1 {
                    continue;
                }
                // The same till answering both broadcasts is one till.
                if found.iter().any(|f| f.device == announcement.device) {
                    continue;
                }
                found.push(Found {
                    /* What the till says about itself, when it says anything
                       usable. The packet's source is the fallback rather than
                       the authority: see `Announcement::host`. */
                    address: format!(
                        "{}:{}",
                        usable_host(announcement.host.as_deref())
                            .unwrap_or_else(|| from.ip().to_string()),
                        announcement.port,
                    ),
                    device: announcement.device,
                    label: announcement.label,
                    shop: announcement.shop,
                    shop_id: announcement.shop_id,
                    port: announcement.port,
                });
            }
            Err(_) => continue,
        }
    }

    Ok(found)
}

/// An address a till claimed, kept only if it is one worth dialling.
///
/// Checked rather than trusted. The claim costs nothing to make and is not
/// authenticated — nor does it need to be, since reaching the wrong till ends
/// at a signature that does not verify — but an unparseable or loopback address
/// would replace a working fallback with one that cannot work at all. `0.0.0.0`
/// is what a till that bound every interface would say if it read its own
/// socket back, and it is not somewhere to knock.
fn usable_host(claimed: Option<&str>) -> Option<String> {
    let host = claimed?.trim();
    let parsed: IpAddr = host.parse().ok()?;
    if parsed.is_loopback() || parsed.is_unspecified() || parsed.is_multicast() {
        return None;
    }
    Some(host.to_string())
}

fn broadcast_targets() -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))];

    if let Some(IpAddr::V4(mine)) = local_address() {
        // The directed broadcast for this /24, which is what a shop's network is.
        let octets = mine.octets();
        let directed = Ipv4Addr::new(octets[0], octets[1], octets[2], 255);
        targets.push(SocketAddr::from((directed, DISCOVERY_PORT)));
    }
    targets
}

/// Which address this machine's traffic actually leaves by. No packet is sent —
/// `connect` on UDP only fixes a route.
fn local_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.168.1.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn announcement() -> Announcement {
        Announcement {
            v: 1,
            device: "1111aaaa-1111-4111-8111-111111111111".into(),
            label: "COUNTER1".into(),
            shop: Some("TRT Stationery".into()),
            shop_id: Some("d2a0604bc26129176963137d7f4517ed".into()),
            port: 7801,
            host: None,
        }
    }

    #[test]
    fn an_announcement_survives_the_wire() {
        let bytes = serde_json::to_vec(&announcement()).unwrap();
        let back: Announcement = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, announcement());
    }

    /// Its own ephemeral port, never the real one.
    ///
    /// All three of these used to bind `DISCOVERY_PORT`, and cargo runs them on
    /// parallel threads in one binary. Only the first to arrive could bind; the
    /// other two silently got nothing and were answered by the first one's
    /// responder — so when *that* test set its stop flag, it stopped the
    /// responder the others were still probing. The result was a test that
    /// passed alone, passed most of the time together, and timed out on a busy
    /// machine, which is the worst way for a test to be wrong.
    ///
    /// Waiting for the bind matters as much. UDP has no retransmit: a probe
    /// sent before the socket exists is simply gone, and `recv_from` then
    /// reports a timeout that looks identical to a broken responder.
    fn responder() -> (u16, Arc<AtomicBool>) {
        let stop = Arc::new(AtomicBool::new(false));
        let port = respond_on(0, announcement(), Arc::clone(&stop))
            .expect("the responder should bind an ephemeral port");
        (port, stop)
    }

    #[test]
    fn a_till_that_is_answering_says_where_it_is() {
        let (port, stop) = responder();

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        asking.send_to(PROBE, ("127.0.0.1", port)).unwrap();

        let mut buffer = [0u8; 2048];
        let (read, _) = asking.recv_from(&mut buffer).unwrap();
        let heard: Announcement = serde_json::from_slice(&buffer[..read]).unwrap();

        assert_eq!(heard.port, 7801);
        assert_eq!(heard.shop.as_deref(), Some("TRT Stationery"));
        stop.store(true, Ordering::SeqCst);
    }

    /* Which address a till is offered at. The packet's source is right whenever
       the shout went out the way the shop's traffic does, and wrong on a machine
       with a second card: a laptop with WSL answered from its Hyper-V switch
       while listening on the wifi address it was showing on its own screen. */

    #[test]
    fn prefers_the_address_a_till_says_it_is_at() {
        assert_eq!(usable_host(Some("192.168.1.2")).as_deref(), Some("192.168.1.2"));
        // Trimmed, because a config file that grew a space is not an outage.
        assert_eq!(usable_host(Some("  192.168.1.2  ")).as_deref(), Some("192.168.1.2"));
    }

    #[test]
    fn ignores_a_claim_that_is_no_use_to_anybody() {
        // Each of these would replace a working fallback with one that cannot
        // work. `0.0.0.0` is what a till that bound every interface would say
        // if it read its own socket back.
        for claimed in ["", "   ", "0.0.0.0", "127.0.0.1", "::1", "224.0.0.1", "not-an-address", "192.168.1.2:7801"] {
            assert!(usable_host(Some(claimed)).is_none(), "{claimed} should not be dialled");
        }
        assert!(usable_host(None).is_none());
    }

    #[test]
    fn a_till_that_says_nothing_is_still_reachable() {
        // An older till, or one that could not work out its own address. The
        // packet source carries it, exactly as it did before.
        assert!(usable_host(announcement().host.as_deref()).is_none());
    }

    /// A responder that answers anything can be pointed at somebody else: send it
    /// a packet with a forged source and it posts a reply to a stranger.
    #[test]
    fn says_nothing_to_traffic_that_is_not_ours() {
        let (port, stop) = responder();

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_millis(600))).unwrap();

        for noise in [&b"hello?"[..], b"GET / HTTP/1.1", b"", b"SHOPOS-"] {
            asking.send_to(noise, ("127.0.0.1", port)).unwrap();
        }

        let mut buffer = [0u8; 2048];
        assert!(
            asking.recv_from(&mut buffer).is_err(),
            "nothing should have been answered"
        );
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn stops_answering_when_the_till_stops() {
        let (port, stop) = responder();

        // One probe first, so the assertion below is about the stop rather than
        // about whether the responder was ever working.
        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        asking.send_to(PROBE, ("127.0.0.1", port)).unwrap();
        let mut buffer = [0u8; 2048];
        assert!(asking.recv_from(&mut buffer).is_ok(), "it should answer while running");

        stop.store(true, Ordering::SeqCst);
        // Longer than the responder's own 500 ms read timeout, which is how long
        // it can be parked in `recv_from` before it looks at the flag.
        std::thread::sleep(Duration::from_millis(900));

        asking.set_read_timeout(Some(Duration::from_millis(600))).unwrap();
        let _ = asking.send_to(PROBE, ("127.0.0.1", port));
        assert!(asking.recv_from(&mut buffer).is_err());
    }

    #[test]
    fn looks_on_this_subnet_as_well_as_everywhere() {
        let targets = broadcast_targets();
        assert!(targets.iter().any(|t| t.ip() == IpAddr::V4(Ipv4Addr::BROADCAST)));
        assert!(targets.iter().all(|t| t.port() == DISCOVERY_PORT));
    }
}
