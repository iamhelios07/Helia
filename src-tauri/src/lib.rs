#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "desktop")]
pub fn run() {
    let access = storage::StorageAccess::new().expect("Could not initialize storage access");
    let initialization = access.initialization_script();
    tauri::Builder::default()
        .manage(access)
        .append_invoke_initialization_script(initialization)
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(storage::StoragePath(directory.join("helia.sqlite")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::storage_request,
            credentials::credential_request,
            generation::ai_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helia");
}
#[cfg(any(feature = "desktop", test))]
mod credential_store;
#[cfg(any(feature = "desktop", test))]
mod credentials;
#[cfg(any(feature = "desktop", test))]
mod generation;
#[cfg(any(feature = "desktop", test))]
mod state_schema;
#[cfg(any(feature = "desktop", test))]
mod storage;
#[cfg(any(feature = "desktop", test))]
mod vertex;

#[cfg(feature = "desktop")]
use tauri::Manager;
