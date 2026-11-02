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
    Read {
        game_id: String,
        session_id: Option<String>,
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
    Ok(connection)
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
    let request: Request =
        serde_json::from_value(input).map_err(|_| "저장 요청의 형식이 올바르지 않아요.")?;
    let mut connection = open(path)?;
    let read = matches!(request, Request::Read { .. } | Request::List);
    let transaction = connection
        .transaction_with_behavior(if read {
            TransactionBehavior::Deferred
        } else {
            TransactionBehavior::Immediate
        })
        .map_err(db_error)?;
    let result = match request {
        Request::List => {
            json!({ "version": 0, "records": read_rows(&transaction, Table::Games, None, None)? })
        }
        Request::Read {
            game_id,
            session_id,
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
                if let Some(session) = session_id {
                    validate_history(&transaction, &game_id, &session)?;
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
                            Some(&session),
                        )?);
                    }
                }
                json!({ "version": version, "records": records })
            } else {
                json!({ "version": 0, "records": [] })
            }
        }
        Request::Create { game_id, records } => write(&transaction, &game_id, records, None, &[])?,
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
        for change in node["changes"].as_array().unwrap() {
            apply_recorded_change(&mut state, change)?;
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
    for id in nodes.keys() {
        restored_state(snapshot, &nodes, Some(id))?;
    }
    let state = restored_state(snapshot, &nodes, progress.value["headId"].as_str())?;
    if !crate::state_schema::equal(&state, &progress.value["state"]) {
        return Err("저장된 상태가 진행 기록과 일치하지 않아요.".into());
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
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
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
    fn commit(version: u64, records: Vec<Value>) -> Value {
        json!({ "kind": "commit", "gameId": "game", "version": version, "records": records, "deleteSessions": [] })
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
                body: tauri::ipc::InvokeBody::Json(json!({ "request": create() })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
        assert_eq!(response["version"], 0);
        assert_eq!(fixture.read()["records"].as_array().unwrap().len(), 2);
    }
}
