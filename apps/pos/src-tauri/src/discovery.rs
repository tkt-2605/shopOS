/// Finding the other till, from inside the app.
///
/// The whole of it — the UDP shout, the reply, what is and is not given away —
/// moved to `crates/shopos-net` so the bench's containers can run it without
/// Tauri. `crates/shopos-net/src/discovery.rs` carries the reasoning.
///
/// What is left here is the one thing that is genuinely the app's: a command a
/// button on the Settings screen can call.
use std::time::Duration;

pub use shopos_net::discovery::{look_around, respond_while, Announcement, Found};

/// `async`: it waits up to five seconds for replies by design, and as a plain
/// command that was five seconds of a window that would not repaint.
#[tauri::command(async)]
pub fn sync_look_around(wait_ms: u64) -> Result<Vec<Found>, String> {
    // Long enough for a till on a busy wifi to answer, short enough that a person
    // pressing a button does not think it has hung.
    look_around(Duration::from_millis(wait_ms.clamp(250, 5_000)))
}
