//! Game-only credentials. Provider credentials use a different OS service and cannot be addressed here.
use crate::{
    credential_store::{self, Entries},
    storage::StorageAccess,
};
use ring::{digest, hmac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub(crate) const ERROR: &str = "Game secret unavailable";
const MARKER: &str = "helia-secret:v1:";
struct GameStore;
impl GameStore {
    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new("com.helia.desktop.game-secrets", id).map_err(|_| ERROR.into())
    }
}
impl Entries for GameStore {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(id)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ERROR.into()),
        }
    }
    fn put(&self, id: &str, value: &[u8]) -> Result<(), String> {
        self.entry(id)?.set_secret(value).map_err(|_| ERROR.into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ERROR.into()),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secret {
    game_id: String,
    name: String,
    url: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Set {
        name: String,
        value: String,
        url: String,
    },
    Has {
        name: String,
    },
    Remove {
        name: String,
    },
    Ref {
        name: String,
    },
}
pub(crate) fn scope(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ERROR.into());
    }
    Ok(value)
}
fn name(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 64
        || !value.as_bytes()[0].is_ascii_alphabetic()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || ["constructor", "prototype"].contains(&value)
    {
        return Err(ERROR.into());
    }
    Ok(value)
}
fn destination(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| ERROR)?;
    if value.len() > 2048
        || value.chars().any(char::is_control)
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ERROR.into());
    }
    Ok(url.to_string())
}
fn address(game_id: &str, name: &str) -> String {
    digest::digest(
        &digest::SHA256,
        format!("game-secret\n{game_id}\n{name}").as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}
fn read(store: &impl Entries, game_id: &str, name: &str) -> Result<Option<Secret>, String> {
    let Some(bytes) = credential_store::read(store, &address(game_id, name))? else {
        return Ok(None);
    };
    let secret: Secret = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if secret.game_id != game_id
        || secret.name != name
        || destination(&secret.url)? != secret.url
        || secret.value.trim().is_empty()
        || secret.value.chars().count() > 8192
        || secret.value.chars().any(char::is_control)
    {
        return Err(ERROR.into());
    }
    Ok(Some(secret))
}
fn signature_input(game_id: &str, name: &str, url: &str) -> String {
    format!("{game_id}\n{name}\n{url}")
}
fn signature(secret: &Secret) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.value.as_bytes());
    hmac::sign(
        &key,
        signature_input(&secret.game_id, &secret.name, &secret.url).as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}
