use crate::{storage::StorageAccess, storage::StoragePath, vertex::VertexSettings};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

const INVALID: &str = "AI 설정 데이터의 형식이 올바르지 않아요.";
const STORE_ERROR: &str = "AI 설정을 저장하거나 읽을 수 없어요.";
const CONFLICT: &str = "다른 창에서 모델 설정이 변경됐어요. 설정을 다시 불러온 후 저장해주세요.";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_PAYLOAD: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Read {},
    Initialize { settings: Value },
    Write { settings: Value, revision: Value },
}

fn text(value: &Value, limit: usize) -> Result<String, String> {
    let raw = value.as_str().ok_or(INVALID)?;
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.encode_utf16().count() > limit
        || raw.chars().any(char::is_control)
    {
        return Err(INVALID.into());
    }
    Ok(trimmed.to_owned())
}

fn id(value: &Value) -> Result<String, String> {
    let id = value.as_str().ok_or(INVALID)?;
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(INVALID.into());
    }
    Ok(id.to_owned())
}

fn endpoint(value: &Value) -> Result<String, String> {
    let raw = text(value, 2048)?;
    let url = reqwest::Url::parse(&raw).map_err(|_| INVALID)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(INVALID.into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn provider(value: &Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err(INVALID.into());
    }
    let kind = value["kind"].as_str().ok_or(INVALID)?;
    if !matches!(
        kind,
        "openai-compatible"
            | "openai-responses"
            | "anthropic"
            | "google"
            | "google-interactions"
            | "google-vertex"
    ) {
        return Err(INVALID.into());
    }
    let mut result = json!({
        "id": id(&value["id"])?,
        "name": text(&value["name"], 120)?,
        "kind": kind,
    });
    if kind == "google-vertex" {
        // Rebuild metadata, never deserialize or retain a service account's secret fields.
        let vertex = VertexSettings {
            project_id: text(&value["vertex"]["projectId"], 30)?,
            location: text(&value["vertex"]["location"], 63)?,
        };
        result["baseUrl"] = json!(vertex.base_url()?);
        result["vertex"] = json!(vertex);
    } else {
        result["baseUrl"] = json!(endpoint(&value["baseUrl"])?);
    }
    if let Some(service) = value.get("service") {
        if !matches!(
            service.as_str(),
            Some(
                "openai"
                    | "anthropic"
                    | "google"
                    | "vertex-ai"
                    | "openrouter"
                    | "ollama-cloud"
                    | "cerebras"
                    | "nanogpt"
                    | "deepseek"
                    | "vercel-ai-gateway"
                    | "custom"
            )
        ) {
            return Err(INVALID.into());
        }
        result["service"] = service.clone();
    }
    Ok(result)
}

/// Rebuild an allowlisted document at the host boundary, including on restoration.
fn sanitize(value: &Value) -> Result<Value, String> {
    if !value.is_object() || value["version"].as_f64() != Some(1.0) {
        return Err(INVALID.into());
    }
    let providers = value["providers"].as_array().ok_or(INVALID)?;
    let models = value["models"].as_array().ok_or(INVALID)?;
    if providers.len() > 64 || models.len() > 256 {
        return Err(INVALID.into());
    }
    let providers: Vec<Value> = providers.iter().map(provider).collect::<Result<_, _>>()?;
    let provider_ids: HashSet<_> = providers
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    if provider_ids.len() != providers.len() {
        return Err(INVALID.into());
    }
    let models: Vec<Value> = models
        .iter()
        .map(|model| {
            if !model.is_object() {
                return Err(INVALID.to_owned());
            }
            let provider_id = id(&model["providerId"])?;
            if !provider_ids.contains(provider_id.as_str()) {
                return Err(INVALID.into());
            }
            Ok(json!({
                "id": id(&model["id"])?,
                "name": text(&model["name"], 120)?,
                "providerId": provider_id,
                "modelId": text(&model["modelId"], 256)?,
            }))
        })
        .collect::<Result<_, String>>()?;
    let model_ids: HashSet<_> = models
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    if model_ids.len() != models.len() {
        return Err(INVALID.into());
    }
    let default_model_id = match value.get("defaultModelId") {
        Some(Value::Null) => Value::Null,
        Some(value) => {
            let id = id(value)?;
            if !model_ids.contains(id.as_str()) {
                return Err(INVALID.into());
            }
            json!(id)
        }
        None => return Err(INVALID.into()),
    };
    Ok(
        json!({ "version": 1, "providers": providers, "models": models, "defaultModelId": default_model_id }),
    )
}

fn db_error(_: rusqlite::Error) -> String {
    STORE_ERROR.into()
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS ai_settings (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             revision INTEGER NOT NULL CHECK (revision > 0),
             value TEXT NOT NULL
         );",
        )
        .map_err(db_error)?;
    Ok(connection)
}

