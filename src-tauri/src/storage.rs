use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const MIGRATION: &str = include_str!("../../src/lib/storage/migrations/0000_initial.sql");
const CONFLICT: &str = "STORAGE_CONFLICT";

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
            Object.defineProperty(window, '__HELIA_CREDENTIALS__', {{
                value: request => invoke('credential_request', {{ request, token }}),
                writable: false, configurable: false
            }});
            Object.defineProperty(window, '__HELIA_AI__', {{
                value: (request, onChunk) => invoke('ai_request', {{ request, onChunk, token }}),
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
        }
    }
    fn order(self) -> u8 {
        match self {
            Self::Games => 0,
            Self::Sessions => 1,
            Self::Snapshots => 2,
            Self::Messages => 3,
            Self::Progress => 4,
            Self::Transactions => 5,
            Self::Memories => 6,
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
    List,
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
    },
    Prune {
        game_id: String,
        session_id: String,
        event_id: String,
        expected_revision: u64,
    },
}

fn open(path: &Path) -> Result<Connection, String> {
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
    if (draft["version"] != 1 && draft["version"] != 2)
        || draft["gameId"].as_str() != Some(game_id)
        || !draft["documents"].is_object()
        || serde_json::to_string(draft)
            .map_err(|_| "잘못된 편집 초안")?
            .encode_utf16()
            .count()
            > 16 * 1024 * 1024
    {
        return Err("편집 초안의 형식이 올바르지 않아요.".into());
    }
    for name in ["info", "instructions", "state", "scripts", "ui", "lorebook"] {
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
    let (query, parameters) = if let Some(game) = game_id {
        if table == Table::Games {
            (
                "SELECT id, value FROM games WHERE id=?1".to_owned(),
                vec![game],
            )
        } else if let Some(session) = session_id.filter(|_| table != Table::Sessions) {
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
        _ => 1,
    };
    let id_key = if row.table == Table::Progress {
        "sessionId"
    } else {
        "id"
    };
    if row.id.trim().is_empty()
        || row.game_id != game_id
        || row.value[id_key].as_str() != Some(row.id.as_str())
        || row.value["schemaVersion"].as_u64() != Some(expected)
        || (row.table != Table::Games && row.value["gameId"].as_str() != Some(game_id))
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
        Table::Snapshots
            if row
                .session_id
                .as_deref()
                .is_none_or(|id| id.trim().is_empty()) =>
        {
            return Err("스냅샷 소유 정보가 없어요.".into());
        }
        Table::Messages | Table::Progress | Table::Transactions | Table::Memories
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
    if modules.is_empty() || modules.len() > 32 || !modules.contains_key(entry) {
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
    if let Some(style) = value.get("chatStyle") {
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
fn resources(value: Option<&Value>) -> bool {
    use base64::Engine;
    let Some(value) = value else {
        return true;
    };
    let Some(entries) = value.as_object() else {
        return false;
    };
    if entries.len() > 128 {
        return false;
    }
    let mut total = 0;
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
            || ![
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "audio/mpeg",
                "audio/wav",
                "audio/ogg",
                "video/mp4",
                "video/webm",
            ]
            .contains(&mime)
        {
            return false;
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
        total += bytes.len();
        if bytes.len() > 1_048_576 || total > 3_145_728 {
            return false;
        }
    }
    true
}
fn valid_value(table: Table, value: &Value) -> bool {
    match table {
        Table::Games => {
            id(&value["title"])
                && value["title"]
                    .as_str()
                    .is_some_and(|v| v.trim().encode_utf16().count() <= 120)
                && value["genre"]
                    .as_str()
                    .is_some_and(|v| v.trim().encode_utf16().count() <= 80)
                && value["description"]
                    .as_str()
                    .is_some_and(|v| v.trim().encode_utf16().count() <= 2000)
                && timestamp(&value["createdAt"])
                && timestamp(&value["updatedAt"])
                && settings(&value["settings"])
                && object_state(&value["initialState"])
                && scripts(&value["scripts"])
                && game_ui(value.get("ui"))
                && resources(value.get("resources"))
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
        Table::Snapshots => {
            timestamp(&value["createdAt"])
                && settings(&value["settings"])
                && object_state(&value["initialState"])
                && scripts(&value["scripts"])
                && game_ui(value.get("ui"))
                && resources(value.get("resources"))
                && value.get("restoredStates").is_none_or(|states| {
                    states.as_object().is_some_and(|states| {
                        states
                            .iter()
                            .all(|(key, state)| !key.trim().is_empty() && object_state(state))
                    }) && id(&value["migrationFrom"])
                })
        }
        Table::Progress => {
            id(&value["snapshotId"])
                && (value["headId"].is_null() || id(&value["headId"]))
                && value.get("headId").is_some()
                && counter(&value["revision"])
                && object_state(&value["state"])
        }
        Table::Transactions => {
            timestamp(&value["createdAt"])
                && counter(&value["createdRevision"])
                && value.get("parentId").is_some()
                && (value["parentId"].is_null() || id(&value["parentId"]))
                && id(&value["action"]["name"])
                && object_state(&value["action"]["args"])
                && (value.get("messageId").is_none() || id(&value["messageId"]))
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
                        }) && ["before", "after"].iter().all(|key| {
                            match change[key]["exists"].as_bool() {
                                Some(false) => true,
                                Some(true) => change[key].get("value").is_some_and(state),
                                None => false,
                            }
                        })
                    })
                })
        }
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
        if row.table != Table::Sessions {
            fields.push("session_id");
            values.push(json!(row.session_id));
        }
        fields.push("value");
        values.push(json!(value));
        if row.table == Table::Messages {
            fields.push("sequence");
            values.push(row.value["sequence"].clone());
        }
        if row.table == Table::Progress {
            fields.push("snapshot_id");
            values.push(row.value["snapshotId"].clone());
        }
        let immutable = matches!(
            row.table,
            Table::Snapshots | Table::Transactions | Table::Memories
        );
        let conflict = if create || immutable {
            String::new()
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
    if count != 1 {
        return Err("다른 세션의 저장 항목이에요.".into());
    }
    Ok(())
}

pub(crate) fn execute_request(path: &Path, input: Value) -> Result<Value, String> {
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
        Request::Read { .. } | Request::ReadDraft { .. } | Request::List
    );
    let transaction = connection
        .transaction_with_behavior(if read {
            TransactionBehavior::Deferred
        } else {
            TransactionBehavior::Immediate
        })
        .map_err(db_error)?;
    let result = match request {
        Request::ReadDraft { game_id } => read_draft(&transaction, &game_id)?,
        Request::WriteDraft {
            game_id,
            version,
            draft,
        } => {
            let previous = read_draft(&transaction, &game_id)?;
            if version >= 9_007_199_254_740_991 || previous["version"].as_u64() != Some(version) {
                return Err("다른 편집기에서 초안이 변경되었어요.".into());
            }
            validate_draft(&game_id, &draft)?;
            let text = if draft.is_null() {
                None
            } else {
                Some(serde_json::to_string(&draft).map_err(|_| "잘못된 편집 초안")?)
            };
            transaction.execute("INSERT INTO editor_drafts (game_id,version,value) VALUES (?1,?2,?3) ON CONFLICT(game_id) DO UPDATE SET version=excluded.version,value=excluded.value",params![game_id,(version+1) as i64,text]).map_err(db_error)?;
            json!({"version":version+1,"draft":draft})
        }
        Request::List => {
            json!({ "version": 0, "records": read_rows(&transaction, Table::Games, None, None)? })
        }
        Request::Read {
            game_id,
            session_id,
            include_history,
        } => {
            let version: Option<i64> = transaction
                .query_row("SELECT version FROM games WHERE id=?1", [&game_id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(db_error)?;
            if let Some(version) = version {
                let mut records = read_rows(&transaction, Table::Games, Some(&game_id), None)?;
                records.extend(read_rows(
                    &transaction,
                    Table::Sessions,
                    Some(&game_id),
                    None,
                )?);
                if session_id.is_some() || include_history {
                    if let Some(session) = session_id.as_deref() {
                        validate_history(&transaction, &game_id, session)?;
                    } else {
                        for row in records.iter().filter(|row| row.table == Table::Sessions) {
                            validate_history(&transaction, &game_id, &row.id)?;
                        }
                    }
                    for table in [
                        Table::Messages,
                        Table::Snapshots,
                        Table::Progress,
                        Table::Transactions,
                        Table::Memories,
                    ] {
                        records.extend(read_rows(
                            &transaction,
                            table,
                            Some(&game_id),
                            session_id.as_deref(),
                        )?);
                    }
                }
                json!({ "version": version, "records": records })
            } else {
                json!({ "version": 0, "records": [] })
            }
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
        Request::Commit {
            game_id,
            version,
            records,
            delete_sessions,
        } => write(
            &transaction,
            &game_id,
            records,
            Some(version),
            &delete_sessions,
        )?,
    };
    transaction.commit().map_err(db_error)?;
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
    snapshot: &Value,
    nodes: &'a std::collections::HashMap<String, Value>,
    mut head: Option<&'a str>,
) -> Result<Value, String> {
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
        if let Some(mapped) = snapshot
            .get("restoredStates")
            .and_then(|states| states.get(node["id"].as_str().unwrap()))
        {
            state = mapped.clone();
        } else {
            for change in node["changes"].as_array().unwrap() {
                apply_recorded_change(&mut state, change)?;
            }
        }
        crate::state_schema::validate_value(&snapshot["schema"], &state, "load")?;
    }
    Ok(state)
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
    if let Some(states) = snapshot.get("restoredStates") {
        let source = snapshot["migrationFrom"]
            .as_str()
            .ok_or("상태 변환 원본이 없어요.")?;
        if source == snapshot["id"].as_str().unwrap_or("")
            || !snapshots.iter().any(|row| row.id == source)
        {
            return Err("상태 변환 원본을 찾을 수 없어요.".into());
        }
        for (id, state) in states.as_object().ok_or("잘못된 상태 변환 기록이에요.")? {
            if !transactions.iter().any(|row| row.id == *id) {
                return Err("상태 변환의 기록을 찾을 수 없어요.".into());
            }
            crate::state_schema::validate_value(&snapshot["schema"], state, "load")?;
        }
    }
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
        if let Some(id) = node["messageId"].as_str() {
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
        restored_state(snapshot, &nodes, Some(id))?;
    }
    let state = restored_state(snapshot, &nodes, progress.value["headId"].as_str())?;
    if !crate::state_schema::equal(&state, &progress.value["state"]) {
        return Err("저장된 상태가 진행 기록과 일치하지 않아요.".into());
    }
    Ok(())
}

fn prune(
    connection: &Connection,
    game_id: &str,
    session_id: &str,
    event_id: &str,
    expected: u64,
) -> Result<Value, String> {
    validate_history(connection, game_id, session_id)?;
    let mut game = read_rows(connection, Table::Games, Some(game_id), None)?
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
    let state = restored_state(snapshot, &nodes, next_head.as_str())?;
    let removed_messages: std::collections::HashSet<_> = transactions
        .iter()
        .filter(|row| removed.contains(&row.id))
        .filter_map(|row| row.value["messageId"].as_str().map(str::to_string))
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
    let mut surviving: Vec<_> = messages
        .into_iter()
        .filter(|row| !removed_messages.contains(&row.id))
        .collect();
    for mut row in snapshots {
        if let Some(states) = row
            .value
            .get_mut("restoredStates")
            .and_then(Value::as_object_mut)
        {
            states.retain(|id, _| !removed.contains(id));
            connection
                .execute(
                    "UPDATE snapshots SET value=?1 WHERE id=?2 AND game_id=?3 AND session_id=?4",
                    params![
                        serde_json::to_string(&row.value).map_err(|_| "잘못된 복원 상태")?,
                        row.id,
                        game_id,
                        session_id
                    ],
                )
                .map_err(db_error)?;
        }
    }
    surviving.sort_by_key(|row| row.value["sequence"].as_u64().unwrap());
    session.value["messageCount"] = json!(surviving.len());
    for (index, row) in surviving.iter_mut().enumerate() {
        row.value["sequence"] = json!(index + 1);
        write_row(connection, row, false)?;
    }
    let now: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })
        .map_err(db_error)?;
    game.value["updatedAt"] = json!(now);
    session.value["updatedAt"] = json!(now);
    progress.value["headId"] = next_head;
    progress.value["state"] = state;
    progress.value["revision"] = json!(expected + 1);
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
    ] {
        records.extend(read_rows(
            connection,
            table,
            Some(game_id),
            Some(session_id),
        )?);
    }
    Ok(json!({"version":version,"records":records}))
}

fn write(
    connection: &Connection,
    game_id: &str,
    mut records: Vec<StoredRecord>,
    version: Option<u64>,
    delete_sessions: &[String],
) -> Result<Value, String> {
    if let Some(version) = version {
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
    for row in &records {
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
) -> Result<Value, String> {
    if window.label() != "main" || token != access.token {
        return Err("허용하지 않는 저장 요청이에요.".into());
    }
    let path = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || execute_request(&path, request))
        .await
        .map_err(|_| "게임 저장소 작업이 중단되었어요.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
        invalid = ui.clone();
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
    fn row(table: &str, id: &str, session_id: Option<&str>, value: Value) -> Value {
        json!({ "table": table, "id": id, "gameId": "game", "sessionId": session_id, "value": value })
    }
    fn session(id: &str) -> Value {
        json!({ "schemaVersion": 1, "id": id, "gameId": "game", "title": "세션", "messageCount": 0, "createdAt": "2026-11-02T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z" })
    }
    fn create() -> Value {
        json!({ "kind": "create", "gameId": "game", "records": [row("games", "game", None, game("게임 🧪")), row("sessions", "session", Some("session"), session("session"))] })
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
        let draft = json!({"version":2,"gameId":"game","baseContent":game("Original"),"documents":{"info":"{}","instructions":"{}","state":text,"scripts":"{}","ui":"null","lorebook":"{}","assets":"{}"}});
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
    fn commit(version: u64, records: Vec<Value>) -> Value {
        json!({ "kind": "commit", "gameId": "game", "version": version, "records": records, "deleteSessions": [] })
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
            row("sessions", "session", Some("session"), current_session),
            row("snapshots", "snapshot", Some("session"), snapshot),
            row("progress", "session", Some("session"), progress),
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
            records.push(row("transactions",name,Some("session"),json!({"schemaVersion":2,"id":name,"gameId":"game","sessionId":"session","parentId":parent,"createdAt":now,"createdRevision":index+1,"action":{"name":name,"args":{}},"description":format!("Event {name}"),"changes":[{"path":["gold"],"before":{"exists":true,"value":before},"after":{"exists":true,"value":after}}],"messageId":message_id})));
            records.push(row("messages",&message_id,Some("session"),json!({"schemaVersion":1,"id":message_id,"gameId":"game","sessionId":"session","sequence":index+1,"role":"assistant","kind":"dialogue","content":name,"createdAt":now})));
            let memory_id = format!("memory-{name}");
            records.push(row("memories",&memory_id,Some("session"),json!({"schemaVersion":1,"id":memory_id,"gameId":"game","sessionId":"session","sourceTransactionIds":[name],"content":name,"createdAt":now})));
        }
        fixture.request(commit(0, records)).unwrap();
        fixture
    }
    fn prune_request(event: &str, revision: u64) -> Value {
        json!({"kind":"prune","gameId":"game","sessionId":"session","eventId":event,"expectedRevision":revision})
    }
    #[test]
    fn applies_migrated_checkpoints_without_rewriting_events_and_prunes_their_owned_data() {
        let fixture = branched_fixture();
        let before = fixture.read();
        let rows = before["records"].as_array().unwrap();
        let original =
            rows.iter().find(|row| row["table"] == "snapshots").unwrap()["value"].clone();
        let mut snapshot = original.clone();
        snapshot["id"] = json!("updated-content");
        snapshot["schema"] = json!({"type":"object","properties":{"gold":{"type":"string"},"score":{"type":"integer"}},"required":["gold","score"],"additionalProperties":false});
        snapshot["initialState"] = json!({"gold":"100","score":0});
        snapshot["migrationFrom"] = json!("snapshot");
        snapshot["restoredStates"] = json!({});
        for (id, gold) in [
            ("A", "90"),
            ("B", "80"),
            ("C", "70"),
            ("D", "60"),
            ("E", "50"),
            ("F", "40"),
        ] {
            snapshot["restoredStates"][id] = json!({"gold":gold,"score":0});
        }
        let mut progress =
            rows.iter().find(|row| row["table"] == "progress").unwrap()["value"].clone();
        progress["snapshotId"] = json!("updated-content");
        progress["revision"] = json!(7);
        progress["state"] = json!({"gold":"40","score":0});
        fixture
            .request(commit(
                1,
                vec![
                    row("snapshots", "updated-content", Some("session"), snapshot),
                    row("progress", "session", Some("session"), progress),
                ],
            ))
            .unwrap();
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
        for snapshot in saved.iter().filter(|row| row["table"] == "snapshots") {
            assert!(snapshot["value"]["restoredStates"].get("F").is_none());
        }
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
                vec![
                    row("snapshots", "snapshot", Some("session"), snapshot),
                    row("progress", "session", Some("session"), progress.clone()),
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
                        vec![
                            row("games", "game", None, game("changed")),
                            row("progress", "session", Some("session"), bad)
                        ]
                    ))
                    .is_err()
            );
            assert_eq!(fixture.read(), before);
        }
        let event = json!({"schemaVersion":2,"id":"inactive","gameId":"game","sessionId":"session","parentId":null,"createdAt":now,"createdRevision":1,"action":{"name":"invalid","args":{}},"changes":[{"path":["hp"],"before":{"exists":true,"value":100},"after":{"exists":true,"value":"bad"}}]});
        let mut unchanged = progress.clone();
        unchanged["revision"] = json!(1);
        assert!(
            fixture
                .request(commit(
                    1,
                    vec![
                        row("progress", "session", Some("session"), unchanged),
                        row("transactions", "inactive", Some("session"), event)
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
                vec![
                    row("sessions", "session", Some("session"), current_session),
                    row("snapshots", "snapshot", Some("session"), snapshot),
                    row("messages", "message", Some("session"), message),
                    row("progress", "session", Some("session"), progress),
                    row("transactions", "event", Some("session"), event),
                    row("memories", "memory", Some("session"), memory),
                ],
            ))
            .unwrap();
        let saved = fixture.read();
        assert_eq!(saved["records"].as_array().unwrap().len(), 7);
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
            vec![
                row("games", "game", None, new_game),
                row(
                    "sessions",
                    "replacement",
                    Some("replacement"),
                    session("replacement"),
                ),
            ],
        );
        request["deleteSessions"] = json!(["session"]);
        fixture.request(request).unwrap();
        assert_eq!(fixture.read()["records"].as_array().unwrap().len(), 2);
        let connection = open(&fixture.0).unwrap();
        for table in [
            "messages",
            "progress",
            "snapshots",
            "transactions",
            "memories",
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
                    vec![
                        row("games", "game", None, game("changed")),
                        row("messages", "message", Some("foreign"), message)
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
            .request(commit(0, vec![row("games", "game", None, game("new"))]))
            .unwrap();
        assert_eq!(fixture.request(commit(0, vec![])).unwrap_err(), CONFLICT);
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
                .request(commit(0, vec![row("games", "game", None, bad)]))
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
                        commit(0, vec![row("games", "game", None, game(title))]),
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
