#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Windows only: declare per-monitor DPI awareness before any window exists.
/// Without it the webview lays out in physical pixels and then renders them at the
/// monitor's scale factor, so on any display above 100% the whole UI is drawn
/// oversized and clipped on the right. Most Windows laptops ship scaled.
#[cfg(windows)]
fn make_dpi_aware() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    // Fails harmlessly if awareness is already set by a manifest.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(not(windows))]
fn make_dpi_aware() {}

fn main() {
    make_dpi_aware();
    shopos_pos_lib::run()
}
