/// Answering another till, from inside the app.
///
/// The listener, the HTTP parser and the four paths moved to
/// `crates/shopos-net`, so that the bench can run the same code in a container
/// with no Tauri anywhere near it. `crates/shopos-net/src/http.rs` carries the
/// reasoning for all of it, including why this side knows nothing about
/// replication.
///
/// What is left here is the half that is genuinely the app's: the commands a
/// screen calls, and an `Answerer` that hands each request to the webview and
/// waits for what it decided.
///
/// ── Off unless a shop turns it on ──────────────────────────────────────────
///
/// Nothing listens until `sync_serve_start` is called. A shop with one till
/// never opens a port at all, which is the right default for the large majority
/// of them: an open port that nothing uses is a way in and no use to anybody.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{device, discovery, paths};
use shopos_net::http::{self, Answerer, Bound};
use tauri::{Emitter, Manager};

/// How long the webview has to answer before the caller is told to come back.
///
/// It must be **larger than `MERGE_BUDGET_MS`** in `packages/core/src/db/driver.ts`,
/// and it was smaller: ninety seconds of budget behind a sixty-second wait. A
/// merge that used the budget the budget exists for -- a till a fortnight behind,
/// which is the whole reason it is ninety and not fifteen -- had already been
/// answered `503 NOT_READY` and had its socket closed, while the transaction
/// carried on and committed. The asking till then reported a failure for a round
/// that worked, backed off, and came back to do the same ninety seconds again.
///
/// Timeouts grow outward: the work has a budget, the answer waits longer than the
/// work, and the caller waits longer than the answer. `timeoutsGrowOutward.test.ts`
/// reads both constants and fails if they ever invert again, because they are in
/// two languages and nothing else would notice.
///
/// Thirty seconds of headroom over the budget, not five minutes: `MAX_TX_BUDGET_MS`
/// lets a caller *ask* for five, but the merge asks for ninety seconds and this
/// needs to cover what is actually scheduled rather than what is permitted. A
/// wedged webview holding a peer's socket is its own cost.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

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
    /// Where the caller is, so the webview can record an address for it.
    ///
    /// This is the app half of the host-sync fix. `handleSyncRequest` writes
    /// `sync_peers.address` from these two, and without them a till that has
    /// been *joined* keeps a peer row with a secret and no address — which
    /// `pairedPeers` filters out, leaving the front counter with nobody to
    /// start a sync with and a screen saying the tills agree.
    #[serde(rename = "remoteAddress")]
    remote_address: Option<String>,
    #[serde(rename = "listenPort")]
    listen_port: Option<u16>,
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
    bound: Bound,
}

/// The app's way of answering: ask the webview, wait, and hand back what it said.
struct ToWebview {
    app: tauri::AppHandle,
}

impl Answerer for ToWebview {
    fn answer(&self, request: http::Request) -> http::Reply {
        /* A chunk of a copy of the shop is answered here, from the file. It is
           megabytes, and the webview answers in strings with a two-minute wait;
           the signed `/copy` that handed out its token went through the webview
           like everything else. See `shop_copy.rs`. */
        if request.path == http::COPY_PART_PATH {
            return crate::shop_copy::answer_part(&self.app, &request.body);
        }
        let host = self.app.state::<SyncHost>();
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
            remote_address: request.remote_address,
            listen_port: request.listen_port,
        };

        if self.app.emit("sync-request", forwarded).is_err() {
            if let Ok(mut waiting) = host.waiting.lock() {
                waiting.remove(&id);
            }
            return http::Reply::refuse(503, "NOT_READY");
        }

        match receiver.recv_timeout(ANSWER_TIMEOUT) {
            Ok(reply) => http::Reply { status: reply.status, body: reply.body },
            Err(_) => {
                /* The webview never answered — closed, asleep, or busy with a
                   transaction that outlasted the wait. The other till is told to
                   come back rather than left holding a connection. */
                if let Ok(mut waiting) = host.waiting.lock() {
                    waiting.remove(&id);
                }
                http::Reply::refuse(503, "NOT_READY")
            }
        }
    }
}

/// `async`: binding is quick, but finding the discovery port free can take up
/// to a second when sync has just been switched off and on again, and that
/// second should not be a frozen window.
#[tauri::command(async)]
pub fn sync_serve_start(
    app: tauri::AppHandle,
    port: u16,
    shop: Option<String>,
    shop_id: Option<String>,
) -> Result<ServeInfo, String> {
    let host = app.state::<SyncHost>();
    let mut running = host.running.lock().map_err(|_| "sync host is wedged")?;

    if let Some(current) = running.as_ref() {
        // Already answering. Saying so beats quietly starting a second one.
        return Ok(info(current.bound.port));
    }

    // Preferring, not insisting: `serve_preferring` says why, and the port it
    // settled on is what the screen shows and what the shout announces.
    let bound = http::serve_preferring(port, Arc::new(ToWebview { app: app.clone() }))?;

    /* Answering the shout and answering HTTP start and stop together, sharing
       one flag. There is deliberately no state where a till announces itself on
       the network and then does not answer when somebody knocks. */
    if let Ok(identity) = device::identity_of(&paths::data_dir(&app)?) {
        let findable = discovery::respond_while(
            discovery::Announcement {
                v: 1,
                device: identity.id,
                label: identity.label,
                shop,
                shop_id,
                port: bound.port,
                /* The same address this till shows on its own Settings screen,
                   rather than leaving the asker to read one off the packet. A
                   machine with a second network card answers from whichever
                   one the shout arrived on, which on a laptop with WSL is a
                   virtual switch nothing can reach. */
                host: http::lan_address(),
            },
            bound.stop_flag(),
        );
        /* Not a reason to refuse to answer: a till that cannot be found can
           still be typed in by address, and the screen shows the address. But
           it is a reason nobody could find it, and that belongs in the log. */
        if let Err(why) = findable {
            crate::log::write("warn", "sync", &format!("discovery is off: {why}"));
        }
    }

    let answer = info(bound.port);
    *running = Some(Running { bound });
    Ok(answer)
}

#[tauri::command]
pub fn sync_serve_stop(app: tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<SyncHost>();
    let mut running = host.running.lock().map_err(|_| "sync host is wedged")?;

    if let Some(current) = running.take() {
        current.bound.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn sync_serve_status(app: tauri::AppHandle) -> Option<ServeInfo> {
    let host = app.state::<SyncHost>();
    let running = host.running.lock().ok()?;
    running.as_ref().map(|current| info(current.bound.port))
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

fn info(port: u16) -> ServeInfo {
    ServeInfo {
        port,
        address: http::lan_address().map(|ip| format!("{ip}:{port}")),
    }
}
