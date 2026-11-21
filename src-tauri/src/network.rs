//! Credential-free, single-hop HTTP transport. The trusted UI owns origin consent.
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Method, Url,
    header::{HeaderName, HeaderValue},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{async_runtime::JoinHandle, ipc::Channel};

use crate::storage::StorageAccess;

const ERROR: &str = "Fetch failed";
const REQUEST_BYTES: usize = 8 * 1024 * 1024;
const RESPONSE_BYTES: usize = 32 * 1024 * 1024;
static JOBS: OnceLock<Mutex<HashMap<String, JoinHandle<()>>>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchInput {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                || (a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113)
                || ip.octets() == [168, 63, 129, 16])
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn target(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| ERROR)?;
    if value.len() > 8192
        || !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ERROR.into());
    }
    Ok(url)
}
fn addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url.host_str().ok_or(ERROR)?.trim_matches(['[', ']']);
    let addresses: Vec<_> = (host, url.port_or_known_default().ok_or(ERROR)?)
        .to_socket_addrs()
        .map_err(|_| ERROR)?
        .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        return Err(ERROR.into());
    }
    Ok(addresses)
}
fn header_allowed(name: &str) -> bool {
    !name.starts_with("sec-")
        && !name.starts_with("proxy-")
        && !matches!(
            name,
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "upgrade"
                | "expect"
                | "trailer"
                | "te"
                | "cookie"
                | "cookie2"
                | "origin"
                | "referer"
                | "accept-encoding"
        )
}
fn validate(input: &FetchInput) -> Result<(Url, Method, Vec<u8>), String> {
    let url = target(&input.url)?;
    let method = Method::from_bytes(input.method.as_bytes()).map_err(|_| ERROR)?;
    if input.method.len() > 32
        || matches!(
            input.method.to_uppercase().as_str(),
            "CONNECT" | "TRACE" | "TRACK"
        )
        || input.headers.len() > 128
        || input
            .headers
            .iter()
            .map(|(a, b)| a.len() + b.len() + 8)
            .sum::<usize>()
            > 16384
    {
        return Err(ERROR.into());
    }
    if input
        .body
        .as_ref()
        .is_some_and(|body| body.len() > REQUEST_BYTES.div_ceil(3) * 4)
        || (input.body.is_some() && matches!(input.method.to_uppercase().as_str(), "GET" | "HEAD"))
    {
        return Err(ERROR.into());
    }
    let body = STANDARD
        .decode(input.body.as_deref().unwrap_or_default())
        .map_err(|_| ERROR)?;
    if body.len() > REQUEST_BYTES {
        return Err(ERROR.into());
    }
    Ok((url, method, body))
}
async fn execute(input: FetchInput, channel: &Channel<Value>) -> Result<(), String> {
    let (url, method, body) = validate(&input)?;
    let destination = url.clone();
    let addresses = tauri::async_runtime::spawn_blocking(move || addresses(&destination))
        .await
        .map_err(|_| ERROR)??;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(600))
        .resolve_to_addrs(
            url.host_str().ok_or(ERROR)?.trim_matches(['[', ']']),
            &addresses,
        )
        .build()
        .map_err(|_| ERROR)?;
    let mut request = client
        .request(method, url)
        .header("accept-encoding", "identity")
        .body(body);
    for (name, value) in input.headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| ERROR)?;
        if !header_allowed(name.as_str()) {
            return Err(ERROR.into());
        }
        request = request.header(name, HeaderValue::from_str(&value).map_err(|_| ERROR)?);
    }
    let mut response = request.send().await.map_err(|_| ERROR)?;
    let headers: Vec<_> = response
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != "set-cookie")
        .map(|(name, value)| (name.as_str(), value.to_str().unwrap_or_default()))
        .collect();
    if serde_json::to_vec(&headers).map_err(|_| ERROR)?.len() > 16384 {
        return Err(ERROR.into());
    }
    channel.send(json!({"kind":"head","head":{"status":response.status().as_u16(),"statusText":response.status().canonical_reason().unwrap_or_default(),"headers":headers}})).map_err(|_| ERROR)?;
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        size += chunk.len();
        if size > RESPONSE_BYTES {
            return Err(ERROR.into());
        }
        channel
            .send(json!({"kind":"chunk","data":STANDARD.encode(chunk)}))
            .map_err(|_| ERROR)?;
    }
    channel.send(json!({"kind":"end"})).map_err(|_| ERROR)?;
    Ok(())
}
fn dispatch(request: Value, channel: Channel<Value>) -> Result<(), String> {
    let id = request["id"]
        .as_str()
        .filter(|id| id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
        .ok_or(ERROR)?
        .to_owned();
    let mut jobs = JOBS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| ERROR)?;
    if request["kind"] == "cancel" {
        if let Some(job) = jobs.remove(&id) {
            job.abort();
        }
        return Ok(());
    }
    if request["kind"] != "fetch" || jobs.len() >= 32 || jobs.contains_key(&id) {
        return Err(ERROR.into());
    }
    let input: FetchInput =
        serde_json::from_value(request["request"].clone()).map_err(|_| ERROR)?;
    validate(&input)?;
    let key = id.clone();
    let job = tauri::async_runtime::spawn(async move {
        if execute(input, &channel).await.is_err() {
            let _ = channel.send(json!({"kind":"error"}));
        }
        if let Ok(mut jobs) = JOBS.get().unwrap().lock() {
            jobs.remove(&key);
        }
    });
    jobs.insert(id, job);
    Ok(())
}

