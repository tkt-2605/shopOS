use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::DbState;

/// What is actually running, as against what somebody believes is running.
///
/// The version comes from `tauri.conf.json` by way of `package_info()`, not from
/// `package.json` read at build time by the webview. The two drift the moment a
/// release is cut from one and not the other, and the screen that matters is the
/// one at a shop three hundred kilometres away being read down a phone line: it
/// has to name the binary the shopkeeper double-clicked, not a string that was
/// true in the repository.
///
/// `schema` is null when the database could not be read. The app cannot reach
/// the webview at all without a `Db` managed — `setup` fails first — so what this
/// covers is a poisoned lock or an unreadable pragma, which is precisely the
/// state `CouldNotStart` is showing. A version number beside "schema: unknown"
/// is far more use to whoever is on that phone line than no line at all.
#[derive(Serialize)]
pub struct AppVersion {
    version: String,
    schema: Option<i64>,
}

#[tauri::command]
pub fn app_version(app: AppHandle, db: State<'_, DbState>) -> AppVersion {
    AppVersion {
        version: app.package_info().version.to_string(),
        /* `.ok()` twice over, because this is the one line the
           `CouldNotStart` screen shows and that screen exists precisely when
           the database did not open. A version line that refused to render
           without a database would go missing exactly when somebody is reading
           it down a phone line. */
        schema: db.get().ok().and_then(|d| d.user_version().ok()),
    }
}
