mod archive;
mod attachments;
mod backup;
mod db;
mod device;
mod discovery;
mod exports;
mod hook;
mod log;
mod paths;
mod pdf;
mod printing;
mod restore;
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
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("backups"))?;
            std::fs::create_dir_all(dir.join("attachments"))?;

            // The first thing that can write anything down, and therefore the
            // first thing done with a folder to write it in.
            log::open(&dir);

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

            let database = db::Db::open(&dir.join(paths::DB_FILE))?;
            match database.user_version() {
                Ok(v) => log::write("info", "startup", &format!("database open, schema {v}")),
                Err(e) => log::write("warn", "startup", &format!("schema unreadable: {e}")),
            }
            database.start_watchdog();
            app.manage(database);
            app.manage(restore::LastRestore(report));

            // Nothing listens until a shop asks for it. A single-till shop --
            // which is most of them -- never opens a port at all.
            app.manage(sync_server::SyncHost::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log::log_event,
            db::sql_query,
            db::sql_execute,
            db::sql_tx_begin,
            db::sql_tx_query,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running shopos");
}
