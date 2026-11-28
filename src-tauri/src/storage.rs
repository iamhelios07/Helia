use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const MIGRATION: &str = include_str!("../../src/lib/storage/migrations/0000_initial.sql");
const CONFLICT: &str = "STORAGE_CONFLICT";
const RESOURCE_LIST_BYTES: u64 = 16 * 1024 * 1024;
const DOCUMENT_DRAFT_SAVE_BYTES: u64 = 3 * 16 * 1024 * 1024 + 5 * RESOURCE_LIST_BYTES + 65536;
// At most R / 77 entries; 32 bytes each cover URI prefixes and base64 padding.
const INLINE_RESOURCE_ALLOWANCE: u64 =
    4 * (3u64 * 1024 * 1024).div_ceil(3) + 32 * (RESOURCE_LIST_BYTES / 77);
const DOCUMENT_COMMIT_BYTES: u64 =
    6 * 16 * 1024 * 1024 + RESOURCE_LIST_BYTES + INLINE_RESOURCE_ALLOWANCE + 32 * 100_000 + 65536;
const DOCUMENT_RELEASE_CREATE_BYTES: u64 = DOCUMENT_COMMIT_BYTES;

pub(crate) fn validate_document_operation_bytes(operation: &str, bytes: u64) -> Result<(), String> {
    let maximum = document_operation_limit(operation).ok_or("잘못된 문서 작업")?;
    if bytes > maximum {
        return Err("저장할 내용이 너무 커요".into());
    }
    Ok(())
}

pub(crate) fn document_operation_limit(operation: &str) -> Option<u64> {
    match operation {
        "draftSave" => Some(DOCUMENT_DRAFT_SAVE_BYTES),
        "commit" => Some(DOCUMENT_COMMIT_BYTES),
        "releaseCreate" => Some(DOCUMENT_RELEASE_CREATE_BYTES),
        _ => None,
    }
}

fn resource_list_error(count: usize, bytes: u64) -> String {
    let tenths = bytes.saturating_mul(10).div_ceil(1024 * 1024);
    format!(
        "리소스 목록이 너무 커요(항목 {count}개, 약 {}.{} MiB)",
        tenths / 10,
        tenths % 10
    )
}

fn resource_list_bytes(value: Option<&Value>) -> Result<u64, String> {
    let Some(value) = value else { return Ok(2) };
    let entries = value
        .as_object()
        .ok_or("리소스 목록의 형식을 확인해주세요.")?;
    let mut bytes = 2u64;
    for (index, (key, item)) in entries.iter().enumerate() {
        for size in [
            serde_json::to_vec(key)
                .map_err(|_| "잘못된 리소스 목록")?
                .len() as u64,
            serde_json::to_vec(&stored_resource_metadata(item))
                .map_err(|_| "잘못된 리소스 목록")?
                .len() as u64,
            1 + u64::from(index > 0),
        ] {
            bytes = bytes.checked_add(size).ok_or("리소스 목록 크기 초과")?;
        }
    }
    Ok(bytes)
}

fn stored_resource_metadata(value: &Value) -> std::borrow::Cow<'_, Value> {
    let Some(fields) = value.as_object() else {
        return std::borrow::Cow::Borrowed(value);
    };
    if !fields
        .get("data")
        .and_then(Value::as_str)
        .is_some_and(|data| data.starts_with("data:") || data.starts_with("helia-package:assets/"))
    {
        return std::borrow::Cow::Borrowed(value);
    }
    // Avoid cloning the inline bytes that are being excluded from the list budget.
    let stored = fields
        .iter()
        .map(|(key, item)| {
            let item = if key == "data" {
                json!(format!("helia-asset:{}", "0".repeat(64)))
            } else {
                item.clone()
            };
            (key.clone(), item)
        })
        .collect();
    std::borrow::Cow::Owned(Value::Object(stored))
}

fn validate_resource_list_budget(value: Option<&Value>) -> Result<(), String> {
    let bytes = resource_list_bytes(value)?;
    if bytes > RESOURCE_LIST_BYTES {
        return Err(resource_list_error(
            value.and_then(Value::as_object).map_or(0, Map::len),
            bytes,
        ));
    }
    Ok(())
}

fn validate_draft_budget(draft: &Value) -> Result<(), String> {
    validate_resource_list_budget(draft["baseContent"].get("resources"))?;
    if let Some(assets) = draft["documents"]["assets"].as_str() {
        let bytes = (serde_json::to_vec(assets)
            .map_err(|_| "잘못된 에셋 문서")?
            .len() as u64)
            .checked_sub(2)
            .ok_or("잘못된 에셋 문서")?;
        if bytes
            > RESOURCE_LIST_BYTES
                .checked_mul(2)
                .ok_or("리소스 목록 크기 초과")?
        {
            return Err(resource_list_error(
                draft["baseContent"]["resources"]
                    .as_object()
                    .map_or(0, Map::len),
                bytes,
            ));
        }
    }
    let mut remainder = draft.clone();
    if let Some(base) = remainder["baseContent"].as_object_mut() {
        base.remove("resources");
    }
    if let Some(documents) = remainder["documents"].as_object_mut() {
        documents.remove("assets");
    }
    let text = serde_json::to_string(&remainder).map_err(|_| "잘못된 편집 초안")?;
    if text.encode_utf16().count() as u64 > 16 * 1024 * 1024 {
        return Err("편집 초안이 너무 커요.".into());
    }
    Ok(())
}
pub(crate) const MEDIA_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "video/mp4",
    "video/webm",
];

#[path = "game_releases.rs"]
mod releases;

#[path = "game_edit_lock.rs"]
mod edit_lock;

#[path = "media_uploads.rs"]
pub(crate) mod media_uploads;

pub struct StoragePath(pub PathBuf);

