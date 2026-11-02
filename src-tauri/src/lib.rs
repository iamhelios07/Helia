#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(storage::StoragePath(directory.join("helia.sqlite")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![storage::storage_request])
        .run(tauri::generate_context!())
        .expect("error while running Helia");
}
#[cfg(any(feature = "desktop", test))]
mod storage;

#[cfg(feature = "desktop")]
use tauri::Manager;
