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
    std::thread::spawn(move || {
        let Ok(socket) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else {
            // Another till on this machine already has it, or the port is taken.
            // Discovery is a convenience; nothing else should fail for it.
            return;
        };
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
                    address: format!("{}:{}", from.ip(), announcement.port),
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

#[tauri::command]
pub fn sync_look_around(wait_ms: u64) -> Result<Vec<Found>, String> {
    // Long enough for a till on a busy wifi to answer, short enough that a person
    // pressing a button does not think it has hung.
    look_around(Duration::from_millis(wait_ms.clamp(250, 5_000)))
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
        }
    }

    #[test]
    fn an_announcement_survives_the_wire() {
        let bytes = serde_json::to_vec(&announcement()).unwrap();
        let back: Announcement = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, announcement());
    }

    #[test]
    fn a_till_that_is_answering_says_where_it_is() {
        let stop = Arc::new(AtomicBool::new(false));
        respond_while(announcement(), Arc::clone(&stop));
        std::thread::sleep(Duration::from_millis(150));

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        asking
            .send_to(PROBE, ("127.0.0.1", DISCOVERY_PORT))
            .unwrap();

        let mut buffer = [0u8; 2048];
        let (read, _) = asking.recv_from(&mut buffer).unwrap();
        let heard: Announcement = serde_json::from_slice(&buffer[..read]).unwrap();

        assert_eq!(heard.port, 7801);
        assert_eq!(heard.shop.as_deref(), Some("TRT Stationery"));
        stop.store(true, Ordering::SeqCst);
    }

    /// A responder that answers anything can be pointed at somebody else: send it
    /// a packet with a forged source and it posts a reply to a stranger.
    #[test]
    fn says_nothing_to_traffic_that_is_not_ours() {
        let stop = Arc::new(AtomicBool::new(false));
        respond_while(announcement(), Arc::clone(&stop));
        std::thread::sleep(Duration::from_millis(150));

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_millis(600))).unwrap();

        for noise in [&b"hello?"[..], b"GET / HTTP/1.1", b"", b"SHOPOS-"] {
            asking.send_to(noise, ("127.0.0.1", DISCOVERY_PORT)).unwrap();
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
        let stop = Arc::new(AtomicBool::new(false));
        respond_while(announcement(), Arc::clone(&stop));
        std::thread::sleep(Duration::from_millis(150));

        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(700));

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        asking.set_read_timeout(Some(Duration::from_millis(600))).unwrap();
        let _ = asking.send_to(PROBE, ("127.0.0.1", DISCOVERY_PORT));

        let mut buffer = [0u8; 2048];
        assert!(asking.recv_from(&mut buffer).is_err());
    }

    #[test]
    fn looks_on_this_subnet_as_well_as_everywhere() {
        let targets = broadcast_targets();
        assert!(targets.iter().any(|t| t.ip() == IpAddr::V4(Ipv4Addr::BROADCAST)));
        assert!(targets.iter().all(|t| t.port() == DISCOVERY_PORT));
    }
}