/// A per-process credential injected into a main-frame-only JavaScript closure.
/// WebView iframe-origin reporting differs by platform, so origin ACLs alone are insufficient.
pub struct StorageAccess {
    token: String,
}
impl StorageAccess {
    pub fn permits(&self, token: &str) -> bool {
        self.token == token
    }
    pub fn new() -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| "Could not initialize storage access".to_owned())?;
        Ok(Self {
            token: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        })
    }
    pub fn initialization_script(&self) -> String {
        format!(
            r#";(() => {{
            if (window !== window.top) return;
            const token = "{}";
            const invoke = window.__TAURI_INTERNALS__.invoke;
            Object.defineProperty(window, '__HELIA_STORAGE__', {{
                value: request => invoke('storage_request', {{ request, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_AI_SETTINGS__', {{
                value: request => invoke('ai_settings_request', {{ request, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_CREDENTIALS__', {{
                value: request => invoke('credential_request', {{ request, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_GAME_SECRETS__', {{
                value: (gameId, request) => invoke('game_secrets_request', {{ gameId, request, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_AI__', {{
                value: (request, onChunk) => invoke('ai_request', {{ request, onChunk, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_NETWORK__', {{
                value: (request, onChunk) => invoke('network_request', {{ request, onChunk, token }}),
                writable: false, configurable: false
            }});
        }})();"#,
            self.token
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Table {
    Games,
    Sessions,
    Messages,
    Snapshots,
    Progress,
    Transactions,
    Memories,
    Blobs,
    #[serde(rename = "snapshot_resources")]
    SnapshotResources,
    Checkpoints,
}
impl Table {
    fn name(self) -> &'static str {
        match self {
            Self::Games => "games",
            Self::Sessions => "sessions",
            Self::Messages => "messages",
            Self::Snapshots => "snapshots",
            Self::Progress => "progress",
            Self::Transactions => "transactions",
            Self::Memories => "memories",
            Self::Blobs => "blobs",
            Self::SnapshotResources => "snapshot_resources",
            Self::Checkpoints => "checkpoints",
        }
    }
    fn order(self) -> u8 {
        match self {
            Self::Games => 0,
            Self::Sessions => 1,
            Self::Blobs => 2,
            Self::Snapshots => 3,
            Self::SnapshotResources => 4,
            Self::Messages => 5,
            Self::Progress => 6,
            Self::Transactions => 7,
            Self::Memories => 8,
            Self::Checkpoints => 9,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecord {
    table: Table,
    id: String,
    game_id: String,
    session_id: Option<String>,
    value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    UnlockGame {
        game_id: String,
    },
    List {
        #[serde(default)]
        include_trashed: bool,
    },
    ReadDraft {
        game_id: String,
    },
    WriteDraft {
        game_id: String,
        version: u64,
        draft: Value,
    },
    Read {
        game_id: String,
        session_id: Option<String>,
        #[serde(default)]
        include_history: bool,
        #[serde(default)]
        play: bool,
    },
    Create {
        game_id: String,
        records: Vec<StoredRecord>,
    },
    Commit {
        game_id: String,
        version: u64,
        records: Vec<StoredRecord>,
        delete_sessions: Vec<String>,
        game_patch: Option<Value>,
    },
    Prune {
        game_id: String,
        session_id: String,
        event_id: String,
        expected_revision: u64,
    },
    Trash {
        game_id: String,
    },
    Restore {
        game_id: String,
    },
    Purge {
        game_id: String,
    },
}

pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|_| "게임 저장소를 열 수 없어요.")?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(db_error)?;
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version == 0 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // Another connection may have initialized while this one waited for the write lock.
        let current: u32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if current == 0 {
            transaction.execute_batch(MIGRATION).map_err(db_error)?;
            transaction
                .pragma_update(None, "user_version", 1)
                .map_err(db_error)?;
        } else if current != 1 {
            return Err("지원하지 않는 DB 버전이에요.".into());
        }
        transaction.commit().map_err(db_error)?;
    } else if version != 1 {
        return Err("지원하지 않는 DB 버전이에요.".into());
    }
    connection.execute_batch("CREATE TABLE IF NOT EXISTS editor_drafts (game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, version INTEGER NOT NULL, value TEXT)").map_err(db_error)?;
    connection
        .execute_batch(crate::session_files::SCHEMA)
        .map_err(db_error)?;
    connection
        .execute_batch(crate::runtime_content::SCHEMA)
        .map_err(db_error)?;
    connection
        .execute_batch(crate::runtime_content::MEDIA_SCHEMA)
        .map_err(db_error)?;
    releases::initialize(&mut connection)?;
    Ok(connection)
}
fn read_draft(connection: &Connection, game_id: &str) -> Result<Value, String> {
    let exists: i64 = connection
        .query_row("SELECT count(*) FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    if exists != 1 {
        return Err("게임을 찾을 수 없어요.".into());
    }
    let saved: Option<(i64, Option<String>)> = connection
        .query_row(
            "SELECT version,value FROM editor_drafts WHERE game_id=?1",
            [game_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    match saved {
        None => Ok(json!({"version":0,"draft":null})),
        Some((version, text)) => Ok(
            json!({"version":version,"draft":match text {Some(text)=>serde_json::from_str::<Value>(&text).map_err(|_|"편집 초안을 읽을 수 없어요.")?,None=>Value::Null}}),
        ),
    }
}
fn validate_draft(game_id: &str, draft: &Value) -> Result<(), String> {
    if draft.is_null() {
        return Ok(());
    }
    validate_draft_budget(draft)?;
    if (draft["version"] != 1 && draft["version"] != 2 && draft["version"] != 3)
        || draft["gameId"].as_str() != Some(game_id)
        || !draft["documents"].is_object()
    {
        return Err("편집 초안의 형식이 올바르지 않아요.".into());
    }
    for name in ["info", "instructions", "state", "lorebook"] {
        if !draft["documents"][name].is_string() {
            return Err("편집 문서가 없어요.".into());
        }
    }
    for name in if draft["version"] == 3 {
        vec!["code"]
    } else {
        vec!["scripts", "ui"]
    } {
        if !draft["documents"][name].is_string() {
            return Err("편집 문서가 없어요.".into());
        }
    }
    if draft["version"] == 1 && !draft["documents"]["schema"].is_string() {
        return Err("편집 문서가 없어요.".into());
    }
    if draft["documents"]
        .get("assets")
        .is_some_and(|value| !value.is_string())
    {
        return Err("잘못된 에셋 문서예요.".into());
    }
    let mut base = draft["baseContent"].clone();
    if !base.is_object() {
        return Err("초안의 원본 콘텐츠가 없어요.".into());
    }
    base["schemaVersion"] = json!(2);
    base["id"] = json!(game_id);
    base["activeSessionId"] = json!("editor-base");
    base["createdAt"] = json!("2000-01-01T00:00:00.000Z");
    base["updatedAt"] = base["createdAt"].clone();
    crate::state_schema::validate_document(&base)?;
    if !valid_value(Table::Games, &base) {
        return Err("초안의 원본 콘텐츠가 올바르지 않아요.".into());
    }
    Ok(())
}
fn db_error(_: rusqlite::Error) -> String {
    "게임 데이터를 저장하거나 읽을 수 없어요.".into()
}

fn read_rows(
    connection: &Connection,
    table: Table,
    game_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<Vec<StoredRecord>, String> {
    // Game-scoped tables (shared snapshots, blobs, resource references) ignore session filters.
    let shared = matches!(
        table,
        Table::Snapshots | Table::Blobs | Table::SnapshotResources
    );
    let (query, parameters) = if let Some(game) = game_id {
        if table == Table::Games {
            (
                "SELECT id, value FROM games WHERE id=?1".to_owned(),
                vec![game],
            )
        } else if let Some(session) = session_id.filter(|_| table == Table::Snapshots) {
            ("SELECT * FROM snapshots WHERE game_id=?1 AND id IN (SELECT snapshot_id FROM progress WHERE game_id=?1 AND session_id=?2)".to_owned(), vec![game,session])
        } else if let Some(session) = session_id.filter(|_| table == Table::SnapshotResources) {
            ("SELECT * FROM snapshot_resources WHERE game_id=?1 AND snapshot_id IN (SELECT snapshot_id FROM progress WHERE game_id=?1 AND session_id=?2)".to_owned(), vec![game,session])
        } else if let Some(session) = session_id.filter(|_| table == Table::Blobs) {
            ("SELECT * FROM blobs WHERE game_id=?1 AND id IN (SELECT json_extract(value, '$.blobId') FROM snapshot_resources WHERE game_id=?1 AND snapshot_id IN (SELECT snapshot_id FROM progress WHERE game_id=?1 AND session_id=?2))".to_owned(), vec![game,session])
        } else if let Some(session) = session_id.filter(|_| table != Table::Sessions && !shared) {
            (
                format!(
                    "SELECT id, game_id, session_id, value FROM {} WHERE game_id=?1 AND session_id=?2",
                    table.name()
                ),
                vec![game, session],
            )
        } else {
            (
                format!("SELECT * FROM {} WHERE game_id=?1", table.name()),
                vec![game],
            )
        }
    } else {
        ("SELECT id, value FROM games".to_owned(), vec![])
    };
    let mut statement = connection.prepare(&query).map_err(db_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(parameters), |row| {
            let id: String = row.get("id")?;
            let game_id: String = if table == Table::Games {
                id.clone()
            } else {
                row.get("game_id")?
            };
            let session_id = if table == Table::Games {
                None
            } else if table == Table::Sessions {
                Some(id.clone())
            } else if shared {
                None
            } else {
                Some(row.get("session_id")?)
            };
            let value: String = row.get("value")?;
            Ok((id, game_id, session_id, value))
        })
        .map_err(db_error)?;
    rows.map(|row| {
        let (id, game_id, session_id, value) = row.map_err(db_error)?;
        let record = StoredRecord {
            table,
            id,
            game_id,
            session_id,
            value: serde_json::from_str(&value).map_err(|_| "저장된 데이터가 올바르지 않아요.")?,
        };
        validate(&record, &record.game_id)?;
        Ok(record)
    })
    .collect()
}

fn validate(row: &StoredRecord, game_id: &str) -> Result<(), String> {
    if matches!(row.table, Table::Games | Table::Snapshots) {
        crate::state_schema::validate_document(&row.value)?;
    }
    let expected = match row.table {
        Table::Games | Table::Progress | Table::Transactions => 2,
        Table::Blobs if row.value["schemaVersion"] == 2 => 2,
        _ => 1,
    };
    let id_key = if row.table == Table::Progress {
        "sessionId"
    } else {
        "id"
    };
    let game_scoped = matches!(
        row.table,
        Table::Snapshots | Table::Blobs | Table::SnapshotResources
    );
    let session_scoped = !game_scoped && row.table != Table::Games && row.table != Table::Sessions;
    if row.id.trim().is_empty()
        || row.game_id != game_id
        || row.value[id_key].as_str() != Some(row.id.as_str())
        || row.value["schemaVersion"].as_u64() != Some(expected)
        || (row.table == Table::Blobs
            && expected == 2
            && row.value["gameId"].as_str() != Some(game_id))
        || (session_scoped && row.value["gameId"].as_str() != Some(game_id))
    {
        return Err("저장 항목의 소유 정보나 형식이 올바르지 않아요.".into());
    }
    match row.table {
        Table::Games
            if row.id != game_id
                || row.session_id.is_some()
                || !row.value["activeSessionId"].is_string() =>
        {
            return Err("게임 정보가 올바르지 않아요.".into());
        }
        Table::Sessions if row.session_id.as_deref() != Some(row.id.as_str()) => {
            return Err("세션 정보가 올바르지 않아요.".into());
        }
        Table::Snapshots | Table::Blobs | Table::SnapshotResources if row.session_id.is_some() => {
            return Err("공유 저장 항목이 세션을 소유할 수 없어요.".into());
        }
        Table::Messages
        | Table::Progress
        | Table::Transactions
        | Table::Memories
        | Table::Checkpoints
            if row.session_id.as_deref() != row.value["sessionId"].as_str()
                || row.session_id.is_none() =>
        {
            return Err("세션 소유 정보가 올바르지 않아요.".into());
        }
        _ => {}
    }
    if !valid_value(row.table, &row.value) {
        return Err("저장 항목의 내용이 올바르지 않아요.".into());
    }
    Ok(())
}

fn text(value: &Value) -> bool {
    value.is_string()
}
fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|v| !v.trim().is_empty())
}
fn counter(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= 9_007_199_254_740_991)
}
fn timestamp(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339).is_ok()
    })
}
fn state(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().all(|(key, value)| {
            !["__proto__", "prototype", "constructor"].contains(&key.as_str()) && state(value)
        }),
        Value::Array(values) => values.iter().all(state),
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        _ => true,
    }
}
fn object_state(value: &Value) -> bool {
    value.is_object() && state(value)
}
fn settings(value: &Value) -> bool {
    ["description", "firstMessage", "authorNote"]
        .iter()
        .all(|key| text(&value[key]))
}
fn scripts(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.iter().all(|(key, value)| {
            !key.trim().is_empty()
                && !["__proto__", "prototype", "constructor"].contains(&key.as_str())
                && id(&value["language"])
                && text(&value["source"])
                && value.get("compiled").is_none_or(|source| {
                    source
                        .as_str()
                        .is_some_and(|source| source.len() <= 1024 * 1024)
                })
                && value.get("compiledFor").is_none_or(blob_id)
                && value.get("artifact").is_none_or(blob_id)
        })
    })
}
fn panel_layout(value: &Value, depth: usize, seen: &mut std::collections::HashSet<String>) -> bool {
    if depth > 8 {
        return false;
    }
    if value["kind"] == "panel" {
        return value["id"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                && seen.len() < 16
                && seen.insert(id.to_owned())
        });
    }
    value["kind"] == "split"
        && matches!(value["axis"].as_str(), Some("horizontal" | "vertical"))
        && value["ratio"]
            .as_f64()
            .is_some_and(|n| (0.1..=0.9).contains(&n))
        && panel_layout(&value["first"], depth + 1, seen)
        && panel_layout(&value["second"], depth + 1, seen)
}
fn game_ui(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    if !object_state(value) || value["version"] != 1 {
        return false;
    }
    let Some(modules) = value["modules"].as_object() else {
        return false;
    };
    let Some(entry) = value["entry"].as_str() else {
        return false;
    };
    let built = value.get("compiled").is_some_and(|built| {
        built["version"] == 1
            && built["factories"]
                .as_str()
                .is_some_and(|source| source.len() <= 2 * 1024 * 1024)
            && built["dependencies"].is_object()
            && blob_id(&built["sourceHash"])
    });
    let referenced = value.get("artifact").is_some_and(blob_id);
    if (!built && !referenced && (modules.is_empty() || !modules.contains_key(entry)))
        || modules.len() > 32
    {
        return false;
    }
    let mut bytes = 0;
    for (name, module) in modules {
        if name.is_empty()
            || name.len() > 128
            || matches!(name.as_str(), "preact" | "preact/hooks")
            || !name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
            || name.split('/').any(|part| matches!(part, "" | "." | ".."))
            || !matches!(
                module["language"].as_str(),
                Some("jsx" | "tsx" | "javascript" | "typescript")
            )
        {
            return false;
        }
        let Some(source) = module["source"].as_str() else {
            return false;
        };
        bytes += source.len();
        if bytes > 512 * 1024 {
            return false;
        }
    }
    if value
        .get("layout")
        .is_some_and(|layout| !panel_layout(layout, 0, &mut std::collections::HashSet::new()))
    {
        return false;
    }
    if value
        .get("chatDock")
        .is_some_and(|dock| !matches!(dock.as_str(), Some("left" | "right" | "top" | "bottom")))
        || value
            .get("chatRatio")
            .is_some_and(|ratio| !ratio.as_f64().is_some_and(|n| (0.2..=0.8).contains(&n)))
    {
        return false;
    }
    chat_style(value.get("chatStyle"))
}
fn chat_style(value: Option<&Value>) -> bool {
    if let Some(style) = value {
        let Some(style) = style.as_object() else {
            return false;
        };
        for (key, color) in style {
            let Some(color) = color.as_str() else {
                return false;
            };
            if color.encode_utf16().count() > 100 || color.is_empty() {
                return false;
            }
            if key == "fontFamily" {
                if !color.chars().all(|c| {
                    c.is_alphanumeric() || c.is_whitespace() || matches!(c, ',' | '"' | '\'' | '-')
                }) {
                    return false;
                }
            } else if !matches!(
                key.as_str(),
                "background" | "color" | "userBackground" | "assistantBackground"
            ) || !(color.chars().all(|c| c.is_ascii_alphabetic())
                || color.strip_prefix('#').is_some_and(|hex| {
                    (3..=8).contains(&hex.len()) && hex.chars().all(|c| c.is_ascii_hexdigit())
                }))
            {
                return false;
            }
        }
    }
    true
}
fn code_path(path: &str, folder: bool) -> bool {
    if path == "style.css" {
        return true;
    }
    !path.is_empty()
        && path.len() <= 128
        && path
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))
        && path.split('/').all(|part| {
            !part.is_empty()
                && ![".", "..", "__proto__", "constructor", "prototype"].contains(&part)
        })
        && (folder
            || [".js", ".ts", ".jsx", ".tsx"]
                .iter()
                .any(|ext| path.ends_with(ext)))
}
fn code_project(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    if !value.is_object() || value["version"] != 1 {
        return false;
    }
    // Validate the typed form TS `parseCodeProject` produces, so legacy `.js` files behind a
    // canonical `.ts` entry are judged the same way on both hosts.
    let Ok(normalized) = releases::normalize_code(value) else {
        return false;
    };
    let value = &normalized;
    let Some(files) = value["files"].as_object() else {
        return false;
    };
    let Some(entry) = value["entry"].as_str() else {
        return false;
    };
    if !code_path(entry, false)
        || entry == "style.css"
        || !files.contains_key(entry)
        || files.len() > 64
    {
        return false;
    }
    let mut bytes = 0;
    for (path, file) in files {
        if !code_path(path, false)
            || !matches!(
                file["language"].as_str(),
                Some("javascript" | "typescript" | "jsx" | "tsx" | "css")
            )
        {
            return false;
        }
        let Some(source) = file["source"].as_str() else {
            return false;
        };
        if (file["language"] == "css") != (path == "style.css")
            || (path == "style.css" && source.len() > 64 * 1024)
        {
            return false;
        }
        bytes += source.len();
        if bytes > 512 * 1024
            || files
                .keys()
                .any(|other| other.starts_with(&format!("{path}/")))
        {
            return false;
        }
    }
    if let Some(folders) = value.get("folders") {
        let Some(folders) = folders.as_array() else {
            return false;
        };
        if folders.len() > 128
            || folders.iter().any(|folder| {
                folder.as_str().is_none_or(|folder| {
                    !code_path(folder, true)
                        || files.contains_key(folder)
                        || files
                            .keys()
                            .any(|path| folder.starts_with(&format!("{path}/")))
                })
            })
        {
            return false;
        }
    }
    if let Some(presentation) = value.get("presentation") {
        let Some(presentation) = presentation.as_object() else {
            return false;
        };
        if presentation
            .keys()
            .any(|key| !["layout", "chatDock", "chatRatio", "chatStyle"].contains(&key.as_str()))
        {
            return false;
        }
        let mut ui = json!({"version":1,"entry":"main.tsx","modules":{"main.tsx":{"language":"tsx","source":""}}});
        for (key, value) in presentation {
            ui[key] = value.clone();
        }
        if !game_ui(Some(&ui)) {
            return false;
        }
    }
    true
}
fn resources(value: Option<&Value>) -> bool {
    use base64::Engine;
    let Some(value) = value else {
        return true;
    };
    let Some(entries) = value.as_object() else {
        return false;
    };
    let mut total = 0u64;
    let mut paths = std::collections::HashSet::new();
    for (id, row) in entries {
        if id.is_empty()
            || id.len() > 100
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
            || ["__proto__", "constructor", "prototype"].contains(&id.as_str())
        {
            return false;
        }
        let Some(name) = row["name"].as_str() else {
            return false;
        };
        let Some(mime) = row["mime"].as_str() else {
            return false;
        };
        let Some(data) = row["data"].as_str() else {
            return false;
        };
        if name.trim().is_empty()
            || name.encode_utf16().count() > 200
            || name
                .chars()
                .any(|c| c == '\\' || c == ':' || (c as u32) < 32 || c == '\u{007f}')
            || name
                .split('/')
                .any(|part| part.trim().is_empty() || [".", ".."].contains(&part))
            || !paths.insert(name.to_owned())
            || entries.contains_key(name) && name != id
            || !MEDIA_MIMES.contains(&mime)
        {
            return false;
        }
        if data.strip_prefix("helia-asset:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            continue;
        }
        let prefix = format!("data:{mime};base64,");
        let Some(encoded) = data.strip_prefix(&prefix) else {
            return false;
        };
        if encoded.len() > 1_398_104 || encoded.is_empty() {
            return false;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return false;
        };
        let Some(sum) = total.checked_add(bytes.len() as u64) else {
            return false;
        };
        total = sum;
        if bytes.len() > 1_048_576 || total > 3_145_728 {
            return false;
        }
    }
    for path in &paths {
        let parts: Vec<_> = path.split('/').collect();
        for i in 1..parts.len() {
            if paths.contains(&parts[..i].join("/")) {
                return false;
            }
        }
    }
    true
}
fn valid_snapshot(value: &Value) -> bool {
    timestamp(&value["createdAt"])
        && settings(&value["settings"])
        && object_state(&value["initialState"])
        && scripts(&value["scripts"])
        && game_ui(value.get("ui"))
        && code_project(value.get("code"))
}
pub(crate) fn valid_blob(value: &Value) -> bool {
    if value["schemaVersion"] == 2 {
        return value["id"]
            .as_str()
            .is_some_and(crate::runtime_content::valid_hash)
            && id(&value["gameId"])
            && value["object"]
                .as_str()
                .is_some_and(crate::runtime_content::valid_hash)
            && counter(&value["size"])
            && value["size"].as_u64().is_some_and(|size| size > 0)
            && value["mime"]
                .as_str()
                .is_some_and(|mime| MEDIA_MIMES.contains(&mime));
    }
    blob_id(&value["id"]) && id(&value["mime"]) && !value["data"].as_str().unwrap_or("").is_empty()
}
fn blob_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()))
}
fn valid_snapshot_resource(value: &Value) -> bool {
    blob_id(&value["blobId"]) && id(&value["assetId"]) && id(&value["name"])
}
fn valid_checkpoint(value: &Value) -> bool {
    id(&value["transactionId"])
        && id(&value["snapshotId"])
        && id(&value["sessionId"])
        && object_state(&value["state"])
}
fn valid_transaction(value: &Value) -> bool {
    timestamp(&value["createdAt"])
        && counter(&value["createdRevision"])
        && value.get("parentId").is_some()
        && (value["parentId"].is_null() || id(&value["parentId"]))
        && id(&value["action"]["name"])
        && object_state(&value["action"]["args"])
        && (value.get("messageId").is_none() || id(&value["messageId"]))
        && valid_transaction_messages(value)
        && (value.get("description").is_none() || id(&value["description"]))
        && value["changes"].as_array().is_some_and(|changes| {
            changes.iter().all(|change| {
                change["path"].as_array().is_some_and(|path| {
                    !path.is_empty()
                        && path.iter().all(|key| {
                            key.as_str().is_some_and(|key| {
                                !["__proto__", "prototype", "constructor"].contains(&key)
                            })
                        })
                }) && ["before", "after"]
                    .iter()
                    .all(|key| match change[key]["exists"].as_bool() {
                        Some(false) => true,
                        Some(true) => change[key].get("value").is_some_and(state),
                        None => false,
                    })
            })
        })
}

fn valid_transaction_messages(value: &Value) -> bool {
    let Some(ids) = value.get("messageIds") else {
        return true;
    };
    ids.as_array().is_some_and(|ids| {
        (2..=256).contains(&ids.len())
            && ids.first() == value.get("messageId")
            && ids.iter().all(id)
            && ids
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == ids.len()
    })
}

fn transaction_message_ids(value: &Value) -> Vec<&str> {
    match value["messageIds"].as_array() {
        Some(ids) => ids.iter().filter_map(Value::as_str).collect(),
        None => value["messageId"].as_str().into_iter().collect(),
    }
}
fn valid_value(table: Table, value: &Value) -> bool {
    match table {
        Table::Games => {
            // TS validateGameMetadata: limits apply after `String.prototype.trim`.
            value["title"]
                .as_str()
                .map(releases::js_trim)
                .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 120)
                && value["genre"]
                    .as_str()
                    .is_some_and(|v| releases::js_trim(v).encode_utf16().count() <= 80)
                && value["description"]
                    .as_str()
                    .is_some_and(|v| releases::js_trim(v).encode_utf16().count() <= 2000)
                && timestamp(&value["createdAt"])
                && timestamp(&value["updatedAt"])
                && value
                    .get("installedFrom")
                    .is_none_or(releases::packages::valid_installed_from)
                && value.get("editLock").is_none_or(edit_lock::valid)
                && settings(&value["settings"])
                && object_state(&value["initialState"])
                && scripts(&value["scripts"])
                && game_ui(value.get("ui"))
                && resources(value.get("resources"))
                && code_project(value.get("code"))
        }
        Table::Sessions => {
            id(&value["title"])
                && value["title"]
                    .as_str()
                    .is_some_and(|v| v.encode_utf16().count() <= 120)
                && timestamp(&value["createdAt"])
                && timestamp(&value["updatedAt"])
                && (value.get("messageCount").is_none() || counter(&value["messageCount"]))
        }
        Table::Messages => {
            id(&value["content"])
                && counter(&value["sequence"])
                && value["sequence"].as_u64().is_some_and(|v| v > 0)
                && matches!(value["role"].as_str(), Some("user" | "assistant"))
                && timestamp(&value["createdAt"])
                && (value.get("kind").is_none()
                    || matches!(value["kind"].as_str(), Some("opening" | "dialogue")))
                && (value["kind"] != "opening" || value["role"] == "assistant")
        }
        Table::Snapshots => valid_snapshot(value),
        Table::Blobs => valid_blob(value),
        Table::SnapshotResources => valid_snapshot_resource(value),
        Table::Checkpoints => valid_checkpoint(value),
        Table::Progress => {
            id(&value["snapshotId"])
                && (value["headId"].is_null() || id(&value["headId"]))
                && value.get("headId").is_some()
                && counter(&value["revision"])
                && object_state(&value["state"])
        }
        Table::Transactions => valid_transaction(value),
        Table::Memories => {
            id(&value["content"])
                && timestamp(&value["createdAt"])
                && value["sourceTransactionIds"]
                    .as_array()
                    .is_some_and(|sources| !sources.is_empty() && sources.iter().all(id))
        }
    }
}

