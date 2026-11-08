use crate::storage::StorageAccess;
use crate::{
    credential_store,
    vertex::{self, ServiceAccount, VertexSettings},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::Read,
    time::{Duration, Instant},
};

const STORE_ERROR: &str =
    "OS 자격 증명 저장소를 사용할 수 없어요. 저장소 잠금과 접근 권한을 확인해주세요.";
const CATALOG_ERROR: &str = "모델 목록을 불러오지 못했어요. 연결 주소와 API 키를 확인해주세요.";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Address {
    id: String,
    kind: String,
    base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vertex: Option<VertexSettings>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Secret {
    id: String,
    kind: String,
    base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vertex: Option<VertexSettings>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_account: Option<ServiceAccount>,
}

impl Secret {
    fn matches(&self, address: &Address) -> bool {
        self.id == address.id
            && self.kind == address.kind
            && self.base_url == address.base_url
            && self.vertex == address.vertex
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Status {
        providers: Vec<Address>,
    },
    Save {
        provider: Address,
        api_key: Option<String>,
        service_account_json: Option<String>,
    },
    Delete {
        id: String,
    },
    Models {
        provider: Address,
    },
    Verify {
        provider: Address,
    },
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
}
fn validate_address(address: &Address) -> Result<(), String> {
    if address.kind == "google-vertex" {
        let vertex = address
            .vertex
            .as_ref()
            .ok_or("프로젝트 ID와 Vertex AI 리전을 입력해주세요.")?;
        if vertex.base_url()? != address.base_url {
            return Err("Vertex AI 연결 주소가 프로젝트와 리전에 맞지 않아요.".into());
        }
    } else if address.vertex.is_some() {
        return Err("서비스 계정 설정은 Vertex AI 연결에만 사용할 수 있어요.".into());
    }
    let url = reqwest::Url::parse(&address.base_url).map_err(|_| CATALOG_ERROR)?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !valid_id(&address.id)
        || !matches!(
            address.kind.as_str(),
            "openai-compatible"
                | "openai-responses"
                | "anthropic"
                | "google"
                | "google-interactions"
                | "google-vertex"
        )
        || address.base_url.len() > 2048
        || (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "연결 주소와 API 형식을 확인해주세요. HTTP는 로컬 주소에서만 사용할 수 있어요.".into(),
        );
    }
    Ok(())
}

trait CredentialStore {
    fn get(&self, id: &str) -> Result<Option<Secret>, String>;
    fn save(&self, secret: Secret) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}
struct OsStore;
impl OsStore {
    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new("com.helia.desktop.api", id).map_err(|_| STORE_ERROR.into())
    }
}
impl CredentialStore for OsStore {
    fn get(&self, id: &str) -> Result<Option<Secret>, String> {
        match credential_store::read(self, id)? {
            Some(value) => {
                let secret: Secret = serde_json::from_slice(&value).map_err(|_| STORE_ERROR)?;
                if secret.id != id {
                    return Err(STORE_ERROR.into());
                }
                validate_address(&Address {
                    id: secret.id.clone(),
                    kind: secret.kind.clone(),
                    base_url: secret.base_url.clone(),
                    vertex: secret.vertex.clone(),
                })?;
                if secret.kind == "google-vertex" {
                    secret
                        .service_account
                        .as_ref()
                        .ok_or(STORE_ERROR)?
                        .validate()?;
                }
                Ok(Some(secret))
            }
            None => Ok(None),
        }
    }
    fn save(&self, secret: Secret) -> Result<(), String> {
        credential_store::write(
            self,
            &secret.id,
            &serde_json::to_vec(&secret).map_err(|_| STORE_ERROR)?,
        )
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        credential_store::delete(self, id)
    }
}
impl credential_store::Entries for OsStore {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(id)?.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(STORE_ERROR.into()),
        }
    }
    fn put(&self, id: &str, value: &[u8]) -> Result<(), String> {
        self.entry(id)?
            .set_secret(value)
            .map_err(|_| STORE_ERROR.into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(STORE_ERROR.into()),
        }
    }
}