#[tauri::command]
pub async fn network_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    request: Value,
    on_chunk: Channel<Value>,
) -> Result<(), String> {
    if window.label() != "main" || !access.permits(&token) {
        return Err(ERROR.into());
    }
    dispatch(request, on_chunk)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_internal_and_special_destinations() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.168.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::",
            "fe80::1",
            "168.63.129.16",
        ] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_address(address.parse().unwrap()));
        }
    }
    #[test]
    fn validates_methods_headers_urls_and_body() {
        for value in [
            "file:///etc/passwd",
            "https://user:pass@example.com",
            "data:text/plain,secret",
        ] {
            assert!(target(value).is_err());
        }
        for header in ["cookie", "sec-fetch-site", "host", "proxy-authorization"] {
            assert!(!header_allowed(header));
        }
        assert!(header_allowed("authorization"));
        let mut input = FetchInput {
            url: "https://example.com".into(),
            method: "POST".into(),
            headers: vec![],
            body: Some(STANDARD.encode([0, 255])),
        };
        assert_eq!(validate(&input).unwrap().2, vec![0, 255]);
        input.method = "GET".into();
        assert!(validate(&input).is_err());
        input.method = "CONNECT".into();
        input.body = None;
        assert!(validate(&input).is_err());
    }
    #[test]
    fn private_addresses_fail_before_any_http_request() {
        for value in [
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data/",
        ] {
            assert!(addresses(&target(value).unwrap()).is_err());
        }
    }
    #[test]
    fn network_ipc_requires_the_private_main_frame_token() {
        use tauri::Manager;
        let access = StorageAccess::new().unwrap();
        let token = access
            .initialization_script()
            .split("const token = \"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let app = tauri::test::mock_builder()
            .manage(access)
            .invoke_handler(tauri::generate_handler![network_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for label in ["main", "untrusted"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            for supplied in ["forged", token.as_str()] {
                let response = tauri::test::get_ipc_response(
                    &window,
                    tauri::webview::InvokeRequest {
                        cmd: "network_request".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: "http://tauri.localhost".parse().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(
                            json!({"token":supplied,"request":{"kind":"cancel","id":"00000000-0000-4000-8000-000000000001"},"onChunk":"__CHANNEL__:0"}),
                        ),
                        headers: Default::default(),
                        invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                    },
                );
                assert_eq!(response.is_ok(), label == "main" && supplied == token);
            }
        }
        assert!(app.state::<StorageAccess>().permits(&token));
    }
}