fn execute(store: &impl Entries, game_id: &str, input: Value) -> Result<Value, String> {
    scope(game_id)?;
    if input.to_string().len() > 64 * 1024 {
        return Err(ERROR.into());
    }
    let operation: Operation = serde_json::from_value(input).map_err(|_| ERROR)?;
    match operation {
        Operation::Set {
            name: key,
            value,
            url,
        } => {
            name(&key)?;
            if value.trim().is_empty()
                || value.chars().count() > 8192
                || value.chars().any(char::is_control)
            {
                return Err(ERROR.into());
            }
            let secret = Secret {
                game_id: game_id.into(),
                name: key.clone(),
                value,
                url: destination(&url)?,
            };
            credential_store::write(
                store,
                &address(game_id, &key),
                &serde_json::to_vec(&secret).map_err(|_| ERROR)?,
            )?;
            Ok(Value::Null)
        }
        Operation::Remove { name: key } => {
            name(&key)?;
            credential_store::delete(store, &address(game_id, &key))?;
            Ok(Value::Null)
        }
        Operation::Has { name: key } => {
            name(&key)?;
            Ok(json!(read(store, game_id, &key)?.is_some()))
        }
        Operation::Ref { name: key } => {
            name(&key)?;
            let secret = read(store, game_id, &key)?.ok_or(ERROR)?;
            Ok(json!(format!("{MARKER}{key}:{}", signature(&secret))))
        }
    }
}
fn resolve(
    store: &impl Entries,
    game_id: &str,
    url: &str,
    key: &str,
    signature: &str,
) -> Result<String, String> {
    scope(game_id)?;
    name(key)?;
    if signature.len() != 64 || !signature.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ERROR.into());
    }
    let secret = read(store, game_id, key)?
        .filter(|secret| secret.url == url)
        .ok_or(ERROR)?;
    let signature: Vec<u8> = (0..64)
        .step_by(2)
        .map(|offset| u8::from_str_radix(&signature[offset..offset + 2], 16).map_err(|_| ERROR))
        .collect::<Result<_, _>>()?;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.value.as_bytes());
    hmac::verify(
        &key,
        signature_input(&secret.game_id, &secret.name, &secret.url).as_bytes(),
        &signature,
    )
    .map_err(|_| ERROR)?;
    Ok(secret.value)
}
pub(crate) struct Authorization {
    pub headers: Vec<(String, String)>,
    pub values: Vec<String>,
}
fn expand(
    store: &impl Entries,
    game_id: Option<&str>,
    url: &str,
    value: &str,
    values: &mut Vec<String>,
) -> Result<String, String> {
    let mut rest = value;
    let mut output = String::new();
    while let Some(at) = rest.find(MARKER) {
        output.push_str(&rest[..at]);
        rest = &rest[at + MARKER.len()..];
        let (key, tail) = rest.split_once(':').ok_or(ERROR)?;
        if tail.len() < 64 || !tail.is_char_boundary(64) {
            return Err(ERROR.into());
        }
        if tail
            .as_bytes()
            .get(64)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(byte))
        {
            return Err(ERROR.into());
        }
        let secret = resolve(store, game_id.ok_or(ERROR)?, url, key, &tail[..64])?;
        if values.len() >= 16 {
            return Err(ERROR.into());
        }
        values.push(secret.clone());
        output.push_str(&secret);
        rest = &tail[64..];
    }
    output.push_str(rest);
    if output.contains(MARKER) {
        return Err(ERROR.into());
    }
    Ok(output)
}
fn authorize_with(
    store: &impl Entries,
    game_id: Option<&str>,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<Authorization, String> {
    let mut values = Vec::new();
    let mut expanded = Vec::new();
    for (name, value) in headers {
        expanded.push((name, expand(store, game_id, url, &value, &mut values)?));
    }
    if serde_json::to_vec(&expanded).map_err(|_| ERROR)?.len() > 16384 {
        return Err(ERROR.into());
    }
    Ok(Authorization {
        headers: expanded,
        values,
    })
}
pub(crate) fn authorize(
    game_id: Option<&str>,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<Authorization, String> {
    authorize_with(&GameStore, game_id, url, headers)
}
#[tauri::command]
pub async fn game_secrets_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    game_id: String,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" || !access.permits(&token) {
        return Err(ERROR.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        execute(&GameStore, &game_id, request).map_err(|_| ERROR.to_owned())
    })
    .await
    .map_err(|_| ERROR.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, Vec<u8>>>);
    impl Entries for Memory {
        fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.borrow().get(id).cloned())
        }
        fn put(&self, id: &str, value: &[u8]) -> Result<(), String> {
            self.0.borrow_mut().insert(id.into(), value.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }
    #[test]
    fn records_and_signed_references_cannot_cross_game_or_destination_scopes() {
        let store = Memory::default();
        let url = "https://image.example/generate";
        let set = json!({"kind":"set","name":"novelai","url":url,"value":"test-game-key"});
        execute(&store, "game-a", set.clone()).unwrap();
        execute(&store, "game-b", set.clone()).unwrap();
        let reference = execute(&store, "game-a", json!({"kind":"ref","name":"novelai"}))
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!reference.contains("test-game-key"));
        let headers = vec![("authorization".into(), format!("Bearer {reference}"))];
        assert_eq!(
            authorize_with(&store, Some("game-a"), url, headers.clone())
                .unwrap()
                .headers[0]
                .1,
            "Bearer test-game-key"
        );
        assert!(authorize_with(&store, Some("game-b"), url, headers.clone()).is_err());
        assert!(authorize_with(&store, None, url, headers.clone()).is_err());
        assert!(
            authorize_with(
                &store,
                Some("game-a"),
                "https://image.example/other",
                headers.clone()
            )
            .is_err()
        );
        execute(
            &store,
            "game-a",
            json!({"kind":"set","name":"novelai","url":url,"value":"new-test-key"}),
        )
        .unwrap();
        assert!(authorize_with(&store, Some("game-a"), url, headers).is_err());
        execute(&store, "game-a", json!({"kind":"remove","name":"novelai"})).unwrap();
        assert_eq!(
            execute(&store, "game-a", json!({"kind":"has","name":"novelai"})).unwrap(),
            false
        );
        assert_eq!(
            execute(&store, "game-b", json!({"kind":"has","name":"novelai"})).unwrap(),
            true
        );
    }
    #[test]
    fn cannot_address_provider_keys_service_accounts_or_storage_paths() {
        let game_store = Memory::default();
        let model_store = Memory::default();
        credential_store::write(&model_store, "same-name", b"private-provider-key").unwrap();
        for key in ["same-name", "service-account"] {
            assert_eq!(
                execute(&game_store, "game-a", json!({"kind":"has","name":key})).unwrap(),
                false
            );
            assert!(execute(&game_store, "game-a", json!({"kind":"ref","name":key})).is_err());
            execute(&game_store, "game-a", json!({"kind":"remove","name":key})).unwrap();
        }
        assert_eq!(
            credential_store::read(&model_store, "same-name")
                .unwrap()
                .unwrap(),
            b"private-provider-key"
        );
        for key in ["../credentials", "/master.key", "__proto__"] {
            assert!(execute(&game_store, "game-a", json!({"kind":"has","name":key})).is_err());
        }
        assert!(
            execute(
                &game_store,
                "game-a",
                json!({"kind":"has","name":"key","gameId":"game-b"})
            )
            .is_err()
        );
        assert!(
            execute(
                &game_store,
                "game-a",
                json!({"kind":"models","provider":{"id":"same-name"}})
            )
            .is_err()
        );
    }
    #[test]
    fn native_command_requires_the_private_main_window_token() {
        let access = StorageAccess::new().unwrap();
        assert!(
            access
                .initialization_script()
                .contains("__HELIA_GAME_SECRETS__")
        );
        let app = tauri::test::mock_builder()
            .manage(access)
            .invoke_handler(tauri::generate_handler![game_secrets_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let response = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: "game_secrets_request".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(
                    json!({"token":"forged","gameId":"game-a","request":{"kind":"has","name":"key"}}),
                ),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        assert!(response.is_err());
    }
}