fn execute(input: Value, store: &impl CredentialStore) -> Result<Value, String> {
    if input.to_string().len() > 256 * 1024 {
        return Err("연결 요청이 너무 커요.".into());
    }
    let request: Request =
        serde_json::from_value(input).map_err(|_| "연결 요청 형식이 올바르지 않아요.")?;
    match request {
        Request::Status { providers } => {
            if providers.len() > 64 {
                return Err("연결 항목이 너무 많아요.".into());
            }
            let mut output = serde_json::Map::new();
            for provider in providers {
                validate_address(&provider)?;
                let configured = store
                    .get(&provider.id)?
                    .is_some_and(|secret| secret.matches(&provider));
                output.insert(provider.id, json!(configured));
            }
            Ok(Value::Object(output))
        }
        Request::Save {
            provider,
            api_key,
            service_account_json,
        } => save_credential(store, provider, api_key, service_account_json.as_deref()),
        Request::Delete { id } => {
            if !valid_id(&id) {
                return Err("연결 식별자가 올바르지 않아요.".into());
            }
            store.delete(&id)?;
            vertex::clear_tokens();
            Ok(json!({}))
        }
        Request::Models { provider } => {
            validate_address(&provider)?;
            let secret = store
                .get(&provider.id)?
                .filter(|secret| secret.matches(&provider))
                .ok_or("이 연결의 주소와 형식에 사용할 인증 정보를 먼저 저장해주세요.")?;
            discover(&secret)
        }
        Request::Verify { provider } => {
            validate_address(&provider)?;
            let secret = store
                .get(&provider.id)?
                .filter(|secret| secret.matches(&provider))
                .ok_or("이 연결의 인증 정보를 먼저 저장해주세요.")?;
            let account = secret
                .service_account
                .as_ref()
                .ok_or("서비스 계정 인증은 Vertex AI 연결에서 사용할 수 있어요.")?;
            let _token = vertex::access_token(account)?;
            Ok(json!({ "verified": true }))
        }
    }
}

fn save_credential(
    store: &impl CredentialStore,
    provider: Address,
    api_key: Option<String>,
    service_account_json: Option<&str>,
) -> Result<Value, String> {
    validate_address(&provider)?;
    let service_account = if provider.kind == "google-vertex" {
        if api_key.is_some() {
            return Err("Vertex AI에는 Service Account JSON을 입력해주세요.".into());
        }
        Some(ServiceAccount::parse(
            service_account_json.ok_or("Service Account JSON을 입력해주세요.")?,
        )?)
    } else {
        if service_account_json.is_some() {
            return Err("서비스 계정은 Vertex AI 연결에만 사용할 수 있어요.".into());
        }
        None
    };
    let api_key = api_key.unwrap_or_default();
    if service_account.is_none()
        && (api_key.trim().is_empty()
            || api_key.len() > 2048
            || api_key.chars().any(char::is_control))
    {
        return Err("API 키를 확인해주세요.".into());
    }
    store.save(Secret {
        id: provider.id,
        kind: provider.kind,
        base_url: provider.base_url,
        vertex: provider.vertex,
        api_key: api_key.trim().into(),
        service_account,
    })?;
    vertex::clear_tokens();
    Ok(json!({}))
}
fn catalog_request(
    client: &reqwest::blocking::Client,
    secret: &Secret,
    cursor: &str,
    remaining: Duration,
) -> Result<reqwest::blocking::RequestBuilder, String> {
    let mut url = reqwest::Url::parse(&format!("{}/models", secret.base_url.trim_end_matches('/')))
        .map_err(|_| CATALOG_ERROR)?;
    let mut request = client.get(url.clone()).timeout(remaining);
    if matches!(secret.kind.as_str(), "google" | "google-interactions") {
        url.query_pairs_mut().append_pair("pageSize", "1000");
        if !cursor.is_empty() {
            url.query_pairs_mut().append_pair("pageToken", cursor);
        }
        request = client
            .get(url)
            .timeout(remaining)
            .header("x-goog-api-key", &secret.api_key);
    } else if secret.kind == "anthropic" {
        url.query_pairs_mut().append_pair("limit", "1000");
        if !cursor.is_empty() {
            url.query_pairs_mut().append_pair("after_id", cursor);
        }
        request = client
            .get(url)
            .timeout(remaining)
            .header("x-api-key", &secret.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(&secret.api_key);
    }
    Ok(request)
}
fn catalog_model(secret: &Secret, entry: &Value) -> Result<Option<Value>, String> {
    if matches!(secret.kind.as_str(), "google" | "google-interactions")
        && entry["supportedGenerationMethods"]
            .as_array()
            .is_some_and(|methods| !methods.iter().any(|method| method == "generateContent"))
    {
        return Ok(None);
    }
    let id = entry[if matches!(secret.kind.as_str(), "google" | "google-interactions") {
        "name"
    } else {
        "id"
    }]
    .as_str()
    .ok_or(CATALOG_ERROR)?;
    let id = if matches!(secret.kind.as_str(), "google" | "google-interactions") {
        id.strip_prefix("models/").unwrap_or(id)
    } else {
        id
    };
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(CATALOG_ERROR.into());
    }
    let name: String = entry["displayName"]
        .as_str()
        .or(entry["display_name"].as_str())
        .or(entry["name"].as_str())
        .unwrap_or(id)
        .chars()
        .take(120)
        .collect();
    let mut model = json!({ "id": id, "name": name });
    if let Some(description) = entry["description"].as_str() {
        model["description"] = json!(description.chars().take(500).collect::<String>());
    }
    if ["id", "name", "description"].iter().any(|field| {
        model[*field]
            .as_str()
            .is_some_and(|text| text.contains(&secret.api_key))
    }) {
        return Err(CATALOG_ERROR.into());
    }
    Ok(Some(model))
}

