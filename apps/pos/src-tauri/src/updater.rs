use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

/// Whether this build was given an update feed and the key to check it with.
///
/// Only a release build is: `release.yml` merges a `plugins.updater` section
/// into the config from the repository's settings. Every other build -- `tauri
/// dev`, CI, a hand-built installer for a Sandbox -- has none, and registering
/// the plugin there would stop the app at startup, since the plugin refuses a
/// config without a public key. So the plugin is added only when this is true,
/// and the webview asks `updates_enabled` rather than finding out by failing.
///
/// Only the real app's identifier updates. The demo and the four test tills
/// are the same binary under other identifiers and other data folders; an
/// updater there would install the production app over a test till.
pub fn configured(identifier: &str, plugins: &HashMap<String, Value>) -> bool {
    if identifier != PRODUCTION_IDENTIFIER {
        return false;
    }
    let Some(updater) = plugins.get("updater") else { return false };
    let pubkey = updater.get("pubkey").and_then(Value::as_str).unwrap_or("").trim();
    let endpoints = updater
        .get("endpoints")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).any(|url| url.starts_with("https://")))
        .unwrap_or(false);
    !pubkey.is_empty() && endpoints
}

pub const PRODUCTION_IDENTIFIER: &str = "com.shopos.pos";

pub struct Updates(pub bool);

#[tauri::command]
pub fn updates_enabled(updates: State<'_, Updates>) -> bool {
    updates.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plugins(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_build_without_an_updater_section_does_not_update() {
        assert!(!configured(PRODUCTION_IDENTIFIER, &plugins(json!({}))));
    }

    #[test]
    fn a_feed_and_a_key_is_an_updating_build() {
        assert!(configured(PRODUCTION_IDENTIFIER, &plugins(json!({
            "updater": { "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ", "endpoints": ["https://example.com/latest.json"] }
        }))));
    }

    #[test]
    fn a_test_till_never_updates_even_with_a_feed() {
        let feed = plugins(json!({
            "updater": { "pubkey": "abc", "endpoints": ["https://example.com/latest.json"] }
        }));
        assert!(!configured("com.shopos.pos.till2", &feed));
        assert!(!configured("com.shopos.pos.demo", &feed));
    }

    #[test]
    fn an_empty_key_is_not_a_key() {
        assert!(!configured(PRODUCTION_IDENTIFIER, &plugins(json!({
            "updater": { "pubkey": "  ", "endpoints": ["https://example.com/latest.json"] }
        }))));
    }

    #[test]
    fn a_feed_over_plain_http_is_not_a_feed() {
        // The plugin refuses these in release anyway; saying so here keeps the
        // webview from offering an update that can never be fetched.
        assert!(!configured(PRODUCTION_IDENTIFIER, &plugins(json!({
            "updater": { "pubkey": "abc", "endpoints": ["http://example.com/latest.json"] }
        }))));
        assert!(!configured(PRODUCTION_IDENTIFIER, &plugins(json!({ "updater": { "pubkey": "abc", "endpoints": [] } }))));
    }
}
