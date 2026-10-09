mod archive;
mod attachments;
mod backup;
mod db;
mod device;
mod diagnostics;
mod discovery;
mod exports;
mod files;
mod hook;
mod ids;
mod instance;
mod log;
mod paths;
mod pdf;
mod printing;
mod restore;
mod shop_copy;
mod sync_client;
mod sync_server;
mod updater;
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

    let context = tauri::generate_context!();
    let updates = updater::configured(&context.config().identifier, &context.config().plugins.0);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    if updates {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(updater::Updates(updates))
        .setup(|app| {
            /* `paths::data_dir` rather than `app_data_dir` directly, because
               it is the one place that knows about `--shop`. This line used to
               reach past it, and a second company started with `--shop` would
               have put its device identity, backups and attachments in its own
               folder while still opening the *first* company's database --
               two sets of books, one file, and no sign anything was wrong
               until the invoice numbers collided.

               A `--shop` that is there and unusable is the one failure here
               with no folder to write anything in. It is carried to the
               screen like any other, and nothing is opened: the alternative
               was opening the original shop's books under a shortcut meant
               for another company. */
            let dir = match paths::data_dir(&app.handle().clone()) {
                Ok(dir) => dir,
                Err(message) => {
                    let kind = if paths::shop_slug().is_err() {
                        db::FailureKind::InvalidShop
                    } else {
                        db::FailureKind::Io
                    };
                    log::write("error", "startup", &message);
                    refuse_to_open(app, kind, message, std::path::Path::new(paths::DB_FILE));
                    return Ok(());
                }
            };
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(dir.join("backups"))?;
            std::fs::create_dir_all(dir.join("attachments"))?;

            // The first thing that can write anything down, and therefore the
            // first thing done with a folder to write it in.
            log::open(&dir);
            if let Ok(Some(shop)) = paths::shop_slug() {
                log::write("info", "startup", &format!("running shop \"{shop}\""));
            }

            /* Before anything touches the folder. A second copy of ShopOS on
               the same shop used to go on to sweep the work folder and apply
               a staged restore underneath the first. It waits a moment first,
               because a restart overlaps the copy that is exiting. */
            let db_path = dir.join(paths::DB_FILE);
            match instance::hold(&dir, instance::RESTART_GRACE) {
                Ok(held) => {
                    app.manage(instance::Instance(held));
                }
                Err(message) => {
                    log::write("warn", "startup", &message);
                    refuse_to_open(app, db::FailureKind::Locked, message, &db_path);
                    return Ok(());
                }
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
            /* A swap that did not finish leaves `shop.db` as something nobody
               has decided is the shop -- or leaves nothing there at all, which
               `Db::open` would have answered with a new, empty database and a
               till open for business on it. Neither opens. The screen offers
               the way back: start again to retry, or cancel the restore. */
            if report.incomplete {
                let message = report
                    .error
                    .clone()
                    .unwrap_or_else(|| "A restore did not finish.".into());
                app.manage(restore::LastRestore(report));
                refuse_to_open(app, db::FailureKind::RestoreIncomplete, message, &db_path);
                return Ok(());
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
            let opened = db::Db::open(&db_path);
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
            app.manage(shop_copy::CopyShelf::default());

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
            device::device_identity,
            device::device_set_register,
            device::device_set_setting,
            sync_server::sync_serve_start,
            sync_server::sync_serve_stop,
            sync_server::sync_serve_status,
            sync_server::sync_reply,
            sync_client::sync_request,
            shop_copy::sync_copy_prepare,
            shop_copy::sync_copy_download,
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
            backup::backup_write_safety,
            backup::choose_folder,
            backup::backup_copy_out,
            backup::backup_folder_list,
            backup::backup_folder_delete,
            backup::cloud_folders,
            backup::make_cloud_folder,
            attachments::attachment_store,
            attachments::attachment_read,
            attachments::attachment_delete,
            attachments::attachment_present,
            hook::run_backup_hook,
            restore::restore_inspect,
            restore::restore_begin,
            restore::restore_report,
            restore::restore_abandon,
            restore::copy_install,
            version::app_version,
            version::shops_on_this_machine,
            updater::updates_enabled,
        ])
        .run(context)
        .expect("error while running shopos");
}

/// Starts the window without a database, carrying why.
///
/// Every command that needs the database then answers `DB_NOT_OPEN` with this
/// message, and `App.tsx` asks `startup_status` first and shows it. The other
/// state is managed too, because a command that asks for state nobody managed
/// panics, and the failure screen still calls a few of them.
fn refuse_to_open(
    app: &mut tauri::App,
    kind: db::FailureKind,
    message: String,
    db_path: &std::path::Path,
) {
    app.manage(db::DbState(Err(db::StartupFailure::before_opening(kind, message, db_path))));
    if app.try_state::<restore::LastRestore>().is_none() {
        app.manage(restore::LastRestore(restore::Report::default()));
    }
    app.manage(sync_server::SyncHost::default());
    app.manage(shop_copy::CopyShelf::default());
}
