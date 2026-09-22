mod archive;
mod attachments;
mod backup;
mod db;
mod device;
mod diagnostics;
mod discovery;
mod exports;
mod hook;
mod log;
mod paths;
mod pdf;
mod printing;
mod restore;
mod sync_client;
mod sync_server;
mod version;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /* Before the builder, so that a panic inside `setup()` -- the place most
       likely to meet a broken database -- is written down even though no
       window ever appears. In release there is no console for it to fall out
       of: `main.rs` sets `windows_subsystem = "windows"`, and the only symptom
       of a panic here is an icon that does nothing when it is double-clicked. */
    log::install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            /* `paths::data_dir` rather than `app_data_dir` directly, because
               it is the one place that knows about `--shop`. This line used to
               reach past it, and a second company started with `--shop` would
               have put its device identity, backups and attachments in its own
               folder while still opening the *first* company's database --
               two sets of books, one file, and no sign anything was wrong
               until the invoice numbers collided. */
            let dir = paths::data_dir(&app.handle().clone())
                .map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("backups"))?;
            std::fs::create_dir_all(dir.join("attachments"))?;

            // The first thing that can write anything down, and therefore the
            // first thing done with a folder to write it in.
            log::open(&dir);
            if let Some(shop) = paths::shop_slug() {
                log::write("info", "startup", &format!("running shop \"{shop}\""));
            }

            // Order matters here and nowhere else in the program. A staged
            // restore has to be applied while nothing holds a handle on the
            // database, which is true exactly once: now, before Db::open. The
            // sweep goes first so a temp left by a crash cannot break the
            // backup that this session will take.
            paths::sweep_work_dir(&dir);
            let report = restore::apply_pending(&dir);
            /* A restore applied at startup is the single most consequential
               thing this program does to a shop's data, and until now it left
               a message on one screen for one run and no trace at all. */
            if let Some(m) = report.restored.as_ref() {
                log::write("info", "restore", &format!("applied backup {}", m.source));
            }
            if let Some(e) = report.error.as_ref() {
                log::write("error", "restore", e);
            }

            /* Never `?`. This used to be `Db::open(..)?`, which made a
               database that would not open into a setup that returned `Err`,
               which made Tauri never create a window -- and with
               `windows_subsystem = "windows"` there is no console either. The
               whole symptom was an icon that did nothing when it was
               double-clicked: no message, no log, and no way to reach the
               Restore button that would have fixed it.

               The failure is carried into the app instead, and `App.tsx` asks
               for it before it asks for anything else. */
            let opened = db::Db::open(&dir.join(paths::DB_FILE));
            match &opened {
                Ok(database) => match database.user_version() {
                    Ok(v) => log::write("info", "startup", &format!("database open, schema {v}")),
                    Err(e) => log::write("warn", "startup", &format!("schema unreadable: {e}")),
                },
                Err(f) => log::write(
                    "error",
                    "startup",
                    &format!("{:?}: {} ({})", f.kind, f.message, f.db_path),
                ),
            }
            if let Ok(database) = &opened {
                database.start_watchdog();
            }
            app.manage(db::DbState(opened));
            app.manage(restore::LastRestore(report));

            // Nothing listens until a shop asks for it. A single-till shop --
            // which is most of them -- never opens a port at all.
            app.manage(sync_server::SyncHost::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log::log_event,
            db::startup_status,
            diagnostics::diagnostics_bundle,
            db::sql_query,
            db::sql_query_values,
            db::sql_execute,
            db::sql_tx_begin,
            db::sql_tx_query,
            db::sql_tx_query_values,
            db::sql_tx_execute,
            db::sql_tx_end,
            db::sql_abandon_tx,
            db::backup_database,
            device::device_identity,
            device::device_set_register,
            device::device_set_setting,
            sync_server::sync_serve_start,
            sync_server::sync_serve_stop,
            sync_server::sync_serve_status,
            sync_server::sync_reply,
            sync_client::sync_request,
            discovery::sync_look_around,
            printing::list_printers,
            printing::default_printer,
            printing::print_receipt,
            exports::export_file,
            exports::export_pdf,
            backup::backup_list,
            backup::backup_path,
            backup::backup_delete,
            backup::backup_copy,
            backup::backup_write_zip,
            backup::choose_folder,
            attachments::attachment_store,
            attachments::attachment_read,
            attachments::attachment_delete,
            attachments::attachment_present,
            hook::run_backup_hook,
            restore::restore_inspect,
            restore::restore_begin,
            restore::restore_report,
            restore::restore_abandon,
            version::app_version,
            version::shops_on_this_machine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shopos");
}