fn write_row(connection: &Connection, row: &StoredRecord, create: bool) -> Result<(), String> {
    // External game rows pass through write's identity preservation before
    // validation. Pruning only supplies game rows read from this transaction.
    let shared = matches!(
        row.table,
        Table::Snapshots | Table::Blobs | Table::SnapshotResources
    );
    let value = row.value.to_string();
    let count = if row.table == Table::Games {
        if create {
            connection.execute(
                "INSERT INTO games(id,value) VALUES (?1,?2)",
                params![row.id, value],
            )
        } else {
            connection.execute(
                "UPDATE games SET value=?2 WHERE id=?1",
                params![row.id, value],
            )
        }
    } else {
        let table = row.table.name();
        let mut fields = vec!["id", "game_id"];
        let mut values = vec![
            Value::String(row.id.clone()),
            Value::String(row.game_id.clone()),
        ];
        if row.table != Table::Sessions && !shared {
            fields.push("session_id");
            values.push(json!(row.session_id));
        }
        fields.push("value");
        values.push(json!(value));
        if row.table == Table::Messages {
            fields.push("sequence");
            values.push(row.value["sequence"].clone());
        }
        if matches!(
            row.table,
            Table::Progress | Table::Checkpoints | Table::SnapshotResources
        ) {
            fields.push("snapshot_id");
            values.push(row.value["snapshotId"].clone());
        }
        let immutable = matches!(row.table, Table::Transactions | Table::Memories);
        // Content-addressed shared rows are keyed by their own hash: identical bytes re-inserting is a no-op.
        let conflict = if create || immutable || shared {
            if shared {
                let target = if row.table == Table::Snapshots {
                    "id, game_id"
                } else {
                    "id"
                };
                format!(" ON CONFLICT({target}) DO NOTHING")
            } else {
                String::new()
            }
        } else {
            let updates: Vec<_> = fields
                .iter()
                .filter(|key| !["id", "game_id", "session_id"].contains(key))
                .map(|key| format!("{key}=excluded.{key}"))
                .collect();
            let session_guard = if row.table == Table::Sessions {
                ""
            } else {
                " AND session_id=excluded.session_id"
            };
            format!(
                " ON CONFLICT(id) DO UPDATE SET {} WHERE game_id=excluded.game_id{session_guard}",
                updates.join(",")
            )
        };
        let parameters: Result<Vec<rusqlite::types::Value>, String> = values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(rusqlite::types::Value::Text(value.clone())),
                Value::Number(value) => value
                    .as_i64()
                    .map(rusqlite::types::Value::Integer)
                    .ok_or("저장 숫자가 올바르지 않아요.".into()),
                _ => Err("저장 값이 올바르지 않아요.".into()),
            })
            .collect();
        let query = format!(
            "INSERT INTO {table}({}) VALUES ({}){conflict}",
            fields.join(","),
            vec!["?"; fields.len()].join(",")
        );
        connection.execute(&query, rusqlite::params_from_iter(parameters?))
    }
    .map_err(db_error)?;
    if count != 1 && !shared {
        return Err("다른 세션의 저장 항목이에요.".into());
    }
    Ok(())
}

