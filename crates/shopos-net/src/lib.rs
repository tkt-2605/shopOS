/// The part of a till that is on the network, with no app around it.
///
/// Two modules, both lifted out of `apps/pos/src-tauri` unchanged in behaviour:
/// the UDP shout that finds another till, and the TCP listener it then knocks
/// on. Neither knows anything about replication — see `http.rs` for why that
/// line is where it is.
///
/// ## Why this is a crate
///
/// Layer 2 of the test bench runs a till per container on a real Docker
/// network, because UDP broadcast across network namespaces is the one thing
/// loopback cannot prove. That needs discovery and the listener without Tauri,
/// and a second implementation for the containers would be a second protocol
/// that drifts — so the app and the container run the same code and differ only
/// in who answers.
///
/// `Answerer` is that seam. The app hands each request to its webview and waits;
/// `shopos-net answer` forwards it to a Node till on localhost. The rules about
/// what a request *means* stay in `packages/core`, in one copy, as before.
pub mod client;
pub mod discovery;
pub mod http;
pub mod web;

pub use http::{
    lan_address, serve, Answerer, Bound, Reply, Request, LISTEN_PORT_HEADER, MAX_BODY, PATHS,
};