fn read(connection: &Connection) -> Result<Value, String> {
    let row: Option<(i64, String)> = connection
        .query_row(
            "SELECT revision,value FROM ai_settings WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((revision, stored)) = row else {
        return Ok(json!({ "settings": null, "revision": 0 }));
    };
    if !(1..=MAX_REVISION as i64).contains(&revision) || stored.len() > MAX_PAYLOAD {
        return Err(STORE_ERROR.into());
    }
    let value = serde_json::from_str(&stored).map_err(|_| STORE_ERROR)?;
    let settings = sanitize(&value).map_err(|_| STORE_ERROR)?;
    Ok(json!({ "settings": settings, "revision": revision }))
}

fn execute_request(path: &Path, input: Value) -> Result<Value, String> {
    if input.to_string().len() > MAX_PAYLOAD {
        return Err(INVALID.into());
    }
    let request: Request = serde_json::from_value(input).map_err(|_| INVALID)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(if matches!(request, Request::Read {}) {
            TransactionBehavior::Deferred
        } else {
            TransactionBehavior::Immediate
        })
        .map_err(db_error)?;
    match request {
        Request::Read {} => {}
        Request::Initialize { settings } => {
            let settings = sanitize(&settings)?;
            transaction.execute(
                "INSERT INTO ai_settings (id,revision,value) VALUES (1,1,?1) ON CONFLICT(id) DO NOTHING",
                [settings.to_string()],
            ).map_err(db_error)?;
        }
        Request::Write { settings, revision } => {
            let settings = sanitize(&settings)?;
            let revision = revision
                .as_u64()
                .filter(|revision| (1..MAX_REVISION).contains(revision))
                .ok_or(CONFLICT)?;
            if transaction.execute(
                "UPDATE ai_settings SET value=?1,revision=revision+1 WHERE id=1 AND revision=?2",
                params![settings.to_string(), revision as i64],
            ).map_err(db_error)? != 1 {
                return Err(CONFLICT.into());
            }
        }
    }
    let result = read(&transaction)?;
    transaction.commit().map_err(db_error)?;
    Ok(result)
}