fn discover(secret: &Secret) -> Result<Value, String> {
    if secret.kind == "google-vertex" {
        return Err("Vertex AI에서는 모델 ID를 직접 추가해주세요.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| CATALOG_ERROR)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut cursor = String::new();
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for _ in 0..20 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CATALOG_ERROR.into());
        }
        let request = catalog_request(&client, secret, &cursor, remaining)?;
        let response = request.send().map_err(|_| CATALOG_ERROR)?;
        if !response.status().is_success() {
            return Err(CATALOG_ERROR.into());
        }
        let mut bytes = Vec::new();
        response
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| CATALOG_ERROR)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(CATALOG_ERROR.into());
        }
        let payload: Value = serde_json::from_slice(&bytes).map_err(|_| CATALOG_ERROR)?;
        let entries = payload[if matches!(secret.kind.as_str(), "google" | "google-interactions") {
            "models"
        } else {
            "data"
        }]
        .as_array()
        .ok_or(CATALOG_ERROR)?;
        for entry in entries {
            let Some(model) = catalog_model(secret, entry)? else {
                continue;
            };
            let id = model["id"].as_str().ok_or(CATALOG_ERROR)?;
            if seen.insert(id.to_owned()) {
                models.push(model);
            }
            if models.len() > 10000 {
                return Err(CATALOG_ERROR.into());
            }
        }
        let next = if matches!(secret.kind.as_str(), "google" | "google-interactions") {
            payload["nextPageToken"].as_str()
        } else if secret.kind == "anthropic" && payload["has_more"] == true {
            payload["last_id"].as_str()
        } else {
            None
        };
        if secret.kind == "anthropic"
            && payload["has_more"] == true
            && next.is_none_or(str::is_empty)
        {
            return Err(CATALOG_ERROR.into());
        }
        match next {
            None | Some("") => return Ok(json!(models)),
            Some(next) if next != cursor && next.len() <= 2048 => cursor = next.to_owned(),
            _ => return Err(CATALOG_ERROR.into()),
        }
    }
    Err(CATALOG_ERROR.into())
}

/// Trusted host only; never exposed as an IPC command or returned to the WebView.
pub(crate) fn generation_auth(provider: Value) -> Result<(String, String, String), String> {
    let address: Address = serde_json::from_value(provider).map_err(|_| CATALOG_ERROR)?;
    validate_address(&address)?;
    let secret = OsStore
        .get(&address.id)?
        .filter(|secret| secret.matches(&address))
        .ok_or("이 연결에 사용할 인증 정보를 먼저 저장해주세요.")?;
    let key = if let Some(account) = &secret.service_account {
        vertex::access_token(account)?
    } else {
        secret.api_key
    };
    Ok((address.base_url, address.kind, key))
}

