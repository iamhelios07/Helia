use crate::{credentials, storage::StorageAccess};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;

const ERROR: &str = "AI 요청을 완료하지 못했어요. 연결과 모델 권한을 확인해주세요.";
const BUSY: &str = "AI 응답 생성 중에는 게임 상태를 변경할 수 없어요.";
const CANCELED: &str = "AI 요청을 중단했어요.";
struct Lease {
    game: String,
    session: String,
    expires: Instant,
    rounds: usize,
}
static LEASES: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
fn leases() -> Result<MutexGuard<'static, HashMap<String, Lease>>, String> {
    let mut leases = LEASES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| ERROR)?;
    leases.retain(|_, lease| lease.expires > Instant::now());
    Ok(leases)
}
fn field<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or_else(|| ERROR.into())
}
fn valid(id: &str, game: &str, session: &str) -> Result<(), String> {
    let leases = leases()?;
    if leases
        .get(id)
        .is_none_or(|l| l.game != game || l.session != session)
    {
        return Err(CANCELED.into());
    }
    Ok(())
}

/// Hold this guard through the short database operation so release cannot race its commit.
pub(crate) fn guard_storage(input: &Value) -> Result<impl Drop + use<>, String> {
    let leases = leases()?;
    let game = input["gameId"].as_str().unwrap_or_default();
    let mut affected = Vec::new();
    if input["kind"] == "prune" {
        affected.push(input["sessionId"].as_str().unwrap_or_default());
    }
    if input["kind"] == "commit" {
        if let Some(records) = input["records"].as_array() {
            for record in records {
                if matches!(
                    record["table"].as_str(),
                    Some("progress" | "messages" | "transactions")
                ) {
                    affected.push(record["sessionId"].as_str().unwrap_or_default());
                }
            }
        }
        if let Some(deleted) = input["deleteSessions"].as_array() {
            for id in deleted {
                affected.push(id.as_str().unwrap_or_default());
            }
        }
    }
    let supplied = input["aiLease"].as_str();
    if let Some(id) = supplied {
        let lease = leases.get(id).ok_or(CANCELED)?;
        if lease.game != game || affected.iter().any(|session| *session != lease.session) {
            return Err(CANCELED.into());
        }
    }
    for (id, lease) in leases.iter() {
        if lease.game == game
            && affected.contains(&lease.session.as_str())
            && Some(id.as_str()) != supplied
        {
            return Err(BUSY.into());
        }
    }
    Ok(leases)
}

