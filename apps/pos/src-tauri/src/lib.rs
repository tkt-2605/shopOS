mod backup;
mod db;
mod exports;
mod printing;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("backups"))?;

            let database = db::Db::open(&dir.join("shop.db"))?;
            database.start_watchdog();
            app.manage(database);

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
            printing::list_printers,
            printing::default_printer,
            printing::print_receipt,
            exports::export_file,
            backup::backup_list,
            backup::backup_path,
            backup::backup_delete,
            backup::backup_copy,
            backup::choose_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running shopos");
}
