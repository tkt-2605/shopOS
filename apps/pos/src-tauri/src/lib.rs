mod archive;
mod attachments;
mod backup;
mod db;
mod device;
mod exports;
mod hook;
mod paths;
mod pdf;
mod printing;
mod restore;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("backups"))?;
            std::fs::create_dir_all(dir.join("attachments"))?;

            // Order matters here and nowhere else in the program. A staged
            // restore has to be applied while nothing holds a handle on the
            // database, which is true exactly once: now, before Db::open. The
            // sweep goes first so a temp left by a crash cannot break the
            // backup that this session will take.
            paths::sweep_work_dir(&dir);
            let report = restore::apply_pending(&dir);

            let database = db::Db::open(&dir.join(paths::DB_FILE))?;
            database.start_watchdog();
            app.manage(database);
            app.manage(restore::LastRestore(report));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::sql_query,
            db::sql_execute,
            db::sql_tx_begin,
            db::sql_tx_query,
            db::sql_tx_execute,
            db::sql_tx_end,
            db::sql_abandon_tx,
            db::backup_database,
            device::device_identity,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running shopos");
}