fn write_draft(
    connection: &Connection,
    game_id: &str,
    version: u64,
    draft: &Value,
) -> Result<Value, String> {
    edit_lock::guard(connection, game_id, "draft")?;
    let previous = read_draft(connection, game_id)?;
    if version >= 9_007_199_254_740_991 || previous["version"].as_u64() != Some(version) {
        return Err("다른 편집기에서 초안이 변경되었어요.".into());
    }
    validate_draft(game_id, draft)?;
    let text = if draft.is_null() {
        None
    } else {
        Some(serde_json::to_string(draft).map_err(|_| "잘못된 편집 초안")?)
    };
    connection.execute("INSERT INTO editor_drafts (game_id,version,value) VALUES (?1,?2,?3) ON CONFLICT(game_id) DO UPDATE SET version=excluded.version,value=excluded.value",params![game_id,(version+1) as i64,text]).map_err(db_error)?;
    Ok(json!({"version":version+1,"draft":draft}))
}
fn read_game(
    connection: &Connection,
    game_id: &str,
    session_id: Option<&str>,
    include_history: bool,
) -> Result<Value, String> {
    let version: Option<i64> = connection
        .query_row("SELECT version FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(db_error)?;
    Ok(if let Some(version) = version {
        let mut records = read_rows(connection, Table::Games, Some(game_id), None)?;
        records.extend(read_rows(connection, Table::Sessions, Some(game_id), None)?);
        if session_id.is_some() || include_history {
            if let Some(session) = session_id {
                validate_history(connection, game_id, session)?;
            } else {
                for row in records.iter().filter(|row| row.table == Table::Sessions) {
                    validate_history(connection, game_id, &row.id)?;
                }
            }
            for table in [
                Table::Messages,
                Table::Snapshots,
                Table::Progress,
                Table::Transactions,
                Table::Memories,
                Table::Checkpoints,
            ] {
                records.extend(read_rows(connection, table, Some(game_id), session_id)?);
            }
            for table in [Table::Blobs, Table::SnapshotResources] {
                records.extend(read_rows(connection, table, Some(game_id), session_id)?);
            }
        }
        json!({ "version": version, "records": records })
    } else {
        json!({ "version": 0, "records": [] })
    })
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MediaRequest {
    MediaUploadBegin(Value),
    MediaUploadChunk(Value),
    MediaUploadStatus(Value),
    MediaUploadFinish(Value),
    MediaUploadCancel(Value),
}

pub(crate) fn execute_request(path: &Path, input: Value) -> Result<Value, String> {
    if input["kind"]
        .as_str()
        .is_some_and(|k| k.starts_with("mediaUpload"))
    {
        let command =
            serde_json::from_value(input).map_err(|_| releases::packages::error("format"))?;
        return media_uploads::request(path, command);
    }
    if input["kind"] == "installJson" {
        let request = releases::packages::parse_install_json(&input)?;
        return releases::packages::request(&mut open(path)?, request);
    }
    if matches!(input["kind"].as_str(), Some("install" | "installPreview")) {
        if input["kind"] == "install" {
            releases::packages::check_request_size(&input)?;
        }
        return releases::packages::request(&mut open(path)?, input);
    }
    if input["kind"] == "versioning" {
        return releases::request(&mut open(path)?, input);
    }
    if input["kind"] == "artifact" {
        return crate::runtime_content::read_artifact(path, &input);
    }
    if matches!(input["kind"].as_str(), Some("sync" | "asset")) {
        return crate::storage_sync::execute(path, input);
    }
    if input["kind"] == "files" {
        return crate::session_files::request(&mut open(path)?, &input);
    }
    let (input, claim) = take_body_ref(path, input)?;
    execute_stored(path, input, claim)
}
/// Resolves a split request body (§3.9) before the stored command is parsed.
pub(crate) fn take_body_ref(
    path: &Path,
    input: Value,
) -> Result<(Value, Option<media_uploads::DocumentClaim>), String> {
    if let Some((resolved, claim)) = media_uploads::resolve_body_ref(path, &input)? {
        return Ok((resolved, Some(claim)));
    }
    Ok((input, None))
}
pub(crate) fn execute_stored(
    path: &Path,
    input: Value,
    claim: Option<media_uploads::DocumentClaim>,
) -> Result<Value, String> {
    let _lease_guard = crate::generation::guard_storage(&input)?;
    let mut input = input;
    if let Some(object) = input.as_object_mut() {
        object.remove("aiLease");
    }
    let request: Request =
        serde_json::from_value(input).map_err(|_| "저장 요청의 형식이 올바르지 않아요.")?;
    let mut connection = open(path)?;
    let read = matches!(
        request,
        Request::Read { .. } | Request::ReadDraft { .. } | Request::List { .. }
    );
    let transaction = connection
        .transaction_with_behavior(if read {
            TransactionBehavior::Deferred
        } else {
            TransactionBehavior::Immediate
        })
        .map_err(db_error)?;
    let purging = matches!(request, Request::Purge { .. });
    let result = match request {
        Request::UnlockGame { game_id } => edit_lock::unlock(&transaction, &game_id)?,
        Request::ReadDraft { game_id } => read_draft(&transaction, &game_id)?,
        Request::WriteDraft {
            game_id,
            version,
            draft,
        } => write_draft(&transaction, &game_id, version, &draft)?,
        Request::List { include_trashed } => {
            let mut records = read_rows(&transaction, Table::Games, None, None)?;
            if !include_trashed {
                records.retain(|row| {
                    row.value
                        .get("trashedAt")
                        .map(Value::is_null)
                        .unwrap_or(true)
                });
            }
            let games: Vec<Value> = records
                .iter()
                .map(|row| {
                    let fields: Map<String, Value> = [
                        "schemaVersion",
                        "id",
                        "title",
                        "genre",
                        "description",
                        "activeSessionId",
                        "createdAt",
                        "updatedAt",
                        "trashedAt",
                        "editLock",
                    ]
                    .iter()
                    .filter_map(|key| {
                        row.value
                            .get(*key)
                            .map(|value| ((*key).to_owned(), value.clone()))
                    })
                    .collect();
                    json!(fields)
                })
                .collect();
            json!({ "version": 0, "records": [], "games":games })
        }
        Request::Read {
            game_id,
            session_id,
            include_history,
            play,
        } => {
            let selected = if play && session_id.is_none() {
                transaction
                    .query_row(
                        "SELECT json_extract(value,'$.activeSessionId') FROM games WHERE id=?1",
                        [&game_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(db_error)?
            } else {
                session_id
            };
            read_game(&transaction, &game_id, selected.as_deref(), include_history)?
        }
        Request::Create { game_id, records } => write(&transaction, &game_id, records, None, &[])?,
        Request::Prune {
            game_id,
            session_id,
            event_id,
            expected_revision,
        } => prune(
            &transaction,
            &game_id,
            &session_id,
            &event_id,
            expected_revision,
        )?,
        Request::Trash { game_id } => trash(&transaction, &game_id)?,
        Request::Restore { game_id } => restore(&transaction, &game_id)?,
        Request::Purge { game_id } => purge(&transaction, &game_id)?,
        Request::Commit {
            game_id,
            version,
            mut records,
            delete_sessions,
            game_patch,
        } => {
            if let Some(patch) = game_patch {
                if records.iter().any(|row| row.table == Table::Games) {
                    return Err("Invalid game patch".into());
                }
                let raw: String = transaction
                    .query_row("SELECT value FROM games WHERE id=?1", [&game_id], |row| {
                        row.get(0)
                    })
                    .map_err(db_error)?;
                let mut value: Value =
                    serde_json::from_str(&raw).map_err(|_| "Invalid game patch")?;
                for (key, item) in patch["set"].as_object().ok_or("Invalid game patch")? {
                    value[key] = item.clone();
                }
                for key in patch["remove"].as_array().ok_or("Invalid game patch")? {
                    value
                        .as_object_mut()
                        .ok_or("Invalid game patch")?
                        .remove(key.as_str().ok_or("Invalid game patch")?);
                }
                records.push(StoredRecord {
                    table: Table::Games,
                    id: game_id.clone(),
                    game_id: game_id.clone(),
                    session_id: None,
                    value,
                });
            }
            write(
                &transaction,
                &game_id,
                records,
                Some(version),
                &delete_sessions,
            )?
        }
    };
    if let Some(claim) = &claim {
        media_uploads::consume_document(&transaction, claim)?;
    }
    transaction.commit().map_err(db_error)?;
    if purging || claim.is_some() {
        media_uploads::wake();
    }
    Ok(result)
}

use rusqlite::OptionalExtension;

fn apply_recorded_change(state: &mut Value, change: &Value) -> Result<(), String> {
    let invalid = || "저장된 상태 변경을 복원할 수 없어요.".to_string();
    let path = change["path"].as_array().ok_or_else(invalid)?;
    let mut parent = state;
    for key in &path[..path.len() - 1] {
        parent = parent
            .as_object_mut()
            .and_then(|object| object.get_mut(key.as_str()?))
            .ok_or_else(invalid)?;
    }
    let object = parent.as_object_mut().ok_or_else(invalid)?;
    let key = path.last().and_then(Value::as_str).ok_or_else(invalid)?;
    let previous = object.get(key);
    if previous.is_some() != (change["before"]["exists"] == true)
        || previous.is_some_and(|old| !crate::state_schema::equal(old, &change["before"]["value"]))
    {
        return Err(invalid());
    }
    if change["after"]["exists"] == true {
        object.insert(key.into(), change["after"]["value"].clone());
    } else {
        object.remove(key);
    }
    Ok(())
}
fn restored_state<'a>(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    snapshot: &Value,
    nodes: &'a std::collections::HashMap<String, Value>,
    mut head: Option<&'a str>,
) -> Result<Value, String> {
    let checkpoints = read_rows(
        connection,
        Table::Checkpoints,
        Some(game_id),
        Some(session_id),
    )?;
    let mut visited = std::collections::HashSet::new();
    let mut path = vec![];
    while let Some(id) = head {
        if !visited.insert(id) {
            return Err("진행 기록이 순환하고 있어요.".into());
        }
        let node = nodes.get(id).ok_or("진행 기록을 찾을 수 없어요.")?;
        path.push(node);
        head = node["parentId"].as_str();
    }
    let mut state = snapshot["initialState"].clone();
    let mut revision = 0;
    for node in path.into_iter().rev() {
        let next = node["createdRevision"].as_u64().unwrap();
        if next <= revision {
            return Err("게임 진행 리비전이 올바르지 않아요.".into());
        }
        revision = next;
        let node_id = node["id"].as_str().unwrap_or("");
        let checkpoint = checkpoints.iter().find(|row| {
            row.value["snapshotId"].as_str() == snapshot["id"].as_str()
                && row.value["transactionId"].as_str() == Some(node_id)
        });
        if let Some(mapped) = checkpoint {
            state = mapped.value["state"].clone();
        } else {
            for change in node["changes"].as_array().unwrap() {
                apply_recorded_change(&mut state, change)?;
            }
        }
        crate::state_schema::validate_value(&snapshot["schema"], &state, "load")?;
    }
    Ok(state)
}
fn validate_restored(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    snapshot: &Value,
    transactions: &[StoredRecord],
) -> Result<(), String> {
    let checkpoints = read_rows(
        connection,
        Table::Checkpoints,
        Some(game_id),
        Some(session_id),
    )?;
    for checkpoint in &checkpoints {
        if checkpoint.value["snapshotId"].as_str() != snapshot["id"].as_str() {
            continue;
        }
        let transaction_id = checkpoint.value["transactionId"].as_str().unwrap_or("");
        if !transactions.iter().any(|row| row.id == transaction_id) {
            return Err("상태 변환의 기록을 찾을 수 없어요.".into());
        }
        crate::state_schema::validate_value(
            &snapshot["schema"],
            &checkpoint.value["state"],
            "load",
        )?;
    }
    Ok(())
}
fn validate_message_links(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    nodes: &std::collections::HashMap<String, Value>,
) -> Result<(), String> {
    let sessions = read_rows(connection, Table::Sessions, Some(game_id), None)?;
    let session = sessions
        .iter()
        .find(|row| row.id == session_id)
        .ok_or("Session not found")?;
    let mut messages = read_rows(connection, Table::Messages, Some(game_id), Some(session_id))?;
    messages.sort_by_key(|row| row.value["sequence"].as_u64().unwrap());
    if session.value["messageCount"].as_u64().unwrap_or(0) != messages.len() as u64
        || messages
            .iter()
            .enumerate()
            .any(|(index, row)| row.value["sequence"].as_u64() != Some(index as u64 + 1))
    {
        return Err("Invalid stored message sequence".into());
    }
    let message_ids: std::collections::HashSet<_> =
        messages.iter().map(|row| row.id.as_str()).collect();
    let mut linked = std::collections::HashSet::new();
    for node in nodes.values() {
        for id in transaction_message_ids(node) {
            if !message_ids.contains(id) || !linked.insert(id) {
                return Err("Invalid event message link".into());
            }
        }
    }
    if messages
        .iter()
        .any(|row| row.value["kind"] != "opening" && !linked.contains(row.id.as_str()))
    {
        return Err("Message has no event".into());
    }

    Ok(())
}
fn validate_history(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let snapshots = read_rows(
        connection,
        Table::Snapshots,
        Some(game_id),
        Some(session_id),
    )?;
    let progress = read_rows(connection, Table::Progress, Some(game_id), Some(session_id))?;
    let transactions = read_rows(
        connection,
        Table::Transactions,
        Some(game_id),
        Some(session_id),
    )?;
    let Some(progress) = progress.first() else {
        return if snapshots.is_empty() && transactions.is_empty() {
            Ok(())
        } else {
            Err("세션의 진행 기록이 없어요.".into())
        };
    };
    let snapshot = &snapshots
        .iter()
        .find(|row| Some(row.id.as_str()) == progress.value["snapshotId"].as_str())
        .ok_or("세션의 게임 정의가 일치하지 않아요.")?
        .value;
    validate_restored(connection, game_id, session_id, snapshot, &transactions)?;
    crate::state_schema::validate_value(&snapshot["schema"], &progress.value["state"], "load")?;
    let mut nodes = std::collections::HashMap::new();
    let mut revisions = std::collections::HashSet::new();
    for row in &transactions {
        let revision = row.value["createdRevision"].as_u64().unwrap();
        if revision == 0
            || revision > progress.value["revision"].as_u64().unwrap()
            || !revisions.insert(revision)
        {
            return Err("게임 진행 리비전이 올바르지 않아요.".into());
        }
        nodes.insert(row.id.clone(), row.value.clone());
    }
    validate_message_links(connection, game_id, session_id, &nodes)?;
    for memory in read_rows(connection, Table::Memories, Some(game_id), Some(session_id))? {
        if memory.value["sourceTransactionIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| !nodes.contains_key(id.as_str().unwrap()))
        {
            return Err("Memory source event not found".into());
        }
    }
    for id in nodes.keys() {
        restored_state(connection, game_id, session_id, snapshot, &nodes, Some(id))?;
    }
    let state = restored_state(
        connection,
        game_id,
        session_id,
        snapshot,
        &nodes,
        progress.value["headId"].as_str(),
    )?;
    if !crate::state_schema::equal(&state, &progress.value["state"]) {
        return Err("저장된 상태가 진행 기록과 일치하지 않아요.".into());
    }
    Ok(())
}

fn descendant_events(
    transactions: &[StoredRecord],
    event_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut removed = std::collections::HashSet::new();
    let mut stack = vec![event_id.to_string()];
    while let Some(id) = stack.pop() {
        if !removed.insert(id.clone()) {
            return Err("진행 기록이 순환하고 있어요.".into());
        }
        stack.extend(
            transactions
                .iter()
                .filter(|row| row.value["parentId"].as_str() == Some(id.as_str()))
                .map(|row| row.id.clone()),
        );
    }

    Ok(removed)
}
fn delete_pruned_records(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    removed: &std::collections::HashSet<String>,
    transactions: &[StoredRecord],
) -> Result<Vec<StoredRecord>, String> {
    let removed_messages: std::collections::HashSet<_> = transactions
        .iter()
        .filter(|row| removed.contains(&row.id))
        .flat_map(|row| transaction_message_ids(&row.value))
        .map(str::to_string)
        .collect();
    let messages = read_rows(connection, Table::Messages, Some(game_id), Some(session_id))?;
    let memories = read_rows(connection, Table::Memories, Some(game_id), Some(session_id))?;
    let mut deleted = vec![];
    deleted.extend(transactions.iter().filter(|row| removed.contains(&row.id)));
    deleted.extend(
        messages
            .iter()
            .filter(|row| removed_messages.contains(&row.id)),
    );
    deleted.extend(memories.iter().filter(|row| {
        row.value["sourceTransactionIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id.as_str().is_some_and(|id| removed.contains(id)))
    }));
    for row in deleted {
        let count = connection
            .execute(
                &format!(
                    "DELETE FROM {} WHERE id=?1 AND game_id=?2 AND session_id=?3",
                    row.table.name()
                ),
                params![row.id, game_id, session_id],
            )
            .map_err(db_error)?;
        if count != 1 {
            return Err("삭제할 기록을 찾을 수 없어요.".into());
        }
    }
    let surviving: Vec<_> = messages
        .into_iter()
        .filter(|row| !removed_messages.contains(&row.id))
        .collect();
    Ok(surviving)
}
/// Removed events drop their migration checkpoints as plain rows.
fn delete_pruned_checkpoints(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    removed: &std::collections::HashSet<String>,
) -> Result<(), String> {
    for id in removed {
        connection
            .execute(
                "DELETE FROM checkpoints WHERE id=?1 AND game_id=?2 AND session_id=?3",
                params![id, game_id, session_id],
            )
            .map_err(db_error)?;
    }

    Ok(())
}
fn publish_prune(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    records: [StoredRecord; 3],
) -> Result<Value, String> {
    let [mut game, mut session, progress] = records;
    let now: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    game.value["updatedAt"] = json!(now);
    session.value["updatedAt"] = json!(now);
    for row in [game, session, progress] {
        write_row(connection, &row, false)?;
    }
    if connection
        .execute(
            "UPDATE games SET version=version+1 WHERE id=?1 AND version<9007199254740991",
            [game_id],
        )
        .map_err(db_error)?
        != 1
    {
        return Err(CONFLICT.into());
    }
    validate_history(connection, game_id, session_id)?;
    let version: i64 = connection
        .query_row("SELECT version FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    let mut records = read_rows(connection, Table::Games, Some(game_id), None)?;
    records.extend(read_rows(connection, Table::Sessions, Some(game_id), None)?);
    for table in [
        Table::Messages,
        Table::Snapshots,
        Table::Progress,
        Table::Transactions,
        Table::Memories,
        Table::Checkpoints,
    ] {
        records.extend(read_rows(
            connection,
            table,
            Some(game_id),
            Some(session_id),
        )?);
    }
    for table in [Table::Blobs, Table::SnapshotResources] {
        records.extend(read_rows(connection, table, Some(game_id), None)?);
    }
    Ok(json!({"version":version,"records":records}))
}
fn prune(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    event_id: &str,
    expected: u64,
) -> Result<Value, String> {
    assert_not_trashed(connection, game_id)?;
    validate_history(connection, game_id, session_id)?;
    let game = read_rows(connection, Table::Games, Some(game_id), None)?
        .into_iter()
        .next()
        .ok_or("게임을 찾을 수 없어요.")?;
    let mut session = read_rows(connection, Table::Sessions, Some(game_id), None)?
        .into_iter()
        .find(|row| row.id == session_id)
        .ok_or("세션을 찾을 수 없어요.")?;
    let mut progress = read_rows(connection, Table::Progress, Some(game_id), Some(session_id))?
        .into_iter()
        .next()
        .ok_or("세션의 진행 기록이 없어요.")?;
    if expected >= 9_007_199_254_740_991 || progress.value["revision"].as_u64() != Some(expected) {
        return Err("게임 상태가 변경되었어요. 최신 상태에서 다시 시도해주세요.".into());
    }
    let snapshots = read_rows(
        connection,
        Table::Snapshots,
        Some(game_id),
        Some(session_id),
    )?;
    let snapshot = &snapshots
        .iter()
        .find(|row| Some(row.id.as_str()) == progress.value["snapshotId"].as_str())
        .ok_or("스냅샷을 찾을 수 없어요.")?
        .value;
    let transactions = read_rows(
        connection,
        Table::Transactions,
        Some(game_id),
        Some(session_id),
    )?;
    let target = transactions
        .iter()
        .find(|row| row.id == event_id)
        .ok_or("삭제할 이벤트를 찾을 수 없어요.")?;
    let removed = descendant_events(&transactions, event_id)?;
    let head = progress.value["headId"].clone();
    let selected = head.as_str().is_some_and(|id| removed.contains(id));
    let next_head = if selected {
        target.value["parentId"].clone()
    } else {
        head
    };
    let nodes = transactions
        .iter()
        .map(|row| (row.id.clone(), row.value.clone()))
        .collect();
    let state = restored_state(
        connection,
        game_id,
        session_id,
        snapshot,
        &nodes,
        next_head.as_str(),
    )?;
    let mut surviving =
        delete_pruned_records(connection, game_id, session_id, &removed, &transactions)?;
    delete_pruned_checkpoints(connection, game_id, session_id, &removed)?;
    surviving.sort_by_key(|row| row.value["sequence"].as_u64().unwrap());
    session.value["messageCount"] = json!(surviving.len());
    for (index, row) in surviving.iter_mut().enumerate() {
        row.value["sequence"] = json!(index + 1);
        write_row(connection, row, false)?;
    }
    progress.value["headId"] = next_head;
    progress.value["state"] = state;
    progress.value["revision"] = json!(expected + 1);
    publish_prune(connection, game_id, session_id, [game, session, progress])
}

/// Moving to Trash or restoring only flips the timestamp; every owned row stays untouched.
fn set_trashed(connection: &Connection, game_id: &str, kind: &str) -> Result<Value, String> {
    let existing: Option<(i64, String)> = connection
        .query_row(
            "SELECT version,value FROM games WHERE id=?1",
            [game_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((version, value)) = existing else {
        return Err("게임을 찾을 수 없어요.".into());
    };
    let mut parsed: Value =
        serde_json::from_str(&value).map_err(|_| "저장된 게임 정보가 올바르지 않아요.")?;
    parsed["trashedAt"] = if kind == "trash" {
        json!(
            connection
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| row
                    .get::<_, String>(0))
                .map_err(db_error)?
        )
    } else {
        Value::Null
    };
    connection
        .execute(
            "UPDATE games SET value=?1 WHERE id=?2",
            params![
                serde_json::to_string(&parsed).map_err(|_| "잘못된 게임 정보")?,
                game_id
            ],
        )
        .map_err(db_error)?;
    let records = read_rows(connection, Table::Games, Some(game_id), None)?;
    Ok(json!({ "version": version, "records": records }))
}
fn trash(connection: &Connection, game_id: &str) -> Result<Value, String> {
    set_trashed(connection, game_id, "trash")
}
fn restore(connection: &Connection, game_id: &str) -> Result<Value, String> {
    set_trashed(connection, game_id, "restore")
}
/// Permanent removal from the Trash: the game row goes and foreign keys cascade the rest.
fn purge(connection: &Connection, game_id: &str) -> Result<Value, String> {
    let value: Option<String> = connection
        .query_row("SELECT value FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(db_error)?;
    let Some(value) = value else {
        return Err("게임을 찾을 수 없어요.".into());
    };
    let parsed: Value =
        serde_json::from_str(&value).map_err(|_| "저장된 게임 정보가 올바르지 않아요.")?;
    if parsed.get("trashedAt").map(Value::is_null).unwrap_or(true) {
        return Err("휴지통에 있는 게임만 삭제할 수 있어요.".into());
    }
    media_uploads::purge(connection, game_id).map_err(db_error)?;
    connection
        .execute("DELETE FROM games WHERE id=?1", [game_id])
        .map_err(db_error)?;
    Ok(json!({ "version": 0, "records": [] }))
}
fn assert_not_trashed(connection: &Connection, game_id: &str) -> Result<(), String> {
    let value: String = connection
        .query_row("SELECT value FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(db_error)?
        .ok_or("게임을 찾을 수 없어요.")?;
    let parsed: Value =
        serde_json::from_str(&value).map_err(|_| "저장된 게임 정보가 올바르지 않아요.")?;
    if parsed
        .get("trashedAt")
        .map(|v| !v.is_null())
        .unwrap_or(false)
    {
        return Err("휴지통에 있는 게임은 변경할 수 없어요.".into());
    }
    Ok(())
}
// Match TS parseResources: validate the raw rows, then retain only stored fields
// before measuring R. Untrusted extra fields must not change the write budget.
fn normalize_write_resources(game: &mut Value) -> Result<(), String> {
    if !resources(game.get("resources")) {
        return Err("리소스 목록의 형식을 확인해주세요.".into());
    }
    if let Some(entries) = game.get_mut("resources").and_then(Value::as_object_mut) {
        for resource in entries.values_mut() {
            if let Some(fields) = resource.as_object_mut() {
                fields.retain(|key, _| matches!(key.as_str(), "name" | "mime" | "data"));
            }
        }
    }
    Ok(())
}

fn write(
    connection: &Connection,
    game_id: &str,
    mut records: Vec<StoredRecord>,
    version: Option<u64>,
    delete_sessions: &[String],
) -> Result<Value, String> {
    if let Some(version) = version {
        assert_not_trashed(connection, game_id)?;
        if version >= 9_007_199_254_740_991
            || connection
                .execute(
                    "UPDATE games SET version=version+1 WHERE id=?1 AND version=?2",
                    params![game_id, version as i64],
                )
                .map_err(db_error)?
                != 1
        {
            return Err(CONFLICT.into());
        }
        for session in delete_sessions {
            if connection
                .execute(
                    "DELETE FROM sessions WHERE id=?1 AND game_id=?2",
                    params![session, game_id],
                )
                .map_err(db_error)?
                != 1
            {
                return Err("세션을 찾을 수 없어요.".into());
            }
        }
    } else if records.len() != 2
        || records
            .iter()
            .filter(|row| row.table == Table::Games)
            .count()
            != 1
        || records
            .iter()
            .filter(|row| row.table == Table::Sessions)
            .count()
            != 1
    {
        return Err("새 게임의 구성이 올바르지 않아요.".into());
    }
    for row in &mut records {
        if row.table == Table::Games {
            normalize_write_resources(&mut row.value)?;
            validate_resource_list_budget(row.value.get("resources"))?;
            if row.value["resources"].as_object().is_some_and(|entries| {
                entries.values().any(|asset| {
                    asset["data"]
                        .as_str()
                        .is_some_and(|data| data.starts_with("helia-asset:"))
                })
            }) {
                return Err("Stored resources must contain portable media".into());
            }
            row.value = releases::preserve_identity(connection, &row.id, &row.value)?;
        }
        validate(row, game_id)?;
    }
    records.sort_by(|a, b| {
        a.table.order().cmp(&b.table.order()).then_with(|| {
            if a.table == Table::Messages {
                b.value["sequence"]
                    .as_i64()
                    .cmp(&a.value["sequence"].as_i64())
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
    let affected_sessions: std::collections::HashSet<_> = records
        .iter()
        .filter(|row| !matches!(row.table, Table::Games | Table::Sessions))
        .filter_map(|row| row.session_id.clone())
        .collect();
    for row in records {
        write_row(connection, &row, version.is_none())?;
    }
    for session_id in affected_sessions {
        validate_history(connection, game_id, &session_id)?;
    }
    let valid: u32 = connection.query_row("SELECT count(*) FROM games g JOIN sessions s ON s.id=json_extract(g.value,'$.activeSessionId') AND s.game_id=g.id WHERE g.id=?1", [game_id], |row| row.get(0)).map_err(db_error)?;
    if valid != 1 {
        return Err("선택된 세션을 찾을 수 없어요.".into());
    }
    Ok(json!({ "version": version.map_or(0, |value| value+1), "records": [] }))
}

#[tauri::command]
pub async fn storage_request<R: tauri::Runtime>(
    window: tauri::Window<R>,
    state: tauri::State<'_, StoragePath>,
    access: tauri::State<'_, StorageAccess>,
    token: String,
    request: Value,
) -> Result<Value, Value> {
    if window.label() != "main" || token != access.token {
        return Err(json!("허용하지 않는 저장 요청이에요."));
    }
    let path = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || execute_request(&path, request))
        .await
        .map_err(|_| json!("게임 저장소 작업이 중단되었어요."))?
        .map_err(releases::packages::bridge_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_wire_names_match_typescript_protocol() {
        for table in [
            Table::Games,
            Table::Sessions,
            Table::Messages,
            Table::Snapshots,
            Table::Progress,
            Table::Transactions,
            Table::Memories,
            Table::Blobs,
            Table::SnapshotResources,
            Table::Checkpoints,
        ] {
            let wire = json!(table.name());
            assert_eq!(serde_json::to_value(table).unwrap(), wire);
            assert_eq!(serde_json::from_value::<Table>(wire).unwrap(), table);
        }
        assert_eq!(
            serde_json::to_value(Table::SnapshotResources).unwrap(),
            "snapshot_resources"
        );
        assert_eq!(
            serde_json::from_str::<Table>("\"snapshot_resources\"").unwrap(),
            Table::SnapshotResources
        );
    }

    #[test]
    fn content_fingerprints_match_shared_utf8_sha256_vectors() {
        use ring::digest::{SHA256, digest};
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../src/lib/games/state/fixtures/content-hash.json"
        ))
        .unwrap();
        for vector in vectors {
            // Do not serialize `json`: TS canonical ordering/number formatting is authoritative.
            let bytes = vector["canonicalText"].as_str().unwrap().as_bytes();
            let encoded: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(encoded, vector["utf8Hex"], "{}", vector["name"]);
            let hash: String = digest(&SHA256, bytes)
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(hash, vector["sha256"], "{}", vector["name"]);
            assert_ne!(hash, vector["legacyHash"]);
        }
    }

    #[test]
    fn legacy_fnv_references_replay_and_coexist_with_sha256_rows() {
        let fixture = Fixture::new();
        let legacy: Value = serde_json::from_str(include_str!(
            "../../src/lib/games/state/fixtures/legacy-content.json"
        ))
        .unwrap();
        let mut initial = create();
        initial["records"][0]["value"]["resources"] = legacy["resources"].clone();
        fixture.request(initial).unwrap();
        let old_id = legacy["snapshot"]["id"].as_str().unwrap();
        let blob_id = legacy["blob"]["id"].as_str().unwrap();
        let reference_id = legacy["reference"]["id"].as_str().unwrap();
        let mut progress = json!({"schemaVersion":2,"sessionId":"session","gameId":"game","snapshotId":old_id,"headId":"event","revision":1,"state":{}});
        let mut checkpoint = json!({"schemaVersion":1,"id":"event","transactionId":"event","snapshotId":old_id,"gameId":"game","sessionId":"session","state":{}});
        let event = json!({"schemaVersion":2,"id":"event","gameId":"game","sessionId":"session","parentId":null,"createdAt":legacy["snapshot"]["createdAt"],"createdRevision":1,"action":{"name":"continue","args":{}},"changes":[]});
        fixture
            .request(json!({"kind":"sync", "known":[], "request":commit(
                0,
                &[
                    row("snapshots", old_id, None, &legacy["snapshot"]),
                    row("blobs", blob_id, None, &legacy["blob"]),
                    row(
                        "snapshot_resources",
                        reference_id,
                        None,
                        &legacy["reference"],
                    ),
                    row("progress", "session", Some("session"), &progress),
                    row("transactions", "event", Some("session"), &event),
                    row("checkpoints", "event", Some("session"), &checkpoint),
                ],
            )}))
            .unwrap();
        let before = fixture.read();
        let rows = before["records"].as_array().unwrap();
        assert!(rows.iter().any(|r| r["table"] == "snapshot_resources"));
        assert_eq!(
            rows.iter().find(|r| r["table"] == "snapshots").unwrap()["id"],
            old_id
        );
        let db = open(&fixture.0).unwrap();
        assert_eq!(
            crate::runtime_content::asset(
                &db,
                "game",
                "image/png",
                legacy["blob"]["data"].as_str().unwrap()
            )
            .unwrap(),
            blob_id
        );
        assert_eq!(
            crate::runtime_content::read_asset(&db, "game", blob_id)
                .unwrap()
                .unwrap()["data"],
            legacy["blob"]["data"]
        );
        drop(db);

        let new_id = legacy["sha256Ids"]["snapshot"].as_str().unwrap();
        let new_blob_id = legacy["sha256Ids"]["blob"].as_str().unwrap();
        let new_reference_id = legacy["sha256Ids"]["reference"].as_str().unwrap();
        let mut snapshot = legacy["snapshot"].clone();
        snapshot["id"] = json!(new_id);
        let mut blob = legacy["blob"].clone();
        blob["id"] = json!(new_blob_id);
        let mut reference = legacy["reference"].clone();
        reference["id"] = json!(new_reference_id);
        reference["snapshotId"] = json!(new_id);
        reference["blobId"] = json!(new_blob_id);
        progress["snapshotId"] = json!(new_id);
        progress["revision"] = json!(2);
        checkpoint["snapshotId"] = json!(new_id);
        fixture
            .request(commit(
                1,
                &[
                    row("snapshots", new_id, None, &snapshot),
                    row("blobs", new_blob_id, None, &blob),
                    row("snapshot_resources", new_reference_id, None, &reference),
                    row("progress", "session", Some("session"), &progress),
                    row("checkpoints", "event", Some("session"), &checkpoint),
                ],
            ))
            .unwrap();
        let after = fixture.read();
        let rows = after["records"].as_array().unwrap();
        assert_eq!(
            rows.iter().find(|r| r["table"] == "progress").unwrap()["value"],
            progress
        );
        assert_eq!(
            rows.iter().find(|r| r["table"] == "transactions").unwrap()["value"],
            event
        );
        // Reinserting shared content must reuse the correct per-table key.
        fixture
            .request(commit(
                2,
                &[
                    row("snapshots", new_id, None, &snapshot),
                    row("blobs", new_blob_id, None, &blob),
                    row("snapshot_resources", new_reference_id, None, &reference),
                ],
            ))
            .unwrap();
        let db = open(&fixture.0).unwrap();
        for table in ["snapshots", "blobs", "snapshot_resources"] {
            let count: i64 = db
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 2, "{table}");
        }
    }

    #[test]
    fn creates_distinct_main_frame_storage_credentials() {
        let first = StorageAccess::new().unwrap();
        let second = StorageAccess::new().unwrap();
        assert_eq!(first.token.len(), 64);
        assert_ne!(first.token, second.token);
        let initialization = first.initialization_script();
        assert!(initialization.contains("if (window !== window.top) return"));
        assert!(initialization.contains("__HELIA_STORAGE__"));
    }

    #[test]
    fn validates_packaged_game_ui_and_creator_layouts() {
        let ui = json!({"version":1,"entry":"main.tsx","modules":{"main.tsx":{"language":"tsx","source":"export default function(){}"}},"layout":{"kind":"panel","id":"main"},"chatStyle":{"background":"#123456","fontFamily":"serif"}});
        assert!(game_ui(Some(&ui)));
        assert!(game_ui(None));
        let mut invalid = ui.clone();
        invalid["entry"] = json!("missing.tsx");
        assert!(!game_ui(Some(&invalid)));
        invalid = ui.clone();
        invalid["chatStyle"]["background"] = json!("url(https://example.com)");
        assert!(!game_ui(Some(&invalid)));
        invalid = ui;
        invalid["layout"] = json!({"kind":"split","axis":"horizontal","ratio":0.5,"first":{"kind":"panel","id":"same"},"second":{"kind":"panel","id":"same"}});
        assert!(!game_ui(Some(&invalid)));
    }
    #[test]
    fn validates_portable_media_resources() {
        let valid = json!({"portrait":{"name":"Portrait","mime":"image/png","data":"data:image/png;base64,aGVsbG8="}});
        assert!(resources(Some(&valid)));
        assert!(!resources(Some(
            &json!({"portrait":{"name":"Unsafe","mime":"image/svg+xml","data":"data:image/svg+xml;base64,aGVsbG8="}})
        )));
        assert!(!resources(Some(
            &json!({"portrait":{"name":"Remote","mime":"image/png","data":"https://example.com/image.png"}})
        )));
        assert!(!resources(Some(
            &json!({"constructor":{"name":"Portrait","mime":"image/png","data":"data:image/png;base64,aGVsbG8="}})
        )));
        for path in [
            "../bad.png",
            "/root.png",
            "a\\b.png",
            "a:b.png",
            "a//b.png",
            "a/./b.png",
        ] {
            let mut invalid = valid.clone();
            invalid["portrait"]["name"] = json!(path);
            assert!(!resources(Some(&invalid)));
        }
        let mut duplicate = valid;
        duplicate["other"] = duplicate["portrait"].clone();
        assert!(!resources(Some(&duplicate)));
        duplicate["other"]["name"] = json!("Portrait/child.png");
        assert!(!resources(Some(&duplicate)));
        duplicate["other"]["name"] = json!("portrait");
        assert!(!resources(Some(&duplicate)));
    }
    fn many_resources(count: usize) -> Value {
        Value::Object(
            (0..count)
                .map(|index| {
                    (
                        format!("asset-{index}"),
                        json!({
                            "name": format!("images/asset-{index}.png"),
                            "mime": "image/png",
                            "data": "data:image/png;base64,AA=="
                        }),
                    )
                })
                .collect(),
        )
    }
    #[test]
    fn accepts_hundreds_of_small_resources() {
        for count in [129usize, 257] {
            assert!(resources(Some(&many_resources(count))), "{count}");
        }
    }

    pub(super) fn resource_budget_map() -> Value {
        let resource = json!({"name":format!("{}000000", "p".repeat(80)),"mime":"image/png","data":"data:image/png;base64,AA=="});
        let entry_bytes = resource_list_bytes(Some(&json!({"r000000":resource}))).unwrap() - 1;
        let count = (RESOURCE_LIST_BYTES - 1) / entry_bytes;
        let mut entries = Map::new();
        for index in 0..count {
            let mut item = resource.clone();
            item["name"] = json!(format!("{}{index:06}", "p".repeat(80)));
            entries.insert(format!("r{index:06}"), item);
        }
        let mut remaining = RESOURCE_LIST_BYTES - (1 + count * entry_bytes);
        for index in (count - 2)..count {
            let key = format!("r{index:06}");
            let name = entries[&key]["name"].as_str().unwrap();
            let added = remaining.min(200 - name.len() as u64);
            let name = format!("{name}{}", "x".repeat(added as usize));
            entries.get_mut(&key).unwrap()["name"] = json!(name);
            remaining -= added;
        }
        assert_eq!(remaining, 0);
        Value::Object(entries)
    }

    #[test]
    fn resource_budget_write_boundaries_preserve_saved_content_and_allow_reads() {
        let fixture = Fixture::new();
        fixture.create();
        let mut game = game("Budget");
        game["resources"] = resource_budget_map();
        assert_eq!(
            resource_list_bytes(game.get("resources")).unwrap(),
            RESOURCE_LIST_BYTES
        );
        let commit_game =
            |version, game: &Value| commit(version, &[row("games", "game", None, game)]);
        fixture.request(commit_game(0, &game)).unwrap();
        let mut draft = json!({"version":3,"gameId":"game","baseContent":game,"documents":{"info":"{}","instructions":"{}","state":"{unfinished","code":"{}","lorebook":"{}","assets":"{unfinished"}});
        fixture
            .request(json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}))
            .unwrap();
        fixture.request(json!({"kind":"versioning","gameId":"game","action":"release","contentVersion":"1.0.0"})).unwrap();
        let key = game["resources"]
            .as_object()
            .unwrap()
            .keys()
            .next_back()
            .unwrap()
            .clone();
        let name = game["resources"][&key]["name"].as_str().unwrap().to_owned() + "x";
        game["resources"][&key]["name"] = json!(name);
        assert_eq!(
            resource_list_bytes(game.get("resources")).unwrap(),
            RESOURCE_LIST_BYTES + 1
        );
        assert!(
            fixture
                .request(commit_game(1, &game))
                .unwrap_err()
                .starts_with("리소스 목록이 너무 커요")
        );
        let previous = fixture
            .request(json!({"kind":"read","gameId":"game"}))
            .unwrap();
        assert_eq!(previous["version"], 1);
        assert_eq!(
            resource_list_bytes(previous["records"][0]["value"].get("resources")).unwrap(),
            RESOURCE_LIST_BYTES
        );
        draft["baseContent"] = game.clone();
        assert!(
            fixture
                .request(json!({"kind":"writeDraft","gameId":"game","version":1,"draft":draft}))
                .unwrap_err()
                .starts_with("리소스 목록이 너무 커요")
        );
        assert_eq!(
            fixture
                .request(json!({"kind":"readDraft","gameId":"game"}))
                .unwrap()["version"],
            1
        );
        let db = open(&fixture.0).unwrap();
        db.execute(
            "UPDATE games SET value=?1 WHERE id='game'",
            [game.to_string()],
        )
        .unwrap();
        assert!(
            fixture
                .request(json!({"kind":"read","gameId":"game"}))
                .is_ok()
        );
        assert!(fixture.request(json!({"kind":"versioning","gameId":"game","action":"release","contentVersion":"2.0.0"})).unwrap_err().starts_with("리소스 목록이 너무 커요"));
    }

    #[test]
    fn resource_budget_unfinished_assets_and_document_operation_caps() {
        let mut draft = json!({"version":3,"gameId":"game","baseContent":game("Draft"),"documents":{"info":"{}","instructions":"{}","state":"{unfinished","code":"{}","lorebook":"{}","assets":""}});
        let bytes = RESOURCE_LIST_BYTES.checked_mul(2).unwrap();
        draft["documents"]["assets"] = json!("x".repeat(bytes as usize));
        assert!(validate_draft("game", &draft).is_ok());
        draft["documents"]["assets"] = json!("x".repeat(bytes as usize + 1));
        assert!(
            validate_draft("game", &draft)
                .unwrap_err()
                .starts_with("리소스 목록이 너무 커요")
        );
        let control = "\0".repeat((bytes / 6) as usize) + &"x".repeat((bytes % 6) as usize);
        draft["documents"]["assets"] = json!(control);
        assert!(validate_draft("game", &draft).is_ok());
        assert!(serde_json::to_vec(&draft).unwrap().len() as u64 <= DOCUMENT_DRAFT_SAVE_BYTES);
        draft["documents"]["assets"] = json!(control + "x");
        assert!(validate_draft("game", &draft).is_err());
        assert_eq!(DOCUMENT_DRAFT_SAVE_BYTES, 134_283_264);
        assert_eq!(DOCUMENT_COMMIT_BYTES, 131_872_672);
        assert_eq!(DOCUMENT_RELEASE_CREATE_BYTES, DOCUMENT_COMMIT_BYTES);
        for (operation, maximum) in [
            ("draftSave", DOCUMENT_DRAFT_SAVE_BYTES),
            ("commit", DOCUMENT_COMMIT_BYTES),
            ("releaseCreate", DOCUMENT_RELEASE_CREATE_BYTES),
        ] {
            assert!(validate_document_operation_bytes(operation, maximum).is_ok());
            assert!(
                validate_document_operation_bytes(operation, maximum.checked_add(1).unwrap())
                    .is_err()
            );
        }
    }

    #[test]
    fn resource_budget_matches_inline_package_and_stored_references() {
        let mut resource = json!({"image":{"name":"images/한🌌.png","mime":"image/png","data":format!("helia-asset:{}", "a".repeat(64))}});
        let expected = resource_list_bytes(Some(&resource)).unwrap();
        for data in [
            "data:image/png;base64,AA==".to_owned(),
            format!("helia-package:assets/{}", "a".repeat(64)),
        ] {
            resource["image"]["data"] = json!(data);
            assert_eq!(resource_list_bytes(Some(&resource)).unwrap(), expected);
            assert_eq!(resource["image"]["data"], data);
        }
    }

    #[test]
    fn resource_budget_shared_r_fixtures() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/lib/testing/fixtures/resource-list-r.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                resource_list_bytes(case.get("resources")).unwrap(),
                case["expectedR"].as_u64().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn resource_budget_write_normalizes_extra_fields_before_measuring() {
        let fixture = Fixture::new();
        fixture.create();
        let mut game = game("Normalized");
        game["resources"] = json!({"image":{"name":"image.png","mime":"image/png","data":"data:image/png;base64,AA==","extra":"x".repeat(RESOURCE_LIST_BYTES as usize),"number":1e21}});
        assert!(validate_resource_list_budget(game.get("resources")).is_err());
        fixture
            .request(commit(0, &[row("games", "game", None, &game)]))
            .unwrap();
        let saved = fixture.read()["records"][0]["value"].clone();
        assert_eq!(saved["resources"]["image"].as_object().unwrap().len(), 3);
        assert_eq!(resource_list_bytes(saved.get("resources")).unwrap(), 135);
    }

    #[test]
    fn resource_budget_operation_caps_cover_control_r_and_inline_together() {
        use base64::Engine;
        let mut resources = resource_budget_map();
        let data = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; 64 * 1024])
        );
        for (index, item) in resources.as_object_mut().unwrap().values_mut().enumerate() {
            item["data"] = if index < 48 {
                json!(data)
            } else {
                json!(format!("helia-asset:{}", "a".repeat(64)))
            };
        }
        assert!(super::resources(Some(&resources)));
        assert_eq!(
            resource_list_bytes(Some(&resources)).unwrap(),
            RESOURCE_LIST_BYTES
        );
        let content = json!({"resources":resources,"x":"\0".repeat(16 * 1024 * 1024 - 10)});
        let bytes = serde_json::to_vec(&content).unwrap().len() as u64;
        assert!(bytes > 120_706_048);
        for operation in ["commit", "releaseCreate"] {
            assert!(validate_document_operation_bytes(operation, bytes).is_ok());
        }
    }
    fn doc_sha256(data: &[u8]) -> String {
        ring::digest::digest(&ring::digest::SHA256, data)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    fn count(db: &Connection, table: &str) -> i64 {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    /// Uploads a serialized request body as a `document` session through the real IPC dispatch.
    fn upload_document(fixture: &Fixture, operation: &str, text: &str) -> (String, Value) {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let bytes = text.as_bytes();
        let begun = fixture
            .request(json!({"kind":"mediaUploadBegin","gameId":"game","purpose":"document","operation":operation,"mime":"application/json","size":bytes.len()}))
            .unwrap();
        let upload_id = begun["uploadId"].as_str().unwrap().to_owned();
        for (index, part) in bytes.chunks(1048576).enumerate() {
            fixture
                .request(json!({"kind":"mediaUploadChunk","gameId":"game","uploadId":upload_id,"index":index,"sha256":doc_sha256(part),"data":STANDARD.encode(part)}))
                .unwrap();
        }
        let result = fixture
            .request(json!({"kind":"mediaUploadFinish","gameId":"game","uploadId":upload_id}))
            .unwrap();
        (format!("helia-upload:{upload_id}"), result)
    }
    fn document_session(fixture: &Fixture, reference: &str) -> (String, Option<String>) {
        let id = reference.strip_prefix("helia-upload:").unwrap();
        let db = open(&fixture.0).unwrap();
        let row: (String, Option<String>) = db
            .query_row(
                "SELECT state,object_id FROM media_uploads WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        row
    }
    #[test]
    fn document_upload_bounds_and_verification() {
        let fixture = Fixture::new();
        fixture.create();
        for operation in ["draftSave", "commit", "releaseCreate"] {
            let limit = document_operation_limit(operation).unwrap();
            for (size, ok) in [(limit, true), (limit + 1, false)] {
                let result = fixture.request(json!({"kind":"mediaUploadBegin","gameId":"game","purpose":"document","operation":operation,"mime":"application/json","size":size}));
                assert_eq!(result.is_ok(), ok, "{operation} {size}");
                if !ok {
                    assert!(result.unwrap_err().contains("mediaSize"));
                }
            }
        }
        assert!(fixture
            .request(json!({"kind":"mediaUploadBegin","gameId":"game","purpose":"document","operation":"draftSave","mime":"image/png","size":1}))
            .unwrap_err()
            .contains("mediaType"));
        assert!(fixture
            .request(json!({"kind":"mediaUploadBegin","gameId":"game","purpose":"document","mime":"application/json","size":1}))
            .unwrap_err()
            .contains("scopeMismatch"));
        let text = json!({"kind":"writeDraft","gameId":"game","version":0,"draft":Value::Null})
            .to_string();
        let (reference, result) = upload_document(&fixture, "draftSave", &text);
        assert_eq!(result["kind"], "upload");
        assert_eq!(result["ref"], reference);
        assert_eq!(result["mime"], "application/json");
        assert_eq!(result["size"], text.len());
        assert_eq!(result["sha256"], doc_sha256(text.as_bytes()));
        assert!(result.get("blobId").is_none());
        assert!(result["crc32"].is_u64());
        let db = open(&fixture.0).unwrap();
        assert_eq!(count(&db, "blobs"), 0);
        let (state, object) = document_session(&fixture, &reference);
        assert_eq!(state, "verified");
        assert!(object.is_some());
        let id = reference.strip_prefix("helia-upload:").unwrap();
        let again = fixture
            .request(json!({"kind":"mediaUploadFinish","gameId":"game","uploadId":id}))
            .unwrap();
        assert_eq!(again, result);
    }
    #[test]
    fn document_draft_save_consumes_and_preserves_unfinished() {
        let fixture = Fixture::new();
        fixture.create();
        let draft = json!({"version":3,"gameId":"game","baseContent":game("Draft"),"documents":{"info":"{}","instructions":"{}","state":"{unfinished","code":"{}","lorebook":"{}","regex":"[]","assets":"{unfinished"}});
        let body =
            json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}).to_string();
        let (reference, _) = upload_document(&fixture, "draftSave", &body);
        let saved = fixture
            .request(json!({"kind":"writeDraft","gameId":"game","bodyRef":reference}))
            .unwrap();
        assert_eq!(saved["version"], 1);
        let read = fixture
            .request(json!({"kind":"readDraft","gameId":"game"}))
            .unwrap();
        assert_eq!(read["draft"]["documents"]["assets"], "{unfinished");
        assert_eq!(read["draft"]["documents"]["state"], "{unfinished");
        let (state, object) = document_session(&fixture, &reference);
        assert_eq!(state, "consumed");
        assert!(object.is_none());
        let db = open(&fixture.0).unwrap();
        let object_state: String = db
            .query_row(
                "SELECT state FROM media_objects WHERE game_id='game'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(object_state, "deleting");
    }
    #[test]
    fn document_commit_sync_consumes_and_mismatch_rejects() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let fixture = Fixture::new();
        fixture.create();
        let mut updated = fixture.read()["records"][0]["value"].clone();
        updated["title"] = json!("Applied");
        let body = commit(0, &[row("games", "game", None, &updated)]).to_string();
        let (reference, _) = upload_document(&fixture, "commit", &body);
        let reply = fixture
            .request(json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":"game","bodyRef":reference}}))
            .unwrap();
        assert_eq!(reply["version"], 1);
        assert_eq!(fixture.read()["records"][0]["value"]["title"], "Applied");
        let (state, object) = document_session(&fixture, &reference);
        assert_eq!(state, "consumed");
        assert!(object.is_none());
        // Operation mismatch: a draftSave session cannot serve a commit.
        let (wrong_operation, _) = upload_document(&fixture, "draftSave", &body);
        let err = fixture
            .request(json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":"game","bodyRef":wrong_operation}}))
            .unwrap_err();
        assert!(err.contains("scopeMismatch"), "{err}");
        assert_eq!(document_session(&fixture, &wrong_operation).0, "verified");
        // Game mismatch: a session scoped to another game cannot serve this game.
        let db = open(&fixture.0).unwrap();
        db.execute("INSERT INTO games(id,value) VALUES('other','{}')", [])
            .unwrap();
        drop(db);
        let other_body =
            json!({"kind":"commit","gameId":"other","version":0,"records":[],"deleteSessions":[]})
                .to_string();
        let begun = fixture
            .request(json!({"kind":"mediaUploadBegin","gameId":"other","purpose":"document","operation":"commit","mime":"application/json","size":other_body.len()}))
            .unwrap();
        let other_id = begun["uploadId"].as_str().unwrap();
        fixture
            .request(json!({"kind":"mediaUploadChunk","gameId":"other","uploadId":other_id,"index":0,"sha256":doc_sha256(other_body.as_bytes()),"data":STANDARD.encode(other_body.as_bytes())}))
            .unwrap();
        fixture
            .request(json!({"kind":"mediaUploadFinish","gameId":"other","uploadId":other_id}))
            .unwrap();
        let wrong_game = format!("helia-upload:{other_id}");
        let err = fixture
            .request(json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":"game","bodyRef":wrong_game}}))
            .unwrap_err();
        assert!(err.contains("scopeMismatch"), "{err}");
        assert_eq!(document_session(&fixture, &wrong_game).0, "verified");
    }
    #[test]
    fn document_small_request_stays_inline() {
        let fixture = Fixture::new();
        fixture.create();
        let mut updated = fixture.read()["records"][0]["value"].clone();
        updated["title"] = json!("Inline");
        let reply = fixture
            .request(json!({"kind":"sync","known":[],"request":commit(0,&[row("games","game",None,&updated)])}))
            .unwrap();
        assert_eq!(reply["version"], 1);
        let db = open(&fixture.0).unwrap();
        assert_eq!(count(&db, "media_uploads"), 0);
    }
    #[test]
    fn document_large_resource_game_draft_apply_release() {
        let fixture = Fixture::new();
        fixture.create();
        let resources = resource_budget_map();
        let mut updated = fixture.read()["records"][0]["value"].clone();
        updated["resources"] = resources.clone();
        let body = commit(0, &[row("games", "game", None, &updated)]).to_string();
        assert!(body.len() > 8 * 1024 * 1024);
        let (reference, _) = upload_document(&fixture, "commit", &body);
        let reply = fixture
            .request(json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":"game","bodyRef":reference}}))
            .unwrap();
        assert_eq!(reply["version"], 1);
        let saved = fixture.read()["records"][0]["value"].clone();
        assert_eq!(
            resource_list_bytes(saved.get("resources")).unwrap(),
            RESOURCE_LIST_BYTES
        );
        let draft = json!({"version":3,"gameId":"game","baseContent":updated,"documents":{"info":"{}","instructions":"{}","state":"{}","code":"{}","lorebook":"{}","regex":"[]","assets":resources.to_string()}});
        let draft_body =
            json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}).to_string();
        assert!(draft_body.len() > 8 * 1024 * 1024);
        let (draft_ref, _) = upload_document(&fixture, "draftSave", &draft_body);
        let saved_draft = fixture
            .request(json!({"kind":"writeDraft","gameId":"game","bodyRef":draft_ref}))
            .unwrap();
        assert_eq!(saved_draft["version"], 1);
        let released = fixture
            .request(json!({"kind":"versioning","action":"release","gameId":"game","contentVersion":"1.0.0"}))
            .unwrap();
        assert_eq!(released["releaseResult"]["kind"], "released");
    }
    #[test]
    fn document_large_remainder_draft_preserves_unfinished() {
        let fixture = Fixture::new();
        fixture.create();
        let state = "한".repeat(7_864_320);
        let draft = json!({"version":3,"gameId":"game","baseContent":game("Large"),"documents":{"info":"{}","instructions":"{}","state":state,"code":"{}","lorebook":"{}","regex":"[]","assets":"{unfinished"}});
        let body =
            json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}).to_string();
        let bytes = body.len();
        assert!(
            bytes > 22 * 1024 * 1024 && bytes < 23 * 1024 * 1024,
            "{bytes}"
        );
        let (reference, _) = upload_document(&fixture, "draftSave", &body);
        let saved = fixture
            .request(json!({"kind":"writeDraft","gameId":"game","bodyRef":reference}))
            .unwrap();
        assert_eq!(saved["version"], 1);
        let read = fixture
            .request(json!({"kind":"readDraft","gameId":"game"}))
            .unwrap();
        assert_eq!(read["draft"]["documents"]["state"], state);
        assert_eq!(read["draft"]["documents"]["assets"], "{unfinished");
    }
    #[test]
    fn accepts_hundreds_of_small_resources_across_save_draft_and_release() {
        for count in [129usize, 257] {
            let fixture = Fixture::new();
            fixture.create();
            let resources = many_resources(count);
            let mut updated = fixture.read()["records"][0]["value"].clone();
            updated["resources"] = resources.clone();
            fixture
                .request(commit(0, &[row("games", "game", None, &updated)]))
                .unwrap();
            let read = fixture.read();
            assert_eq!(
                read["records"][0]["value"]["resources"]
                    .as_object()
                    .unwrap()
                    .len(),
                count
            );
            let draft = json!({
                "version":3,
                "gameId":"game",
                "baseContent":updated,
                "documents":{
                    "info":"{}",
                    "instructions":"{}",
                    "state":"{}",
                    "code":"{}",
                    "lorebook":"{}",
                    "assets":serde_json::to_string(&resources).unwrap()
                }
            });
            let saved = fixture
                .request(json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}))
                .unwrap();
            assert_eq!(saved["version"], 1);
            let released = fixture
                .request(
                    json!({"kind":"versioning","action":"release","gameId":"game","contentVersion":"1.0.0"}),
                )
                .unwrap();
            assert_eq!(released["releaseResult"]["kind"], "released", "{count}");
            let release_id = released["releaseResult"]["state"]["currentRelease"]["id"]
                .as_str()
                .unwrap();
            let frozen = fixture
                .request(json!({"kind":"versioning","action":"getRelease","gameId":"game","releaseId":release_id}))
                .unwrap();
            assert_eq!(
                frozen["release"]["content"]["resources"]
                    .as_object()
                    .unwrap()
                    .len(),
                count
            );
        }
    }
    #[test]
    fn validates_source_code_projects_and_current_drafts() {
        let project = json!({"version":1,"entry":"main.ts","files":{"main.ts":{"language":"typescript","source":"export {};"}},"folders":["components/empty"]});
        assert!(code_project(Some(&project)));
        let mut invalid = project.clone();
        invalid["entry"] = json!("missing.ts");
        assert!(!code_project(Some(&invalid)));
        invalid = project.clone();
        invalid["folders"] = json!(["main.ts/child"]);
        assert!(!code_project(Some(&invalid)));
        let mut game = game("Source project");
        game["code"] = project;
        assert!(valid_value(Table::Games, &game));
        let draft = json!({"version":3,"gameId":"game","baseContent":game,"documents":{"info":"{}","instructions":"{}","state":"{unfinished","code":"{unfinished","lorebook":"{}","assets":"{}"}});
        assert!(validate_draft("game", &draft).is_ok());
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "helia-native-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&directory).unwrap();
            Self(directory.join("helia.sqlite"))
        }
        fn request(&self, input: Value) -> Result<Value, String> {
            execute_request(&self.0, input)
        }
        fn create(&self) {
            self.request(create()).unwrap();
        }
        fn read(&self) -> Value {
            self.request(json!({ "kind": "read", "gameId": "game", "sessionId": "session" }))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }
    fn game(title: &str) -> Value {
        json!({ "schemaVersion": 2, "id": "game", "activeSessionId": "session", "title": title, "genre": "", "description": "", "settings": { "description": "", "firstMessage": "", "authorNote": "" }, "schema":{"type":"object","properties":{},"additionalProperties":false}, "initialState": {}, "scripts": {}, "createdAt": "2026-11-02T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z" })
    }

    #[test]
    fn media_v2_blob_validation_accepts_metadata_and_rejects_invalid_values() {
        let blob = json!({"schemaVersion":2,"id":"a".repeat(64),"gameId":"game","mime":"video/mp4","object":"b".repeat(64),"size":1});
        let stored: StoredRecord =
            serde_json::from_value(row("blobs", blob["id"].as_str().unwrap(), None, &blob))
                .unwrap();
        validate(&stored, "game").unwrap();
        for size in [
            json!(0),
            json!(-1),
            json!(0.5),
            json!(9_007_199_254_740_992_u64),
            json!("1"),
        ] {
            let mut invalid = blob.clone();
            invalid["size"] = size;
            assert!(!valid_value(Table::Blobs, &invalid));
        }
        for (key, value) in [
            ("object", json!("A".repeat(64))),
            ("object", json!("a".repeat(63))),
            ("id", json!("A".repeat(64))),
            ("mime", json!("text/html")),
        ] {
            let mut invalid = blob.clone();
            invalid[key] = value;
            assert!(!valid_value(Table::Blobs, &invalid));
        }
        let mut wrong_owner = stored;
        wrong_owner.value["gameId"] = json!("other");
        assert!(validate(&wrong_owner, "game").is_err());
    }
    fn row(table: &str, id: &str, session_id: Option<&str>, value: &Value) -> Value {
        json!({ "table": table, "id": id, "gameId": "game", "sessionId": session_id, "value": value })
    }
    fn session(id: &str) -> Value {
        json!({ "schemaVersion": 1, "id": id, "gameId": "game", "title": "세션", "messageCount": 0, "createdAt": "2026-11-02T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z" })
    }
    fn create() -> Value {
        json!({ "kind": "create", "gameId": "game", "records": [row("games", "game", None, &game("게임 🧪")), row("sessions", "session", Some("session"), &session("session"))] })
    }
    #[test]
    fn sync_transfers_only_missing_content_and_metadata_lists() {
        let fixture = Fixture::new();
        let mut initial = create();
        initial["records"][0]["value"]["resources"] = json!({"portrait":{"name":"portrait.png","mime":"image/png","data":"data:image/png;base64,AA=="}});
        fixture.request(initial).unwrap();
        let request = json!({"kind":"read","gameId":"game"});
        let first = fixture
            .request(json!({"kind":"sync","request":request,"known":[]}))
            .unwrap();
        assert!(!first.to_string().contains("base64"));
        let hash = &first["records"][0]["parts"]["resources"]["value"]["portrait"]["data"]["asset"];
        let media = fixture
            .request(json!({"kind":"asset","gameId":"game","hash":hash}))
            .unwrap();
        assert_eq!(media["data"], "data:image/png;base64,AA==");
        assert!(
            fixture
                .request(json!({"kind":"asset","gameId":"other","hash":hash}))
                .is_err()
        );
        let known: Vec<Value> = first["records"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|row| {
                row["parts"]
                    .as_object()
                    .unwrap()
                    .values()
                    .map(|part| part["hash"].clone())
            })
            .collect();
        let cached = fixture
            .request(json!({"kind":"sync","request":request,"known":known}))
            .unwrap();
        assert!(cached["records"].as_array().unwrap().iter().all(|row| {
            row["parts"]
                .as_object()
                .unwrap()
                .values()
                .all(|part| part.get("value").is_none())
        }));
        let list = fixture
            .request(json!({"kind":"sync","request":{"kind":"list"},"known":[]}))
            .unwrap();
        assert!(list["records"].as_array().unwrap().is_empty());
        assert!(list["games"][0].get("resources").is_none());
        assert_eq!(list["games"][0]["id"], "game");
    }

    #[test]
    fn media_consumers_preserve_v2_and_existing_v1_sqlite_reads() {
        for version in [1, 2] {
            let fixture = Fixture::new();
            fixture.create();
            let legacy: Value = serde_json::from_str(include_str!(
                "../../src/lib/games/state/fixtures/legacy-content.json"
            ))
            .unwrap();
            let mut identity = crate::media_identity::MediaIdentity::new("game", "image/png");
            identity.update(b"hello").unwrap();
            let identity = identity.digest();
            let id = if version == 2 {
                identity.blob_id.as_str()
            } else {
                legacy["blob"]["id"].as_str().unwrap()
            };
            let reference = format!("helia-asset:{id}");
            let mut snapshot_reference = legacy["reference"].clone();
            snapshot_reference["blobId"] = json!(id);
            let blob = if version == 2 {
                json!({"schemaVersion":2,"id":id,"gameId":"game","mime":"image/png","object":identity.raw,"size":5})
            } else {
                legacy["blob"].clone()
            };
            let mut current = fixture.read()["records"][0]["value"].clone();
            current["title"] = json!("Media");
            current["resources"] = legacy["resources"].clone();
            if version == 2 {
                current["resources"]["portrait"]["data"] = json!(reference);
            }
            let snapshot_id = legacy["snapshot"]["id"].as_str().unwrap();
            let progress = json!({"schemaVersion":2,"sessionId":"session","gameId":"game","snapshotId":snapshot_id,"headId":null,"revision":0,"state":{}});
            let draft = json!({"version":3,"gameId":"game","baseContent":current,"documents":{"info":"{}","instructions":"{}","state":"{}","code":"{}","lorebook":"{}","regex":"[]","assets":current["resources"].to_string()}});
            let db = open(&fixture.0).unwrap();
            db.execute(
                "UPDATE games SET value=?1 WHERE id='game'",
                [current.to_string()],
            )
            .unwrap();
            if version == 1 {
                db.execute(
                    "INSERT INTO blobs(id,game_id,value) VALUES(?1,'game',?2)",
                    params![id, blob.to_string()],
                )
                .unwrap();
            }
            db.execute(
                "INSERT INTO snapshots(id,game_id,value) VALUES(?1,'game',?2)",
                params![snapshot_id, legacy["snapshot"].to_string()],
            )
            .unwrap();
            db.execute("INSERT INTO snapshot_resources(id,game_id,snapshot_id,value) VALUES(?1,'game',?2,?3)", params![snapshot_reference["id"].as_str().unwrap(), snapshot_id, snapshot_reference.to_string()]).unwrap();
            db.execute("INSERT INTO progress(id,game_id,session_id,snapshot_id,value) VALUES('session','game','session',?1,?2)", params![snapshot_id, progress.to_string()]).unwrap();
            db.execute(
                "INSERT INTO editor_drafts(game_id,version,value) VALUES('game',1,?1)",
                [draft.to_string()],
            )
            .unwrap();
            if version == 2 {
                let upload = fixture.request(json!({"kind":"mediaUploadBegin","gameId":"game","purpose":"edit","mime":"image/png","size":5})).unwrap();
                fixture.request(json!({"kind":"mediaUploadChunk","gameId":"game","uploadId":upload["uploadId"],"index":0,"sha256":identity.raw,"data":"aGVsbG8="})).unwrap();
                let result = fixture.request(json!({"kind":"mediaUploadFinish","gameId":"game","uploadId":upload["uploadId"]})).unwrap();
                assert_eq!(result["blobId"], id);
            }
            drop(db);
            for include_history in [false, true] {
                let read = json!({"kind":"read","gameId":"game","sessionId":"session","includeHistory":include_history});
                let direct = fixture.request(read.clone()).unwrap();
                assert_eq!(direct["records"][0]["value"], current);
                let rows = direct["records"].as_array().unwrap();
                assert_eq!(
                    rows.iter().find(|r| r["table"] == "blobs").unwrap()["value"],
                    blob
                );
                assert_eq!(
                    rows.iter()
                        .find(|r| r["table"] == "snapshot_resources")
                        .unwrap()["value"],
                    snapshot_reference
                );
                let synced = fixture
                    .request(json!({"kind":"sync","request":read,"known":[]}))
                    .unwrap();
                let data = &synced["records"][0]["parts"]["resources"]["value"]["portrait"]["data"];
                if version == 2 {
                    assert_eq!(data, &json!(reference));
                    let rows = synced["records"].as_array().unwrap();
                    assert_eq!(
                        rows.iter().find(|r| r["table"] == "blobs").unwrap()["parts"]["value"]["value"],
                        blob
                    );
                } else {
                    assert!(data["asset"].is_string());
                    assert_eq!(
                        fixture
                            .request(json!({"kind":"asset","gameId":"game","hash":data["asset"]}))
                            .unwrap()["data"],
                        legacy["blob"]["data"]
                    );
                }
                let playing = fixture.request(json!({"kind":"sync","known":[],"request":{"kind":"read","gameId":"game","sessionId":"session","includeHistory":include_history,"play":true}})).unwrap();
                assert_eq!(
                    playing["records"][0]["parts"]["resources"]["value"]["portrait"]["data"],
                    reference
                );
                let rows = playing["records"].as_array().unwrap();
                let projected_blob = &rows.iter().find(|r| r["table"] == "blobs").unwrap()["parts"]
                    ["value"]["value"];
                if version == 2 {
                    assert_eq!(projected_blob, &blob);
                    assert!(
                        fixture
                            .request(json!({"kind":"asset","gameId":"game","hash":id}))
                            .is_err()
                    );
                } else {
                    assert_eq!(projected_blob["data"], reference);
                }
                assert_eq!(
                    fixture
                        .request(json!({"kind":"readDraft","gameId":"game"}))
                        .unwrap()["draft"],
                    draft
                );
            }
            let db = open(&fixture.0).unwrap();
            let media = crate::runtime_content::open_media(&db, "game", id)
                .unwrap()
                .unwrap();
            assert_eq!(media.mime, "image/png");
            assert_eq!(
                media
                    .read(0, media.size)
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .concat(),
                b"hello"
            );
            assert_eq!(
                fixture.read()["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["table"] == "blobs")
                    .unwrap()["value"],
                blob
            );
        }
    }
    #[test]
    fn media_v2_sync_rejects_blob_rows_owned_by_another_game() {
        let fixture = Fixture::new();
        fixture.create();
        let blob = json!({"schemaVersion":2,"id":"a".repeat(64),"gameId":"other","mime":"image/png","object":"b".repeat(64),"size":1});
        let db = open(&fixture.0).unwrap();
        db.execute(
            "INSERT INTO blobs(id,game_id,value) VALUES(?1,'game',?2)",
            params![blob["id"].as_str().unwrap(), blob.to_string()],
        )
        .unwrap();
        // The play projection refuses the row before it can create an alias.
        assert!(crate::runtime_content::project(&db, "blobs", "game", &blob).is_err());
        drop(db);
        // The editor read enumerates every owned blob row, so the sync reply fails too.
        let read = json!({"kind":"read","gameId":"game","includeHistory":true});
        assert!(
            fixture
                .request(json!({"kind":"sync","request":read,"known":[]}))
                .is_err()
        );
        let db = open(&fixture.0).unwrap();
        let aliases: i64 = db
            .query_row(
                "SELECT count(*) FROM runtime_assets WHERE blob_id=?1",
                [blob["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(aliases, 0);
    }

    #[test]
    fn media_v2_sync_rejects_malformed_blob_rows() {
        let fixture = Fixture::new();
        fixture.create();
        let blob = json!({"schemaVersion":2,"id":"c".repeat(64),"gameId":"game","mime":"image/png","object":"d".repeat(64),"size":1});
        let cases = [
            ("size", json!(0)),
            ("size", json!(1.5)),
            ("object", json!("A".repeat(64))),
            ("mime", json!("text/html")),
        ];
        for (key, value) in cases {
            let mut invalid = blob.clone();
            invalid[key] = value;
            let db = open(&fixture.0).unwrap();
            db.execute(
                "INSERT OR REPLACE INTO blobs(id,game_id,value) VALUES(?1,'game',?2)",
                params![invalid["id"].as_str().unwrap(), invalid.to_string()],
            )
            .unwrap();
            drop(db);
            let read = json!({"kind":"read","gameId":"game","includeHistory":true});
            assert!(
                fixture
                    .request(json!({"kind":"sync","request":read,"known":[]}))
                    .is_err()
            );
            let db = open(&fixture.0).unwrap();
            let aliases: i64 = db
                .query_row(
                    "SELECT count(*) FROM runtime_assets WHERE blob_id=?1",
                    [invalid["id"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(aliases, 0);
            db.execute(
                "DELETE FROM blobs WHERE id=?1",
                [invalid["id"].as_str().unwrap()],
            )
            .unwrap();
        }
    }

    #[test]
    fn media_v2_open_media_refuses_another_game_id() {
        let fixture = Fixture::new();
        fixture.create();
        let mut identity = crate::media_identity::MediaIdentity::new("game", "image/png");
        identity.update(b"hello").unwrap();
        let identity = identity.digest();
        let id = identity.blob_id.as_str();
        let blob = json!({"schemaVersion":2,"id":id,"gameId":"game","mime":"image/png","object":identity.raw,"size":5});
        let db = open(&fixture.0).unwrap();
        db.execute(
            "INSERT INTO blobs(id,game_id,value) VALUES(?1,'game',?2)",
            params![id, blob.to_string()],
        )
        .unwrap();
        db.execute("INSERT INTO games(id,value) VALUES('other','{}')", [])
            .unwrap();
        db.execute("INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES('object','game','ready',5,1048576,?1,?2,'now')", params![identity.raw, identity.crc]).unwrap();
        db.execute(
            "INSERT INTO media_chunks VALUES('object',0,?1,?2)",
            params![identity.raw, b"hello".as_slice()],
        )
        .unwrap();
        assert_eq!(
            crate::runtime_content::open_media(&db, "game", id)
                .unwrap()
                .unwrap()
                .size,
            5
        );
        assert!(
            crate::runtime_content::open_media(&db, "other", id)
                .unwrap()
                .is_none()
        );
        // A forged alias in the other game still resolves only through that game's blobs.
        db.execute(
            "INSERT INTO runtime_assets(game_id,hash,blob_id) VALUES('other',?1,?1)",
            [id],
        )
        .unwrap();
        assert!(
            crate::runtime_content::read_asset(&db, "other", id)
                .unwrap()
                .is_none()
        );
        assert!(
            crate::runtime_content::open_media(&db, "other", id)
                .unwrap()
                .is_none()
        );
        assert!(
            fixture
                .request(json!({"kind":"asset","gameId":"other","hash":id}))
                .is_err()
        );
    }

    #[test]
    fn v1_blob_references_stay_verbatim_in_sqlite_reads() {
        let fixture = Fixture::new();
        fixture.create();
        let legacy: Value = serde_json::from_str(include_str!(
            "../../src/lib/games/state/fixtures/legacy-content.json"
        ))
        .unwrap();
        let blob = legacy["blob"].clone();
        let id = blob["id"].as_str().unwrap();
        let reference = json!(format!("helia-asset:{id}"));
        let mut current = fixture.read()["records"][0]["value"].clone();
        current["resources"] =
            json!({"portrait":{"name":"images/portrait.png","mime":"image/png","data":reference}});
        let db = open(&fixture.0).unwrap();
        db.execute(
            "UPDATE games SET value=?1 WHERE id='game'",
            [current.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO blobs(id,game_id,value) VALUES(?1,'game',?2)",
            params![id, blob.to_string()],
        )
        .unwrap();
        drop(db);
        let read = json!({"kind":"read","gameId":"game","includeHistory":true});
        let synced = fixture
            .request(json!({"kind":"sync","request":read,"known":[]}))
            .unwrap();
        assert_eq!(
            synced["records"][0]["parts"]["resources"]["value"]["portrait"]["data"],
            reference
        );
        let playing = fixture.request(json!({"kind":"sync","known":[],"request":{"kind":"read","gameId":"game","includeHistory":true,"play":true}})).unwrap();
        assert_eq!(
            playing["records"][0]["parts"]["resources"]["value"]["portrait"]["data"],
            reference
        );
        let db = open(&fixture.0).unwrap();
        // The v1 reference is never turned into inline bytes and the blob row is untouched.
        let blobs: i64 = db
            .query_row("SELECT count(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(blobs, 1);
        let saved: String = db
            .query_row("SELECT value FROM blobs WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), blob);
    }

    #[test]
    fn sync_game_patches_preserve_media_and_the_version_guard() {
        let fixture = Fixture::new();
        fixture.create();
        let patch = json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":"game","version":0,"records":[{"table":"games","id":"game","gameId":"game","sessionId":null,"patch":{"set":{"title":"Updated"},"remove":[]}}],"deleteSessions":[]}});
        fixture.request(patch.clone()).unwrap();
        assert_eq!(fixture.read()["records"][0]["value"]["title"], "Updated");
        assert_eq!(fixture.request(patch).unwrap_err(), CONFLICT);
    }
    #[test]
    fn validates_unified_state_authoring_drafts() {
        let mut draft = json!({"version":2,"gameId":"game","baseContent":game("Original"),"documents":{"info":"{}","instructions":"{}","state":"{unfinished","scripts":"{}","ui":"null","lorebook":"{}","assets":"{}"}});
        assert!(validate_draft("game", &draft).is_ok());
        draft["version"] = json!(1);
        assert!(validate_draft("game", &draft).is_err());
        draft["documents"]["schema"] = json!("{unfinished-schema");
        assert!(validate_draft("game", &draft).is_ok());
        draft["version"] = json!(2);
        draft["documents"].as_object_mut().unwrap().remove("state");
        assert!(validate_draft("game", &draft).is_err());
    }

    #[test]
    fn persists_large_unfinished_editor_drafts_with_revision_guards() {
        let fixture = Fixture::new();
        fixture.create();
        let text = "x".repeat(6 * 1024 * 1024);
        let draft = json!({"version":3,"gameId":"game","baseContent":game("Original"),"documents":{"info":"{}","instructions":"{}","state":text,"code":"{unfinished","lorebook":"{}","assets":"{}"}});
        let saved = fixture
            .request(json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}))
            .unwrap();
        assert_eq!(saved["version"], 1);
        let read = fixture
            .request(json!({"kind":"readDraft","gameId":"game"}))
            .unwrap();
        assert_eq!(
            read["draft"]["documents"]["state"].as_str().unwrap().len(),
            6 * 1024 * 1024
        );
        assert!(
            fixture
                .request(json!({"kind":"writeDraft","gameId":"game","version":0,"draft":null}))
                .is_err()
        );
        let mut foreign = draft;
        foreign["gameId"] = json!("other");
        assert!(
            fixture
                .request(json!({"kind":"writeDraft","gameId":"game","version":1,"draft":foreign}))
                .is_err()
        );
        let cleared = fixture
            .request(json!({"kind":"writeDraft","gameId":"game","version":1,"draft":null}))
            .unwrap();
        assert_eq!(cleared, json!({"version":2,"draft":null}));
        assert!(
            fixture
                .request(json!({"kind":"writeDraft","gameId":"game","version":1,"draft":null}))
                .is_err()
        );
    }
    fn commit(version: u64, records: &[Value]) -> Value {
        json!({ "kind": "commit", "gameId": "game", "version": version, "records": records, "deleteSessions": [] })
    }
    #[test]
    fn restored_games_rejoin_active_listings_and_accept_commits() {
        let fixture = Fixture::new();
        fixture.create();
        fixture
            .request(json!({"kind":"trash","gameId":"game"}))
            .unwrap();
        let trashed = fixture
            .request(json!({"kind":"list","includeTrashed":false}))
            .unwrap();
        assert!(trashed["games"].as_array().unwrap().is_empty());
        // Restore stores trashedAt: null, which must count as "not trashed" everywhere.
        fixture
            .request(json!({"kind":"restore","gameId":"game"}))
            .unwrap();
        let restored = fixture
            .request(json!({"kind":"list","includeTrashed":false}))
            .unwrap();
        assert_eq!(restored["games"][0]["id"], "game");
        assert!(restored["games"][0]["trashedAt"].is_null());
        assert_eq!(
            fixture.read()["records"][0]["value"]["trashedAt"],
            Value::Null
        );
        assert_eq!(
            fixture
                .request(json!({"kind":"purge","gameId":"game"}))
                .unwrap_err(),
            "휴지통에 있는 게임만 삭제할 수 있어요."
        );
        fixture.request(commit(0, &[])).unwrap();
        assert_eq!(
            fixture
                .request(json!({"kind":"read","gameId":"game"}))
                .unwrap()["version"],
            1
        );
    }
    fn branched_fixture() -> Fixture {
        let fixture = Fixture::new();
        fixture.create();
        let now = "2026-11-02T00:00:00.000Z";
        let schema = json!({"type":"object","properties":{"gold":{"type":"integer"}},"required":["gold"],"additionalProperties":false});
        let snapshot = json!({"schemaVersion":1,"id":"snapshot","gameId":"game","createdAt":now,"settings":game("")["settings"],"schema":schema,"initialState":{"gold":100},"scripts":{}});
        let progress = json!({"schemaVersion":2,"sessionId":"session","gameId":"game","snapshotId":"snapshot","headId":"F","revision":6,"state":{"gold":40}});
        let mut current_session = session("session");
        current_session["messageCount"] = json!(6);
        let mut records = vec![
            row("sessions", "session", Some("session"), &current_session),
            row("snapshots", "snapshot", None, &snapshot),
            row("progress", "session", Some("session"), &progress),
        ];
        for (index, (name, parent, before, after)) in [
            ("A", None, 100, 90),
            ("B", Some("A"), 90, 80),
            ("C", Some("B"), 80, 70),
            ("D", Some("C"), 70, 60),
            ("E", Some("B"), 80, 50),
            ("F", Some("E"), 50, 40),
        ]
        .into_iter()
        .enumerate()
        {
            let message_id = format!("message-{name}");
            records.push(row("transactions",name,Some("session"),&json!({"schemaVersion":2,"id":name,"gameId":"game","sessionId":"session","parentId":parent,"createdAt":now,"createdRevision":index+1,"action":{"name":name,"args":{}},"description":format!("Event {name}"),"changes":[{"path":["gold"],"before":{"exists":true,"value":before},"after":{"exists":true,"value":after}}],"messageId":message_id})));
            records.push(row("messages",&message_id,Some("session"),&json!({"schemaVersion":1,"id":message_id,"gameId":"game","sessionId":"session","sequence":index+1,"role":"assistant","kind":"dialogue","content":name,"createdAt":now})));
            let memory_id = format!("memory-{name}");
            records.push(row("memories",&memory_id,Some("session"),&json!({"schemaVersion":1,"id":memory_id,"gameId":"game","sessionId":"session","sourceTransactionIds":[name],"content":name,"createdAt":now})));
        }
        fixture.request(commit(0, &records)).unwrap();
        fixture
    }
    fn prune_request(event: &str, revision: u64) -> Value {
        json!({"kind":"prune","gameId":"game","sessionId":"session","eventId":event,"expectedRevision":revision})
    }
    #[test]
    fn validates_and_prunes_all_messages_of_one_atomic_event() {
        let fixture = branched_fixture();
        let before = fixture.read();
        let rows = before["records"].as_array().unwrap();
        let mut current_session =
            rows.iter().find(|row| row["table"] == "sessions").unwrap()["value"].clone();
        current_session["messageCount"] = json!(8);
        let mut progress =
            rows.iter().find(|row| row["table"] == "progress").unwrap()["value"].clone();
        progress["headId"] = json!("G");
        progress["revision"] = json!(7);
        progress["state"]["gold"] = json!(39);
        let now = "2026-11-02T00:00:00.000Z";
        let event = json!({"schemaVersion":2,"id":"G","gameId":"game","sessionId":"session","parentId":"F","createdAt":now,"createdRevision":7,"action":{"name":"craft","args":{}},"changes":[{"path":["gold"],"before":{"exists":true,"value":40},"after":{"exists":true,"value":39}}],"messageId":"user-G","messageIds":["user-G","bot-G"]});
        let mut updates = vec![
            row("sessions", "session", Some("session"), &current_session),
            row("progress", "session", Some("session"), &progress),
            row("transactions", "G", Some("session"), &event),
        ];
        for (index, (id, role)) in [("user-G", "user"), ("bot-G", "assistant")]
            .iter()
            .enumerate()
        {
            let message = json!({"schemaVersion":1,"id":id,"gameId":"game","sessionId":"session","sequence":index+7,"role":role,"kind":"dialogue","content":id,"createdAt":now});
            updates.push(row("messages", id, Some("session"), &message));
        }
        for ids in [
            json!(["bot-G", "user-G"]),
            json!(["user-G", "user-G"]),
            json!(["user-G", "missing"]),
        ] {
            let mut invalid = updates.clone();
            invalid[2]["value"]["messageIds"] = ids;
            assert!(fixture.request(commit(1, &invalid)).is_err());
            assert_eq!(fixture.read(), before);
        }
        fixture.request(commit(1, &updates)).unwrap();
        let saved = fixture.read();
        assert_eq!(
            saved["records"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["table"] == "messages")
                .count(),
            8
        );
        let pruned = fixture.request(prune_request("G", 7)).unwrap();
        let rows = pruned["records"].as_array().unwrap();
        assert_eq!(
            rows.iter().filter(|row| row["table"] == "messages").count(),
            6
        );
        assert!(
            !rows
                .iter()
                .any(|row| row["id"] == "user-G" || row["id"] == "bot-G")
        );
        assert_eq!(
            rows.iter().find(|row| row["table"] == "progress").unwrap()["value"]["state"]["gold"],
            40
        );
    }
    #[test]
    fn applies_migrated_checkpoints_without_rewriting_events_and_prunes_their_owned_data() {
        let fixture = branched_fixture();
        let before = fixture.read();
        let rows = before["records"].as_array().unwrap();
        let original =
            rows.iter().find(|row| row["table"] == "snapshots").unwrap()["value"].clone();
        let mut snapshot = original;
        snapshot["id"] = json!("updated-content");
        snapshot["schema"] = json!({"type":"object","properties":{"gold":{"type":"string"},"score":{"type":"integer"}},"required":["gold","score"],"additionalProperties":false});
        snapshot["initialState"] = json!({"gold":"100","score":0});
        let mut checkpoints = Vec::new();
        for (id, gold) in [
            ("A", "90"),
            ("B", "80"),
            ("C", "70"),
            ("D", "60"),
            ("E", "50"),
            ("F", "40"),
        ] {
            checkpoints.push(row("checkpoints",id,Some("session"),&json!({"schemaVersion":1,"id":id,"transactionId":id,"snapshotId":"updated-content","gameId":"game","sessionId":"session","state":{"gold":gold,"score":0}})));
        }
        let mut progress =
            rows.iter().find(|row| row["table"] == "progress").unwrap()["value"].clone();
        progress["snapshotId"] = json!("updated-content");
        progress["revision"] = json!(7);
        progress["state"] = json!({"gold":"40","score":0});
        let mut updates = vec![
            row("snapshots", "updated-content", None, &snapshot),
            row("progress", "session", Some("session"), &progress),
        ];
        updates.extend(checkpoints);
        fixture.request(commit(1, &updates)).unwrap();
        let all = fixture
            .request(json!({"kind":"read","gameId":"game","includeHistory":true}))
            .unwrap();
        assert!(
            all["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["table"] == "transactions")
        );
        let after = fixture.read();
        let saved = after["records"].as_array().unwrap();
        for event in rows.iter().filter(|row| row["table"] == "transactions") {
            assert!(saved.contains(event));
        }
        let pruned = fixture.request(prune_request("B", 7)).unwrap();
        let saved = pruned["records"].as_array().unwrap();
        let progress = &saved.iter().find(|row| row["table"] == "progress").unwrap()["value"];
        assert_eq!(progress["state"], json!({"gold":"90","score":0}));
        let checkpoints: Vec<_> = saved
            .iter()
            .filter(|row| row["table"] == "checkpoints")
            .collect();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["id"], "A");
    }
    #[test]
    fn prunes_subtrees_and_restores_logged_state_and_messages_after_reopening() {
        for (event, head, gold, kept) in [
            ("B", "A", 90, vec!["A"]),
            ("E", "B", 80, vec!["A", "B", "C", "D"]),
            ("C", "F", 40, vec!["A", "B", "E", "F"]),
        ] {
            let fixture = branched_fixture();
            let reply = fixture.request(prune_request(event, 6)).unwrap();
            assert_eq!(reply["version"], 2);
            assert_eq!(fixture.read(), reply);
            let rows = reply["records"].as_array().unwrap();
            let progress = &rows.iter().find(|row| row["table"] == "progress").unwrap()["value"];
            assert_eq!(progress["headId"], head);
            assert_eq!(progress["state"]["gold"], gold);
            assert_eq!(progress["revision"], 7);
            let mut messages: Vec<_> = rows
                .iter()
                .filter(|row| row["table"] == "messages")
                .map(|row| &row["value"])
                .collect();
            messages.sort_by_key(|value| value["sequence"].as_u64().unwrap());
            assert_eq!(
                messages
                    .iter()
                    .map(|value| value["content"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                kept
            );
            for (index, value) in messages.iter().enumerate() {
                assert_eq!(value["sequence"], index + 1);
            }
            assert_eq!(
                rows.iter().filter(|row| row["table"] == "memories").count(),
                kept.len()
            );
            assert_eq!(
                rows.iter()
                    .filter(|row| row["table"] == "transactions")
                    .count(),
                kept.len()
            );
            let empty = fixture.request(prune_request("A", 7)).unwrap();
            let rows = empty["records"].as_array().unwrap();
            let progress = &rows.iter().find(|row| row["table"] == "progress").unwrap()["value"];
            assert!(progress["headId"].is_null());
            assert_eq!(progress["state"]["gold"], 100);
            assert!(!rows.iter().any(|row| {
                ["messages", "transactions", "memories"].contains(&row["table"].as_str().unwrap())
            }));
        }
    }
    #[test]
    fn prune_failures_roll_back_deleted_records_sequences_metadata_and_version() {
        for (table, timing) in [
            ("transactions", "AFTER DELETE"),
            ("progress", "BEFORE UPDATE"),
            ("games", "BEFORE UPDATE"),
        ] {
            let fixture = branched_fixture();
            let before = fixture.read();
            open(&fixture.0).unwrap().execute_batch(&format!("CREATE TRIGGER fail_prune {timing} ON {table} BEGIN SELECT RAISE(ABORT,'forced failure'); END")).unwrap();
            assert!(fixture.request(prune_request("C", 6)).is_err());
            assert_eq!(fixture.read(), before);
        }
        let fixture = branched_fixture();
        let before = fixture.read();
        for request in [
            prune_request("E", 5),
            prune_request("missing", 6),
            json!({"kind":"prune","gameId":"game","sessionId":"foreign","eventId":"E","expectedRevision":6}),
        ] {
            assert!(fixture.request(request).is_err());
            assert_eq!(fixture.read(), before);
        }
    }
    #[test]
    fn simultaneous_prunes_using_one_revision_have_one_winner() {
        let fixture = branched_fixture();
        let handles: Vec<_> = ["C", "E"]
            .into_iter()
            .map(|event| {
                let path = fixture.0.clone();
                std::thread::spawn(move || execute_request(&path, prune_request(event, 6)))
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(fixture.read()["version"], 2);
    }
    #[test]
    fn creates_and_reopens_same_file() {
        let fixture = Fixture::new();
        fixture.create();
        let saved = fixture.read();
        assert_eq!(saved["version"], 0);
        assert_eq!(saved["records"].as_array().unwrap().len(), 2);
        assert_eq!(fixture.read(), saved);
    }
    #[test]
    fn schema_and_history_guards_roll_back_metadata_progress_and_version() {
        let fixture = Fixture::new();
        fixture.create();
        let now = "2026-11-02T00:00:00.000Z";
        let schema = json!({"type":"object","properties":{"hp":{"type":"integer"}},"required":["hp"],"additionalProperties":false});
        let snapshot = json!({"schemaVersion":1,"id":"snapshot","gameId":"game","createdAt":now,"settings":game("")["settings"],"schema":schema,"initialState":{"hp":100},"scripts":{}});
        let progress = json!({"schemaVersion":2,"sessionId":"session","gameId":"game","snapshotId":"snapshot","headId":null,"revision":0,"state":{"hp":100}});
        fixture
            .request(commit(
                0,
                &[
                    row("snapshots", "snapshot", None, &snapshot),
                    row("progress", "session", Some("session"), &progress),
                ],
            ))
            .unwrap();
        let before = fixture.read();
        for state in [
            json!({"hp":"bad"}),
            json!({"hp":100,"extra":true}),
            json!({"hp":50}),
        ] {
            let mut bad = progress.clone();
            bad["state"] = state;
            assert!(
                fixture
                    .request(commit(
                        1,
                        &[
                            row("games", "game", None, &game("changed")),
                            row("progress", "session", Some("session"), &bad)
                        ]
                    ))
                    .is_err()
            );
            assert_eq!(fixture.read(), before);
        }
        let event = json!({"schemaVersion":2,"id":"inactive","gameId":"game","sessionId":"session","parentId":null,"createdAt":now,"createdRevision":1,"action":{"name":"invalid","args":{}},"changes":[{"path":["hp"],"before":{"exists":true,"value":100},"after":{"exists":true,"value":"bad"}}]});
        let mut unchanged = progress;
        unchanged["revision"] = json!(1);
        assert!(
            fixture
                .request(commit(
                    1,
                    &[
                        row("progress", "session", Some("session"), &unchanged),
                        row("transactions", "inactive", Some("session"), &event)
                    ]
                ))
                .is_err()
        );
        assert_eq!(fixture.read(), before);
    }
    #[test]
    fn commits_full_session_and_cascades_its_deletion() {
        let fixture = Fixture::new();
        fixture.create();
        fixture.request(json!({"kind":"files","gameId":"game","sessionId":"session","operation":{"kind":"save","name":"keep.bin","mime":"application/octet-stream","size":1,"data":"AQ=="}})).unwrap();
        let now = "2026-11-02T00:00:00.000Z";
        let snapshot = json!({"schemaVersion":1,"id":"snapshot","gameId":"game","createdAt":now,"settings":game("")["settings"],"schema":{"type":"object","properties":{"gold":{"type":"integer"}},"additionalProperties":false},"initialState":{},"scripts":{}});
        let message = json!({"schemaVersion":1,"id":"message","gameId":"game","sessionId":"session","sequence":1,"role":"assistant","kind":"dialogue","content":"물약 🧪","createdAt":now});
        let progress = json!({"schemaVersion":2,"sessionId":"session","gameId":"game","snapshotId":"snapshot","headId":"event","revision":1,"state":{"gold":80}});
        let event = json!({"schemaVersion":2,"id":"event","gameId":"game","sessionId":"session","parentId":null,"createdAt":now,"createdRevision":1,"action":{"name":"buy","args":{}},"changes":[{"path":["gold"],"before":{"exists":false},"after":{"exists":true,"value":80}}],"messageId":"message"});
        let memory = json!({"schemaVersion":1,"id":"memory","gameId":"game","sessionId":"session","sourceTransactionIds":["event"],"content":"기억","createdAt":now});
        let mut current_session = session("session");
        current_session["messageCount"] = json!(1);
        fixture
            .request(commit(
                0,
                &[
                    row("sessions", "session", Some("session"), &current_session),
                    row("snapshots", "snapshot", None, &snapshot),
                    row("messages", "message", Some("session"), &message),
                    row("progress", "session", Some("session"), &progress),
                    row("transactions", "event", Some("session"), &event),
                    row("memories", "memory", Some("session"), &memory),
                ],
            ))
            .unwrap();
        let saved = fixture.read();
        assert_eq!(saved["records"].as_array().unwrap().len(), 7);
        assert_eq!(fixture.request(json!({"kind":"files","gameId":"game","sessionId":"session","operation":{"kind":"list"}})).unwrap()["files"].as_array().unwrap().len(),1);
        assert_eq!(
            saved["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["table"] == "progress")
                .unwrap()["value"]["state"]["gold"],
            80
        );
        let mut new_game = game("게임");
        new_game["activeSessionId"] = json!("replacement");
        let mut request = commit(
            1,
            &[
                row("games", "game", None, &new_game),
                row(
                    "sessions",
                    "replacement",
                    Some("replacement"),
                    &session("replacement"),
                ),
            ],
        );
        request["deleteSessions"] = json!(["session"]);
        fixture.request(request).unwrap();
        let remaining = fixture
            .request(json!({"kind":"read","gameId":"game"}))
            .unwrap();
        assert_eq!(remaining["records"].as_array().unwrap().len(), 2);
        let connection = open(&fixture.0).unwrap();
        for table in [
            "messages",
            "progress",
            "transactions",
            "memories",
            "session_files",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }
    #[test]
    fn rolls_back_prior_writes_and_revision_on_foreign_key_failure() {
        let fixture = Fixture::new();
        fixture.create();
        let before = fixture.read();
        let message = json!({ "schemaVersion": 1, "id": "message", "gameId": "game", "sessionId": "foreign", "sequence": 1, "role": "user", "kind": "dialogue", "content": "안녕", "createdAt": "2026-11-02T00:00:00.000Z" });
        assert!(
            fixture
                .request(commit(
                    0,
                    &[
                        row("games", "game", None, &game("changed")),
                        row("messages", "message", Some("foreign"), &message)
                    ]
                ))
                .is_err()
        );
        assert_eq!(fixture.read(), before);
    }
    #[test]
    fn rejects_stale_revision() {
        let fixture = Fixture::new();
        fixture.create();
        fixture
            .request(commit(0, &[row("games", "game", None, &game("new"))]))
            .unwrap();
        assert_eq!(fixture.request(commit(0, &[])).unwrap_err(), CONFLICT);
        assert_eq!(fixture.read()["version"], 1);
    }
    #[test]
    fn rejects_malformed_records_and_arbitrary_sql() {
        let fixture = Fixture::new();
        fixture.create();
        let before = fixture.read();
        let mut bad = game("bad");
        bad["initialState"] = json!({"__proto__": {"polluted": true}});
        assert!(
            fixture
                .request(commit(0, &[row("games", "game", None, &bad)]))
                .is_err()
        );
        assert!(
            fixture
                .request(json!({"kind": "sql", "query": "DROP TABLE games"}))
                .is_err()
        );
        assert_eq!(fixture.read(), before);
    }
    #[test]
    fn concurrent_commits_have_one_winner() {
        let fixture = Fixture::new();
        fixture.create();
        let handles: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|title| {
                let path = fixture.0.clone();
                std::thread::spawn(move || {
                    execute_request(
                        &path,
                        commit(0, &[row("games", "game", None, &game(title))]),
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
                .filter(|result| result.as_ref().is_err_and(|error| error == CONFLICT))
                .count(),
            1
        );
    }
    #[test]
    fn production_command_dispatches_with_the_apps_private_database_path() {
        let fixture = Fixture::new();
        let app = tauri::test::mock_builder()
            .manage(StoragePath(fixture.0.clone()))
            .manage(StorageAccess {
                token: "test-only-token".into(),
            })
            .invoke_handler(tauri::generate_handler![storage_request])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let response = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: "storage_request".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(
                    json!({ "request": create(), "token": "test-only-token" }),
                ),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
        assert_eq!(response["version"], 0);
        assert_eq!(fixture.read()["records"].as_array().unwrap().len(), 2);

        for token in ["", "forged-token"] {
            let denied = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "storage_request".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "about:srcdoc".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        json!({ "request": {"kind":"list"}, "token": token }),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            );
            assert!(denied.is_err());
        }
    }
}
