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
/// Generous, because applying a batch is a real transaction on a real disk.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);

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

#[tauri::command]
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

    let bound = http::serve(port, Arc::new(ToWebview { app: app.clone() }))?;

    /* Answering the shout and answering HTTP start and stop together, sharing
       one flag. There is deliberately no state where a till announces itself on
       the network and then does not answer when somebody knocks. */
    if let Ok(identity) = device::identity_of(&paths::data_dir(&app)?) {
        discovery::respond_while(
            discovery::Announcement {
                v: 1,
                device: identity.id,
                label: identity.label,
                shop,
                shop_id,
                port: bound.port,
            },
            bound.stop_flag(),
        );
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
