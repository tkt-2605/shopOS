//! Which dev till this copy is, decided at start-up rather than at build time.
//!
//! The dev tills used to be one release build each, from `tauri.tillN.json`,
//! only because the identifier (which `app_data_dir` keys on), the window title
//! and its place on screen were baked into the binary. Three builds of the same
//! code took three times as long for nothing. Now `build-tills.mjs` builds once
//! and copies the exe into `tills/till-1`, `till-2`, `till-3`, and each copy
//! reads its number from its own folder -- so the desktop and Startup
//! shortcuts, which point at those folders, are unchanged. `--till N` says it
//! outright and wins over the folder.
//!
//! Only a dev till is ever renumbered: the identifier the build carries has to
//! be one of `com.shopos.pos.tillN`. A shop's own build, `com.shopos.pos`, is
//! left exactly as built, whatever folder it is in or switch it is given.

const DEV_PREFIX: &str = "com.shopos.pos.till";

/// The till number to run as, or None to run as built.
pub fn till_from(identifier: &str, exe_dir: Option<&str>, args: &[String]) -> Option<u32> {
    if !identifier.starts_with(DEV_PREFIX) {
        return None;
    }
    let from_args = args.windows(2).find(|w| w[0] == "--till").and_then(|w| w[1].parse().ok());
    let from_dir = exe_dir.and_then(|d| d.strip_prefix("till-")).and_then(|n| n.parse().ok());
    from_args.or(from_dir).filter(|n: &u32| (1..=9).contains(n))
}

/// Makes the context the given dev till: its own identifier, title and place on screen.
pub fn apply<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe().ok();
    let dir = exe.as_ref().and_then(|p| p.parent()).and_then(|p| p.file_name()).and_then(|n| n.to_str());
    let Some(n) = till_from(&context.config().identifier, dir, &args) else { return };

    let config = context.config_mut();
    config.identifier = format!("{DEV_PREFIX}{n}");
    config.product_name = Some(format!("ShopOS — Till {n}"));
    if let Some(window) = config.app.windows.first_mut() {
        window.title = format!("ShopOS — Till {n}");
        // Each a step down and across from the last, so three on one screen do not stack exactly.
        let step = f64::from(n - 1);
        window.x = Some(40.0 + 340.0 * step);
        window.y = Some(40.0 + 50.0 * step);
    }
}

#[cfg(test)]
mod tests {
    use super::till_from;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_copy_reads_its_till_from_its_folder() {
        assert_eq!(till_from("com.shopos.pos.till1", Some("till-3"), &[]), Some(3));
    }

    #[test]
    fn the_switch_wins_over_the_folder() {
        assert_eq!(till_from("com.shopos.pos.till1", Some("till-3"), &args(&["--till", "2"])), Some(2));
    }

    #[test]
    fn a_shops_own_build_is_never_renumbered() {
        assert_eq!(till_from("com.shopos.pos", Some("till-2"), &args(&["--till", "2"])), None);
    }

    #[test]
    fn a_folder_that_names_no_till_changes_nothing() {
        assert_eq!(till_from("com.shopos.pos.till1", Some("release"), &[]), None);
        assert_eq!(till_from("com.shopos.pos.till1", Some("till-x"), &[]), None);
        assert_eq!(till_from("com.shopos.pos.till1", Some("till-0"), &[]), None);
    }
}
