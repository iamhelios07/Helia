#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "desktop")]
pub fn run() {
    let access = storage::StorageAccess::new().expect("Could not initialize storage access");
    let initialization = access.initialization_script();
    let media_server =
        media_server::MediaServer::bind().expect("Could not initialize media server");
    let media_initialization = media_server.initialization_script();
    tauri::Builder::default()
        .manage(access)
        .register_asynchronous_uri_scheme_protocol("helia-media", |context, request, responder| {
            let path = context
                .app_handle()
                .state::<storage::StoragePath>()
                .0
                .clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(runtime_content::media_response(&path, request.uri().path()))
            });
        })
        // Invoke initialization runs before core.js defines invoke. Plugin scripts run
        // after core.js and before application code, so the private bridge captures it safely.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("helia-host")
                .js_init_script(initialization)
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("helia-media-host")
                .js_init_script(media_initialization)
                .build(),
        )
        .setup(move |app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let path = directory.join("helia.sqlite");
            storage::media_uploads::start(&path).map_err(std::io::Error::other)?;
            let media_handle = media_server.start(path.clone());
            app.manage(media_handle);
            app.manage(storage::StoragePath(path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::storage_request,
            ai_settings::ai_settings_request,
            credentials::credential_request,
            generation::ai_request,
            network::network_request,
            game_secrets::game_secrets_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helia");
}
#[cfg(any(feature = "desktop", test))]
mod ai_settings;
#[cfg(any(feature = "desktop", test))]
mod credential_store;
#[cfg(any(feature = "desktop", test))]
mod credentials;
#[cfg(any(feature = "desktop", test))]
mod game_secrets;
#[cfg(any(feature = "desktop", test))]
mod generation;
#[cfg(any(feature = "desktop", test))]
mod media_identity;
#[cfg(any(feature = "desktop", test))]
mod media_server;
#[cfg(any(feature = "desktop", test))]
mod network;
#[cfg(any(feature = "desktop", test))]
mod runtime_content;
#[cfg(any(feature = "desktop", test))]
mod secret_response;
#[cfg(any(feature = "desktop", test))]
mod session_files;
#[cfg(any(feature = "desktop", test))]
mod state_schema;
#[cfg(any(feature = "desktop", test))]
mod storage;
#[cfg(any(feature = "desktop", test))]
mod storage_sync;
#[cfg(any(feature = "desktop", test))]
mod vertex;

#[cfg(feature = "desktop")]
use tauri::Manager;