type Authenticate = fn(Value) -> Result<(String, String, String), String>;
fn begin_lease(game: &str, session: &str) -> Result<Value, String> {
    let mut leases = leases()?;
    if leases
        .values()
        .any(|l| l.game == game && l.session == session)
    {
        return Err(BUSY.into());
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ERROR)?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    leases.insert(
        id.clone(),
        Lease {
            game: game.into(),
            session: session.into(),
            expires: Instant::now() + Duration::from_secs(120),
            rounds: 0,
        },
    );
    Ok(json!({"lease":id}))
}
fn release_lease(id: &str, game: &str, session: &str) -> Result<Value, String> {
    let mut leases = leases()?;
    if leases
        .get(id)
        .is_some_and(|l| l.game == game && l.session == session)
    {
        leases.remove(id);
    }
    Ok(json!({}))
}
fn validate_wire(input: &Value, format: &str, path: &str) -> Result<(), String> {
    let expected = match format {
        "openai-compatible" => path == "/chat/completions",
        "openai-responses" => path == "/responses",
        "anthropic" => path == "/messages",
        "google-interactions" => path == "/interactions",
        _ => {
            path.starts_with("/models/")
                && path.ends_with(":streamGenerateContent?alt=sse")
                && !path.contains("..")
                && !path.contains('#')
        }
    };
    if !expected
        || input["wire"]["body"]["model"]
            .as_str()
            .is_some_and(|model| Some(model) != input["request"]["model"].as_str())
    {
        return Err(ERROR.into());
    }
    Ok(())
}
fn send_round(
    input: &Value,
    base: &str,
    format: &str,
    key: &str,
    path: &str,
) -> Result<reqwest::blocking::Response, String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| ERROR)?;
    let mut request = client
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .body(input["wire"]["body"].to_string());
    if format == "anthropic" {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    } else if format == "google" || format == "google-interactions" {
        request = request.header("x-goog-api-key", key);
    } else {
        request = request.bearer_auth(key);
    }
    let response = request.send().map_err(|_| ERROR)?;
    if !response.status().is_success() {
        return Err(ERROR.into());
    }
    Ok(response)
}
struct RoundOutput<'a> {
    id: &'a str,
    game: &'a str,
    session: &'a str,
    key: &'a str,
    escaped: &'a str,
    keep: usize,
    channel: &'a Channel<Value>,
}
fn read_json(
    response: reqwest::blocking::Response,
    output: &RoundOutput<'_>,
) -> Result<Value, String> {
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(ERROR.into());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| ERROR)?
        .replace(output.key, "[redacted]")
        .replace(output.escaped, "[redacted]");
    let payload: Value = serde_json::from_str(&text).map_err(|_| ERROR)?;
    valid(output.id, output.game, output.session)?;
    output
        .channel
        .send(json!({"chunk":format!("data: {}\n\n",json!({"helia_nonstream":payload}))}))
        .map_err(|_| CANCELED)?;
    output
        .channel
        .send(json!({"done":true}))
        .map_err(|_| CANCELED)?;
    Ok(json!({}))
}
fn read_stream(
    mut response: reqwest::blocking::Response,
    output: &RoundOutput<'_>,
) -> Result<Value, String> {
    let mut pending = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut total = 0;
    loop {
        valid(output.id, output.game, output.session)?;
        let length = response.read(&mut buffer).map_err(|_| ERROR)?;
        pending.extend_from_slice(&buffer[..length]);
        total += length;
        if total > 2 * 1024 * 1024 {
            return Err(ERROR.into());
        }
        // Preserve incomplete UTF-8 and a credential-length suffix between chunks.
        let valid_bytes = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err(ERROR.into()),
        };
        let text = std::str::from_utf8(&pending[..valid_bytes])
            .map_err(|_| ERROR)?
            .replace(output.key, "[redacted]")
            .replace(output.escaped, "[redacted]");
        let mut split = if length == 0 {
            text.len()
        } else {
            text.len().saturating_sub(output.keep)
        };
        while !text.is_char_boundary(split) {
            split -= 1;
        }
        if split > 0 {
            output
                .channel
                .send(json!({"chunk":&text[..split]}))
                .map_err(|_| CANCELED)?;
        }
        let mut remaining = text.as_bytes()[split..].to_vec();
        remaining.extend_from_slice(&pending[valid_bytes..]);
        pending = remaining;
        if length == 0 {
            if !pending.is_empty() {
                return Err(ERROR.into());
            }
            break;
        }
    }
    valid(output.id, output.game, output.session)?;
    output
        .channel
        .send(json!({"done":true}))
        .map_err(|_| CANCELED)?;
    Ok(json!({}))
}