#[tauri::command]
pub async fn ai_settings_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    path: tauri::State<'_, StoragePath>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" || !access.permits(&token) {
        return Err("허용하지 않는 AI 설정 요청이에요.".into());
    }
    let path = path.0.clone();
    tauri::async_runtime::spawn_blocking(move || execute_request(&path, request))
        .await
        .map_err(|_| "AI 설정 작업이 중단되었어요.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
        thread,
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 12];
            getrandom::fill(&mut random).unwrap();
            let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let directory = std::env::temp_dir().join(format!("helia-ai-settings-test-{name}"));
            std::fs::create_dir(&directory).unwrap();
            Self(directory)
        }
        fn path(&self) -> PathBuf {
            self.0.join("helia.sqlite")
        }
        fn execute(&self, request: Value) -> Result<Value, String> {
            execute_request(&self.path(), request)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn empty() -> Value {
        json!({ "version": 1, "providers": [], "models": [], "defaultModelId": null })
    }
    fn settings() -> Value {
        json!({ "version": 1,
            "providers": [{ "id": "provider", "name": " Connection ", "kind": "openai-compatible", "baseUrl": "https://EXAMPLE.com/v1///", "service": "custom" }],
            "models": [{ "id": "model", "name": " Model ", "providerId": "provider", "modelId": " exact/model " }],
            "defaultModelId": "model"
        })
    }

    #[test]
    fn restores_settings_after_reopening_without_touching_game_schema_version() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture.execute(json!({ "kind": "read" })).unwrap(),
            json!({ "settings": null, "revision": 0 })
        );
        let expected = fixture
            .execute(json!({ "kind": "initialize", "settings": settings() }))
            .unwrap();
        assert_eq!(expected["revision"], 1);
        assert_eq!(expected["settings"]["providers"][0]["name"], "Connection");
        assert_eq!(
            expected["settings"]["providers"][0]["baseUrl"],
            "https://example.com/v1"
        );
        assert_eq!(
            fixture.execute(json!({ "kind": "read" })).unwrap(),
            expected
        );
        assert_eq!(
            open(&fixture.path())
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn initialize_preserves_existing_settings_even_when_they_are_empty() {
        for original in [empty(), settings()] {
            let fixture = Fixture::new();
            let first = fixture
                .execute(json!({ "kind": "initialize", "settings": original }))
                .unwrap();
            assert_eq!(
                fixture
                    .execute(json!({ "kind": "initialize", "settings": settings() }))
                    .unwrap(),
                first
            );
        }
    }

    #[test]
    fn concurrent_initialization_never_overwrites_the_winner() {
        let fixture = Fixture::new();
        // Establish WAL before racing the independent connections.
        open(&fixture.path()).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = [empty(), settings()]
            .into_iter()
            .map(|settings| {
                let barrier = barrier.clone();
                let path = fixture.path();
                thread::spawn(move || {
                    barrier.wait();
                    execute_request(&path, json!({ "kind": "initialize", "settings": settings }))
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results[0], results[1]);
        assert_eq!(results[0]["revision"], 1);
    }

    #[test]
    fn concurrent_writes_allow_only_one_compare_and_swap() {
        let fixture = Fixture::new();
        fixture
            .execute(json!({ "kind": "initialize", "settings": settings() }))
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = [empty(), settings()]
            .into_iter()
            .map(|settings| {
                let barrier = barrier.clone();
                let path = fixture.path();
                thread::spawn(move || {
                    barrier.wait();
                    execute_request(
                        &path,
                        json!({ "kind": "write", "settings": settings, "revision": 1 }),
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .find_map(|result| result.as_ref().err())
                .unwrap(),
            CONFLICT
        );
        assert_eq!(
            fixture.execute(json!({ "kind": "read" })).unwrap()["revision"],
            2
        );
    }

    #[test]
    fn settings_coexist_with_game_storage_migrations() {
        for settings_first in [true, false] {
            let fixture = Fixture::new();
            if settings_first {
                fixture
                    .execute(json!({ "kind": "initialize", "settings": settings() }))
                    .unwrap();
            }
            let listed =
                crate::storage::execute_request(&fixture.path(), json!({ "kind": "list" }))
                    .unwrap();
            assert_eq!(listed["records"], json!([]));
            let saved = fixture
                .execute(json!({ "kind": "initialize", "settings": settings() }))
                .unwrap();
            assert_eq!(saved["revision"], 1);
            assert_eq!(saved["settings"], sanitize(&settings()).unwrap());
        }
    }

    #[test]
    fn write_requires_initialization_and_compare_and_swap_revision() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .execute(json!({ "kind": "write", "settings": empty(), "revision": 0 }))
                .unwrap_err(),
            CONFLICT
        );
        fixture
            .execute(json!({ "kind": "initialize", "settings": settings() }))
            .unwrap();
        let saved = fixture
            .execute(json!({ "kind": "write", "settings": empty(), "revision": 1 }))
            .unwrap();
        assert_eq!(saved, json!({ "settings": empty(), "revision": 2 }));
        for revision in [
            json!(0),
            json!(1),
            json!(-1),
            json!(1.5),
            json!("2"),
            Value::Null,
            json!(MAX_REVISION),
        ] {
            assert_eq!(
                fixture
                    .execute(
                        json!({ "kind": "write", "settings": settings(), "revision": revision })
                    )
                    .unwrap_err(),
                CONFLICT
            );
        }
        assert_eq!(fixture.execute(json!({ "kind": "read" })).unwrap(), saved);
    }

    #[test]
    fn rejects_invalid_untrusted_settings_without_changing_saved_document() {
        let fixture = Fixture::new();
        let original = fixture
            .execute(json!({ "kind": "initialize", "settings": settings() }))
            .unwrap();
        let mut invalid = vec![
            Value::Null,
            json!([]),
            json!({}),
            json!({ "version": 2, "providers": [], "models": [], "defaultModelId": null }),
        ];
        for (field, value) in [
            ("id", json!("bad/id")),
            ("name", json!("\nsecret")),
            ("name", json!("😀".repeat(61))),
            ("kind", json!("untrusted")),
            ("service", Value::Null),
            ("baseUrl", json!("https://user:secret@example.com")),
            ("baseUrl", json!("https://example.com?key=secret")),
            ("baseUrl", json!("https://example.com#secret")),
            ("baseUrl", json!("file:///private")),
        ] {
            let mut value_settings = settings();
            value_settings["providers"][0][field] = value;
            invalid.push(value_settings);
        }
        let mut duplicate = settings();
        duplicate["providers"]
            .as_array_mut()
            .unwrap()
            .push(settings()["providers"][0].clone());
        invalid.push(duplicate);
        let mut duplicate = settings();
        duplicate["models"]
            .as_array_mut()
            .unwrap()
            .push(settings()["models"][0].clone());
        invalid.push(duplicate);
        let mut dangling = settings();
        dangling["models"][0]["providerId"] = json!("missing");
        invalid.push(dangling);
        let mut dangling = settings();
        dangling["defaultModelId"] = json!("missing");
        invalid.push(dangling);
        let mut excessive = empty();
        excessive["providers"] = json!(vec![settings()["providers"][0].clone(); 65]);
        invalid.push(excessive);
        let mut excessive = empty();
        excessive["models"] = json!(vec![settings()["models"][0].clone(); 257]);
        invalid.push(excessive);
        for settings in invalid {
            let error = fixture
                .execute(json!({ "kind": "write", "settings": settings, "revision": 1 }))
                .unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert_eq!(
            fixture.execute(json!({ "kind": "read" })).unwrap(),
            original
        );
        assert!(
            fixture
                .execute(json!({ "kind": "read", "settings": empty() }))
                .is_err()
        );
    }

    #[test]
    fn sanitizes_secret_fields_at_every_metadata_level_and_rebuilds_vertex_address() {
        let fixture = Fixture::new();
        let mut input = settings();
        input["apiKey"] = json!("top-secret");
        input["providers"][0]["apiKey"] = json!("provider-secret");
        input["providers"][0]["kind"] = json!("google-vertex");
        input["providers"][0]["baseUrl"] = json!("https://untrusted.example?key=secret");
        input["providers"][0]["vertex"] = json!({ "projectId": " helia-test-project ", "location": " us-central1 ", "private_key": "vertex-secret" });
        input["providers"][0]["serviceAccount"] = json!({ "private_key": "account-secret" });
        input["models"][0]["apiKey"] = json!("model-secret");
        let saved = fixture
            .execute(json!({ "kind": "initialize", "settings": input }))
            .unwrap();
        assert_eq!(
            saved["settings"]["providers"][0]["baseUrl"],
            "https://us-central1-aiplatform.googleapis.com/v1/projects/helia-test-project/locations/us-central1/publishers/google"
        );
        assert!(!saved.to_string().contains("secret"));
        let stored: String = open(&fixture.path())
            .unwrap()
            .query_row("SELECT value FROM ai_settings", [], |row| row.get(0))
            .unwrap();
        assert!(!stored.contains("secret"));
        assert!(!stored.contains("apiKey"));
        for (field, value) in [
            ("projectId", "_invalid"),
            ("location", "https://attacker"),
            ("location", "us-central-"),
        ] {
            let mut value_settings = saved["settings"].clone();
            value_settings["providers"][0]["vertex"][field] = json!(value);
            assert!(sanitize(&value_settings).is_err());
        }
    }

    #[test]
    fn validates_stored_payload_and_sanitizes_unknown_fields_on_restore() {
        let fixture = Fixture::new();
        fixture
            .execute(json!({ "kind": "initialize", "settings": empty() }))
            .unwrap();
        let connection = open(&fixture.path()).unwrap();
        let mut untrusted = settings();
        untrusted["providers"][0]["apiKey"] = json!("restored-secret");
        connection
            .execute("UPDATE ai_settings SET value=?1", [untrusted.to_string()])
            .unwrap();
        assert!(
            !fixture
                .execute(json!({ "kind": "read" }))
                .unwrap()
                .to_string()
                .contains("restored-secret")
        );
        for text in ["not-json", "{}", "null"] {
            connection
                .execute("UPDATE ai_settings SET value=?1", [text])
                .unwrap();
            assert_eq!(
                fixture.execute(json!({ "kind": "read" })).unwrap_err(),
                STORE_ERROR
            );
        }
        connection
            .execute(
                "UPDATE ai_settings SET value=?1,revision=?2",
                params![empty().to_string(), (MAX_REVISION + 1) as i64],
            )
            .unwrap();
        assert_eq!(
            fixture.execute(json!({ "kind": "read" })).unwrap_err(),
            STORE_ERROR
        );
    }

    #[test]
    fn restricts_bridge_to_private_token_and_main_window() {
        let fixture = Fixture::new();
        let access = StorageAccess::new().unwrap();
        let script = access.initialization_script();
        assert!(
            script.find("window !== window.top").unwrap()
                < script.find("__HELIA_AI_SETTINGS__").unwrap()
        );
        assert!(script.contains("invoke('ai_settings_request', { request, token })"));
        assert!(script.contains("writable: false, configurable: false"));
        let token = script
            .split("const token = \"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let app = tauri::test::mock_builder()
            .manage(access)
            .manage(StoragePath(fixture.path()))
            .invoke_handler(tauri::generate_handler![ai_settings_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for (label, supplied, allowed) in [
            ("main", "forged", false),
            ("other", token.as_str(), false),
            ("main", token.as_str(), true),
        ] {
            let window = app.get_webview_window(label).unwrap_or_else(|| {
                tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                    .build()
                    .unwrap()
            });
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "ai_settings_request".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        json!({ "token": supplied, "request": { "kind": "read" } }),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            );
            assert_eq!(response.is_ok(), allowed);
        }
    }
    use tauri::Manager;
}