#[tauri::command]
pub async fn credential_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" || !access.permits(&token) {
        return Err("허용하지 않는 연결 요청이에요.".into());
    }
    tauri::async_runtime::spawn_blocking(move || execute(request, &OsStore))
        .await
        .map_err(|_| "연결 작업이 중단되었어요.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap, io::Write, net::TcpListener, thread};

    /// Exercise the actual native HTTP adapter without external services or real credentials.
    fn catalogue_fixture(
        kind: &str,
        api_key: &str,
        pages: Vec<Value>,
    ) -> (Result<Value, String>, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let host = thread::spawn(move || {
            let mut requests = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            for page in pages {
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("Fixture connection failed: {error}"),
                    }
                };
                // Windows accepts inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    assert!(bytes.len() <= 16384);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = page.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            requests
        });
        let result = discover(&Secret {
            id: "fixture".into(),
            kind: kind.into(),
            base_url,
            api_key: api_key.into(),
            vertex: None,
            service_account: None,
        });
        (result, host.join().unwrap())
    }

    #[test]
    fn native_catalogues_use_provider_headers_pagination_and_exact_model_ids() {
        let (models, requests) = catalogue_fixture(
            "openai-compatible",
            "test-only-secret",
            vec![json!({ "data": [{ "id": "models/custom" }] })],
        );
        assert_eq!(
            models.unwrap(),
            json!([{ "id": "models/custom", "name": "models/custom" }])
        );
        assert!(
            requests[0]
                .to_lowercase()
                .contains("authorization: bearer test-only-secret")
        );

        let (models, requests) = catalogue_fixture(
            "google",
            "test-only-secret",
            vec![
                json!({ "models": [{ "name": "models/generative", "supportedGenerationMethods": ["generateContent"] }, { "name": "models/embedding", "supportedGenerationMethods": ["embedContent"] }], "nextPageToken": "next" }),
                json!({ "models": [{ "name": "models/second" }] }),
            ],
        );
        let models = models.unwrap();
        assert_eq!(models.as_array().unwrap().len(), 2);
        assert_eq!(models[0]["id"], "generative");
        assert!(
            requests[0]
                .to_lowercase()
                .contains("x-goog-api-key: test-only-secret")
        );
        assert!(requests[1].contains("pageToken=next"));

        let (models, requests) = catalogue_fixture(
            "anthropic",
            "test-only-secret",
            vec![
                json!({ "data": [{ "id": "first", "display_name": "First" }], "has_more": true, "last_id": "first" }),
                json!({ "data": [{ "id": "first" }, { "id": "second" }], "has_more": false }),
            ],
        );
        assert_eq!(models.unwrap().as_array().unwrap().len(), 2);
        assert!(
            requests[0]
                .to_lowercase()
                .contains("x-api-key: test-only-secret")
        );
        assert!(requests[0].contains("anthropic-version: 2023-06-01"));
        assert!(requests[1].contains("after_id=first"));
    }

    #[test]
    fn native_catalogues_never_return_reflected_secrets_or_partial_pages() {
        let api_key = "test-\"quoted\\secret";
        let (result, _) = catalogue_fixture(
            "openai-compatible",
            api_key,
            vec![json!({ "data": [{ "id": "model", "name": api_key }] })],
        );
        assert_eq!(result.unwrap_err(), CATALOG_ERROR);
        let (result, _) = catalogue_fixture(
            "anthropic",
            "test-only-secret",
            vec![json!({ "data": [{ "id": "model" }], "has_more": true })],
        );
        assert_eq!(result.unwrap_err(), CATALOG_ERROR);
    }

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn get(&self, id: &str) -> Result<Option<Secret>, String> {
            self.0
                .borrow()
                .get(id)
                .map(|value| serde_json::from_str(value).map_err(|_| STORE_ERROR.to_owned()))
                .transpose()
        }
        fn save(&self, secret: Secret) -> Result<(), String> {
            self.0
                .borrow_mut()
                .insert(secret.id.clone(), serde_json::to_string(&secret).unwrap());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }
    fn address() -> Value {
        json!({ "id": "test-connection", "kind": "openai-compatible", "baseUrl": "https://example.com/v1" })
    }

    #[test]
    fn stores_keys_without_returning_them_and_binds_to_the_endpoint() {
        let store = MemoryStore::default();
        assert_eq!(
            execute(
                json!({ "kind": "save", "provider": address(), "apiKey": "test-only-secret" }),
                &store
            )
            .unwrap(),
            json!({})
        );
        let status = execute(
            json!({ "kind": "status", "providers": [address()] }),
            &store,
        )
        .unwrap();
        assert_eq!(status, json!({ "test-connection": true }));
        assert!(!status.to_string().contains("test-only-secret"));
        let mut edited = address();
        edited["baseUrl"] = json!("https://other.example.com/v1");
        assert_eq!(
            execute(
                json!({ "kind": "status", "providers": [edited.clone()] }),
                &store
            )
            .unwrap(),
            json!({ "test-connection": false })
        );
        assert!(execute(json!({ "kind": "models", "provider": edited }), &store).is_err());
        execute(json!({ "kind": "delete", "id": "test-connection" }), &store).unwrap();
        assert_eq!(
            execute(
                json!({ "kind": "status", "providers": [address()] }),
                &store
            )
            .unwrap(),
            json!({ "test-connection": false })
        );
    }
    #[test]
    fn rejects_malformed_or_insecure_connections_before_accessing_os_storage() {
        let store = MemoryStore::default();
        for url in [
            "https://user:pass@example.com",
            "https://example.com?key=secret",
            "http://remote.example.com",
            "file:///tmp/secret",
        ] {
            let mut provider = address();
            provider["baseUrl"] = json!(url);
            assert!(
                execute(
                    json!({ "kind": "save", "provider": provider, "apiKey": "test-only-secret" }),
                    &store
                )
                .is_err()
            );
        }
        assert!(store.0.borrow().is_empty());
    }

    #[test]
    fn vertex_service_accounts_are_bound_to_the_project_and_region_without_exposing_keys() {
        let store = MemoryStore::default();
        let provider = json!({ "id": "vertex", "kind": "google-vertex", "baseUrl": "https://aiplatform.googleapis.com/v1/projects/helia-test-project/locations/global/publishers/google", "vertex": { "projectId": "helia-test-project", "location": "global" } });
        execute(
            json!({ "kind": "save", "provider": provider, "serviceAccountJson": include_str!("../../src/lib/testing/fixtures/service-account.json") }),
            &store,
        )
        .unwrap();
        assert_eq!(
            execute(json!({ "kind": "status", "providers": [provider] }), &store).unwrap(),
            json!({ "vertex": true })
        );
        assert_eq!(
            execute(json!({ "kind": "models", "provider": provider }), &store).unwrap_err(),
            "Vertex AI에서는 모델 ID를 직접 추가해주세요."
        );
        let mut changed = provider.clone();
        changed["vertex"]["location"] = json!("us-central1");
        changed["baseUrl"] = json!(
            "https://us-central1-aiplatform.googleapis.com/v1/projects/helia-test-project/locations/us-central1/publishers/google"
        );
        assert_eq!(
            execute(json!({ "kind": "status", "providers": [changed] }), &store).unwrap(),
            json!({ "vertex": false })
        );
        assert!(
            execute(
                json!({ "kind": "save", "provider": provider, "apiKey": "express-key" }),
                &store
            )
            .is_err()
        );
    }
    #[test]
    fn dispatches_only_through_the_main_frame_credential_guard() {
        let access = StorageAccess::new().unwrap();
        let script = access.initialization_script();
        assert!(script.contains("window !== window.top"));
        assert!(script.contains("__HELIA_CREDENTIALS__"));
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
            .invoke_handler(tauri::generate_handler![credential_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for (supplied, allowed) in [("forged".to_owned(), false), (token, true)] {
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "credential_request".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        json!({ "token": supplied, "request": { "kind": "status", "providers": [] } }),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            );
            assert_eq!(response.is_ok(), allowed);
        }
    }

    #[test]
    #[ignore = "explicit OS-store smoke test: writes and deletes only a random test entry"]
    fn os_store_roundtrips_large_test_credentials() {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        let id = format!(
            "helia-test-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let store = OsStore;
        let bytes = vec![42; 12000];
        let saved = credential_store::write(&store, &id, &bytes);
        let restored = credential_store::read(&store, &id);
        let cleaned = credential_store::delete(&store, &id);
        saved.unwrap();
        cleaned.unwrap();
        assert_eq!(restored.unwrap(), Some(bytes));
    }
}