fn execute(input: &Value, channel: &Channel<Value>) -> Result<Value, String> {
    execute_with_auth(input, channel, credentials::generation_auth)
}
fn execute_with_auth(
    input: &Value,
    channel: &Channel<Value>,
    authenticate: Authenticate,
) -> Result<Value, String> {
    if input.to_string().len() > 4 * 1024 * 1024 {
        return Err(ERROR.into());
    }
    let game = field(input, "gameId")?;
    let session = field(input, "sessionId")?;
    let kind = field(input, "kind")?;
    if kind == "begin" {
        return begin_lease(game, session);
    }
    let id = field(input, "lease")?;
    if kind == "release" {
        return release_lease(id, game, session);
    }
    if kind != "round" {
        return Err(ERROR.into());
    }
    valid(id, game, session)?;
    {
        let mut leases = leases()?;
        let lease = leases.get_mut(id).ok_or(CANCELED)?;
        lease.rounds += 1;
        if lease.rounds > 36 {
            return Err(ERROR.into());
        }
    }
    let (base, format, key) = authenticate(input["request"]["provider"].clone())?;
    let path = input["wire"]["path"].as_str().ok_or(ERROR)?;
    validate_wire(input, &format, path)?;
    let response = send_round(input, &base, &format, &key, path)?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let sse = content_type.contains("text/event-stream");
    if !sse && !content_type.contains("application/json") {
        return Err(ERROR.into());
    }
    let escaped = serde_json::to_string(&key).map_err(|_| ERROR)?;
    let escaped = &escaped[1..escaped.len() - 1];
    let keep = key.len().max(escaped.len());
    let output = RoundOutput {
        id,
        game,
        session,
        key: &key,
        escaped,
        keep,
        channel,
    };
    if !sse {
        return read_json(response, &output);
    }
    read_stream(response, &output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, sync::Arc, thread};
    fn channel() -> Channel<Value> {
        Channel::new(|_| Ok(()))
    }
    fn test_game() -> String {
        let mut bytes = [0; 8];
        getrandom::fill(&mut bytes).unwrap();
        format!("test-{:x}", u64::from_le_bytes(bytes))
    }
    #[test]
    fn leases_reject_other_writes_and_expired_commit_tokens() {
        let game = test_game();
        let begun = execute(
            &json!({"kind":"begin","gameId":game,"sessionId":"one"}),
            &channel(),
        )
        .unwrap();
        let id = begun["lease"].as_str().unwrap();
        assert!(
            execute(
                &json!({"kind":"begin","gameId":game,"sessionId":"one"}),
                &channel()
            )
            .is_err()
        );
        let write = json!({"kind":"commit","gameId":game,"records":[{"table":"progress","sessionId":"one"}],"deleteSessions":[]});
        assert!(guard_storage(&write).is_err());
        {
            let _allowed=guard_storage(&json!({"aiLease":id,"kind":"commit","gameId":game,"records":[{"table":"progress","sessionId":"one"}],"deleteSessions":[]})).unwrap();
        }
        execute(
            &json!({"kind":"release","gameId":game,"sessionId":"one","lease":id}),
            &channel(),
        )
        .unwrap();
        assert!(guard_storage(&json!({"aiLease":id,"kind":"commit","gameId":game,"records":[],"deleteSessions":[]})).is_err());
    }
    #[test]
    fn native_stream_uses_host_authentication_and_redacts_reflected_keys() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0; 4096];
            let length = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..length]).to_ascii_lowercase();
            assert!(request.contains("authorization: bearer test-native-key"));
            let body = "data: {\"text\":\"test-native-key\"}\n\n";
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let messages = Arc::new(Mutex::new(Vec::new()));
        let target = messages.clone();
        let output = Channel::<Value>::new(move |body| {
            target.lock().unwrap().push(body);
            Ok(())
        });
        let game = test_game();
        let begun = execute(
            &json!({"kind":"begin","gameId":game,"sessionId":"one"}),
            &channel(),
        )
        .unwrap();
        let id = begun["lease"].as_str().unwrap();
        let result = execute_with_auth(
            &json!({"kind":"round","gameId":game,"sessionId":"one","lease":id,"request":{"provider":{"baseUrl":format!("http://{address}"),"kind":"openai-compatible"},"model":"test"},"wire":{"path":"/chat/completions","body":{"model":"test","messages":[],"stream":true}}}),
            &output,
            |provider| {
                Ok((
                    provider["baseUrl"].as_str().unwrap().into(),
                    "openai-compatible".into(),
                    "test-native-key".into(),
                ))
            },
        );
        execute(
            &json!({"kind":"release","gameId":game,"sessionId":"one","lease":id}),
            &channel(),
        )
        .unwrap();
        server.join().unwrap();
        result.unwrap();
        let output = messages.lock().unwrap();
        let text = format!("{output:?}");
        assert!(!text.contains("test-native-key"));
        assert!(text.contains("[redacted]"));
    }
    #[test]
    fn generation_ipc_rejects_forged_main_frame_tokens() {
        let access = StorageAccess::new().unwrap();
        let script = access.initialization_script();
        assert!(script.contains("__HELIA_AI__"));
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
            .invoke_handler(tauri::generate_handler![ai_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for (supplied, allowed) in [("forged".to_owned(), false), (token, true)] {
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "ai_request".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        json!({"token":supplied,"request":{"kind":"release","gameId":"ipc-test","sessionId":"one","lease":"missing"},"onChunk":"__CHANNEL__:0"}),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            );
            assert_eq!(response.is_ok(), allowed);
        }
    }
}

#[tauri::command]
pub async fn ai_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    request: Value,
    on_chunk: Channel<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !access.permits(&token) {
        return Err("허용하지 않는 AI 요청이에요.".into());
    }
    tauri::async_runtime::spawn_blocking(move || execute(&request, &on_chunk))
        .await
        .map_err(|_| ERROR.to_owned())?
}
