fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "storage_request",
            "ai_settings_request",
            "credential_request",
            "ai_request",
        ]),
    ))
    .expect("failed to build Helia permissions")
}
