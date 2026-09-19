/// Asking another till something, from inside the app.
///
/// The counterpart to `sync_server.rs`: that one answers the door, this one
/// knocks. Both are here rather than in the webview because a webview may not
/// listen on a socket -- and, it turns out, may not call out to another till
/// either. The app's CSP takes `connect-src` from `default-src 'self'`, so a
/// `fetch` aimed at `http://192.168.1.2:7801` is refused before a packet
/// leaves, and the only symptom the screen can show for it is the browser's own
/// "Failed to fetch". `crates/shopos-net/src/http.rs` carries the rest.
///
/// `syncClient.ts` already takes the fetch it uses as an argument, for the
/// bench. The app now passes one that arrives here, so core is untouched and
/// the containers keep the real thing.
use shopos_net::http;

#[derive(serde::Serialize)]
pub struct Answered {
    pub status: u16,
    pub body: String,
}

/// Asks, and hands back whatever came -- including a refusal, which is an
/// answer and not an error. Only a till that could not be reached at all is
/// `Err`, because that is the one case the screen words differently.
///
/// The path is checked against the four the protocol has. The CSP being stepped
/// around here is the thing that stops the webview reaching the network at all,
/// so the way back in must not be a general one: this posts to a till's sync
/// endpoints or it does nothing. A script that got as far as `invoke` still
/// cannot use it to reach anything else.
#[tauri::command]
pub async fn sync_request(
    address: String,
    path: String,
    body: String,
    auth: Option<String>,
    listen_port: Option<u16>,
) -> Result<Answered, String> {
    if !http::PATHS.contains(&path.as_str()) {
        return Err(format!("{path} is not something one till asks another"));
    }

    /* Off the UI thread: a till that is switched off is five seconds of waiting
       and a big batch is more, and the counter must stay usable throughout. */
    tauri::async_runtime::spawn_blocking(move || {
        http::request(&address, &path, &body, auth.as_deref(), listen_port)
            .map(|answer| Answered { status: answer.status, body: answer.body })
    })
    .await
    .map_err(|e| format!("The request did not finish: {e}"))?
}
