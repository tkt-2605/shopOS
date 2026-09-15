use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Db;

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
pub fn app_version(app: AppHandle, db: State<'_, Db>) -> AppVersion {
    AppVersion {
        version: app.package_info().version.to_string(),
        schema: db.user_version().ok(),
    }
}
