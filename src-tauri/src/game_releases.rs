//! Immutable portable releases, separate from runtime snapshots and installation/session revisions.
use base64::Engine;
use ring::digest::{SHA256, digest};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const SCHEMA: &str = include_str!("../../src/lib/storage/game-releases.sql");
const ERROR: &str = "Invalid game release";
const LIMIT: usize = 10_000;

fn db_error(_: rusqlite::Error) -> String {
    "Game release storage unavailable".into()
}
fn uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ERROR)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| match i {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => b"89abAB".contains(&byte),
            _ => byte.is_ascii_hexdigit(),
        })
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn initialize(connection: &mut Connection) -> Result<(), String> {
    connection.execute_batch(SCHEMA).map_err(db_error)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let rows: Vec<(String, String)> = {
        let mut query = tx
            .prepare(
                "SELECT id,value FROM games WHERE json_extract(value,'$.originalGameId') IS NULL",
            )
            .map_err(db_error)?;
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?
            .collect::<Result<_, _>>()
            .map_err(db_error)?
    };
    for (id, raw) in rows {
        let mut game: Value = serde_json::from_str(&raw).map_err(|_| ERROR)?;
        game["originalGameId"] = json!(uuid()?);
        tx.execute(
            "UPDATE games SET value=?1,version=version+1 WHERE id=?2",
            params![game.to_string(), id],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}
pub(super) fn preserve_identity(
    connection: &Connection,
    id: &str,
    value: &Value,
) -> Result<Value, String> {
    let saved: Option<String> = connection
        .query_row(
            "SELECT json_extract(value,'$.originalGameId') FROM games WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .flatten();
    let incoming = value
        .get("originalGameId")
        .map(|v| v.as_str().filter(|id| valid_uuid(id)).ok_or(ERROR))
        .transpose()?;
    if saved.as_deref().zip(incoming).is_some_and(|(a, b)| a != b) {
        return Err("Original game identity is immutable".into());
    }
    let origin = match saved {
        Some(id) => id,
        None => incoming.map(str::to_owned).map(Ok).unwrap_or_else(uuid)?,
    };
    if !valid_uuid(&origin) {
        return Err(ERROR.into());
    }
    let mut game = value.clone();
    game["originalGameId"] = json!(origin);
    Ok(game)
}

fn numeric(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| b.is_ascii_digit())
        && (value.len() == 1 || !value.starts_with('0'))
}
fn identifiers(value: &str, prerelease: bool) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && (!prerelease || !part.bytes().all(|b| b.is_ascii_digit()) || numeric(part))
    })
}
fn semver(value: &str) -> bool {
    if value.len() > 256 {
        return false;
    }
    let (version, build) = value
        .split_once('+')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    let (core, pre) = version
        .split_once('-')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    let components: Vec<_> = core.split('.').collect();
    components.len() == 3
        && components.iter().all(|part| numeric(part))
        && build.is_none_or(|part| identifiers(part, false))
        && pre.is_none_or(|part| identifiers(part, true))
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Read {
        #[serde(rename = "kind")]
        _kind: String,
        game_id: String,
    },
    GetRelease {
        #[serde(rename = "kind")]
        _kind: String,
        game_id: String,
        release_id: String,
    },
    Release {
        #[serde(rename = "kind")]
        _kind: String,
        game_id: String,
        content_version: String,
        #[serde(default)]
        ignore_conflict: bool,
        expected_content_hash: Option<String>,
    },
}

fn pick(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).to_owned(), v.clone())))
            .collect(),
    )
}
fn source_modules(value: &Value, ui: bool) -> Result<Value, String> {
    let mut result = Map::new();
    for (id, script) in value.as_object().ok_or(ERROR)? {
        let mut language = script["language"].as_str().ok_or(ERROR)?;
        if ui {
            language = if language == "jsx" || language == "tsx" {
                "tsx"
            } else {
                "typescript"
            };
        } else if language == "js" || language == "javascript" {
            language = "typescript";
        }
        result.insert(
            id.clone(),
            json!({"language":language,"source":script["source"].as_str().ok_or(ERROR)?}),
        );
    }
    Ok(Value::Object(result))
}
fn portable_assets(connection: &Connection, game: &Value) -> Result<Value, String> {
    let mut result = Map::new();
    let empty = Map::new();
    for (id, asset) in game
        .get("resources")
        .map(|v| v.as_object().ok_or(ERROR))
        .transpose()?
        .unwrap_or(&empty)
    {
        let mime = asset["mime"].as_str().ok_or(ERROR)?;
        let raw = asset["data"].as_str().ok_or(ERROR)?;
        let data = if let Some(hash) = raw.strip_prefix("helia-asset:") {
            if !valid_hash(hash) {
                return Err(ERROR.into());
            }
            connection
                .query_row(
                    "SELECT json_extract(value,'$.data') FROM blobs WHERE game_id=?1 AND id=?2",
                    params![game["id"].as_str().ok_or(ERROR)?, hash],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db_error)?
        } else {
            raw.to_owned()
        };
        let prefix = format!("data:{mime};base64,");
        let encoded = data.strip_prefix(&prefix).ok_or(ERROR)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| ERROR)?;
        result.insert(id.clone(),json!({"name":asset["name"],"mime":mime,"data":format!("{prefix}{}",base64::engine::general_purpose::STANDARD.encode(bytes))}));
    }
    let assets = Value::Object(result);
    if !super::resources(Some(&assets)) {
        return Err(ERROR.into());
    }
    Ok(assets)
}

fn text(value: Option<&Value>, fallback: &str) -> Result<Value, String> {
    let value = value
        .map(|v| v.as_str().ok_or(ERROR))
        .transpose()?
        .unwrap_or(fallback);
    if value.encode_utf16().count() > 512 * 1024 {
        return Err(ERROR.into());
    }
    Ok(json!(value))
}
fn boolean(value: Option<&Value>, fallback: bool) -> Result<Value, String> {
    Ok(json!(
        value
            .map(|v| v.as_bool().ok_or(ERROR))
            .transpose()?
            .unwrap_or(fallback)
    ))
}
fn lore_entry(value: &Value, index: usize) -> Result<Value, String> {
    let keys = value["keys"]
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or(ERROR)?;
    let keys: Vec<Value> = keys
        .iter()
        .map(|key| text(Some(key), ""))
        .collect::<Result<_, _>>()?;
    let order = value
        .get("order")
        .map(|v| v.as_u64().filter(|n| *n <= 1_000_000).ok_or(ERROR))
        .transpose()?
        .unwrap_or(index as u64);
    let mut row = json!({"id":text(value.get("id"),&format!("lore-{}",index+1))?,"name":text(value.get("name"),&format!("로어 {}",index+1))?,
        "keys":keys,"content":text(value.get("content"),"")?,"order":order,
        "always":boolean(value.get("always"),false)?,"enabled":boolean(value.get("enabled"),true)?,"caseSensitive":boolean(value.get("caseSensitive"),false)?});
    if let Some(folder) = value.get("folder") {
        row["folder"] = text(Some(folder), "")?;
    }
    Ok(row)
}
fn ai_content(value: &Value) -> Result<Value, String> {
    if !value.is_object() || value.get("version").is_some_and(|v| v != 1) {
        return Err(ERROR.into());
    }
    let empty = vec![];
    let lore = value
        .get("lorebook")
        .map(|v| v.as_array().filter(|v| v.len() <= 1024).ok_or(ERROR))
        .transpose()?
        .unwrap_or(&empty);
    let lore: Vec<Value> = lore
        .iter()
        .enumerate()
        .map(|(i, v)| lore_entry(v, i))
        .collect::<Result<_, _>>()?;
    let mut result = json!({"version":1,"lorebook":lore});
    if let Some(folders) = value.get("folders") {
        let folders = folders.as_array().filter(|v| v.len() <= 128).ok_or(ERROR)?;
        let mut names = vec![];
        for folder in folders {
            let name = folder.as_str().ok_or(ERROR)?.trim();
            if name.is_empty() || name.encode_utf16().count() > 80 {
                return Err(ERROR.into());
            }
            if !names.contains(&name) {
                names.push(name);
            }
        }
        result["folders"] = json!(names);
    }
    Ok(result)
}
fn regex_rules(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else {
        return Ok(json!([]));
    };
    let rules = value.as_array().filter(|v| v.len() <= 100).ok_or(ERROR)?;
    let mut result = vec![];
    let mut ids = std::collections::HashSet::new();
    for rule in rules {
        for key in ["id", "name", "pattern", "replacement", "flags"] {
            if !rule[key]
                .as_str()
                .is_some_and(|v| v.encode_utf16().count() <= 256 * 1024)
            {
                return Err(ERROR.into());
            }
        }
        let id = rule["id"].as_str().ok_or(ERROR)?;
        if id.trim().is_empty()
            || !ids.insert(id)
            || !rule["enabled"].is_boolean()
            || !matches!(
                rule["stage"].as_str(),
                Some("input" | "output" | "request" | "display")
            )
        {
            return Err(ERROR.into());
        }
        let roles = rule["roles"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or(ERROR)?;
        let mut normalized = vec![];
        for role in roles {
            if !matches!(role.as_str(), Some("user" | "assistant")) {
                return Err(ERROR.into());
            }
            if !normalized.contains(role) {
                normalized.push(role.clone());
            }
        }
        let mut row = pick(
            rule,
            &[
                "id",
                "name",
                "enabled",
                "stage",
                "pattern",
                "replacement",
                "flags",
            ],
        );
        row["roles"] = json!(normalized);
        result.push(row);
    }
    Ok(json!(result))
}

fn typed_path(path: &str) -> String {
    if let Some(base) = path.strip_suffix(".jsx") {
        return format!("{base}.tsx");
    }
    if let Some(base) = path.strip_suffix(".js") {
        return format!("{base}.ts");
    }
    path.to_owned()
}
fn normalize_layout(layout: &Value) -> Result<Value, String> {
    if layout["kind"] == "panel" {
        return Ok(pick(layout, &["kind", "id"]));
    }
    let mut result = pick(layout, &["kind", "axis", "ratio"]);
    result["first"] = normalize_layout(&layout["first"])?;
    result["second"] = normalize_layout(&layout["second"])?;
    Ok(result)
}
fn normalize_presentation(value: &mut Value) -> Result<(), String> {
    if let Some(layout) = value.get("layout") {
        value["layout"] = normalize_layout(layout)?;
    }
    Ok(())
}
// Match the existing TS legacy import retargeter without introducing a regex dependency.
fn import_quote(source: &str, start: usize) -> Option<usize> {
    let previous = source[..start].chars().next_back();
    if previous.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let tail = &source[start..];
    let offset = if tail.starts_with("from") {
        4
    } else if tail.starts_with("import") {
        6
    } else {
        return None;
    };
    let rest = &tail[offset..];
    let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let rest = if offset == 6 {
        rest.strip_prefix('(')?
            .trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
    } else {
        rest
    };
    rest.starts_with(['\'', '"'])
        .then_some(source.len() - rest.len())
}
fn retarget_imports(source: &str) -> String {
    let mut result = String::new();
    let mut copied = 0;
    for (start, _) in source.char_indices() {
        if start < copied {
            continue;
        }
        let Some(quote) = import_quote(source, start) else {
            continue;
        };
        let path_start = quote + 1;
        let Some(end) = source[path_start..]
            .find(['\'', '"'])
            .map(|i| i + path_start)
        else {
            continue;
        };
        if source.as_bytes()[quote] != source.as_bytes()[end] {
            continue;
        }
        let path = &source[path_start..end];
        if !path.starts_with("./") && !path.starts_with("../") {
            continue;
        }
        let Some(path) = path
            .strip_suffix(".jsx")
            .or_else(|| path.strip_suffix(".js"))
        else {
            continue;
        };
        result.push_str(&source[copied..path_start]);
        result.push_str(path);
        result.push(source.as_bytes()[quote] as char);
        copied = end + 1;
    }
    result.push_str(&source[copied..]);
    result
}
fn normalize_code(code: &Value) -> Result<Value, String> {
    let mut files = Map::new();
    for (path, file) in code["files"].as_object().ok_or(ERROR)? {
        let target = typed_path(path);
        if files.contains_key(&target) {
            return Err(ERROR.into());
        }
        let language = file["language"].as_str().ok_or(ERROR)?;
        let language = match language {
            "jsx" | "tsx" => "tsx",
            "css" => "css",
            _ => "typescript",
        };
        let source = file["source"].as_str().ok_or(ERROR)?;
        let source = if language == "css" {
            source.to_owned()
        } else {
            retarget_imports(source)
        };
        files.insert(target, json!({"language":language,"source":source}));
    }
    let entry = typed_path(code["entry"].as_str().ok_or(ERROR)?);
    if !files.contains_key(&entry) {
        return Err(ERROR.into());
    }
    let mut result = json!({"version":1,"entry":entry,"files":files});
    if let Some(folders) = code.get("folders") {
        let mut unique = vec![];
        for folder in folders.as_array().ok_or(ERROR)? {
            if !unique.contains(folder) {
                unique.push(folder.clone());
            }
        }
        result["folders"] = json!(unique);
    }
    if let Some(presentation) = code.get("presentation") {
        let mut presentation = pick(
            presentation,
            &["layout", "chatDock", "chatRatio", "chatStyle"],
        );
        normalize_presentation(&mut presentation)?;
        result["presentation"] = presentation;
    }
    Ok(result)
}

fn content(connection: &Connection, game: &Value) -> Result<Value, String> {
    crate::state_schema::validate_document(game)?;
    let mut checked = game.clone();
    checked["resources"] = portable_assets(connection, game)?;
    if !super::valid_value(super::Table::Games, &checked) {
        return Err(ERROR.into());
    }
    let mut result = pick(
        game,
        &[
            "title",
            "genre",
            "description",
            "settings",
            "schema",
            "initialState",
        ],
    );
    for key in ["title", "genre", "description"] {
        result[key] = json!(game[key].as_str().ok_or(ERROR)?.trim());
    }
    result["settings"] = pick(
        &game["settings"],
        &["description", "firstMessage", "authorNote"],
    );
    result["regex"] = regex_rules(game.get("regex"))?;
    result["resources"] = checked["resources"].clone();
    if let Some(ai) = game.get("ai") {
        result["ai"] = ai_content(ai)?;
    }
    if let Some(code) = game.get("code") {
        result["code"] = normalize_code(code)?;
    } else {
        result["scripts"] = source_modules(&game["scripts"], false)?;
        if let Some(ui) = game.get("ui") {
            let mut ui = pick(
                ui,
                &[
                    "version",
                    "entry",
                    "modules",
                    "styles",
                    "layout",
                    "chatDock",
                    "chatRatio",
                    "chatStyle",
                ],
            );
            ui["modules"] = source_modules(&ui["modules"], true)?;
            normalize_presentation(&mut ui)?;
            result["ui"] = ui;
        }
    }
    bound_content(&result, 0, &mut (0, 0))?;
    Ok(result)
}

fn bound_content(value: &Value, depth: usize, budget: &mut (usize, usize)) -> Result<(), String> {
    budget.0 += 1;
    if let Value::String(v) = value {
        budget.1 += v.encode_utf16().count();
    }
    if depth > 64 || budget.0 > 100_000 || budget.1 > 16 * 1024 * 1024 {
        return Err("Release content limit exceeded".into());
    }
    match value {
        Value::Array(values) => {
            for v in values {
                bound_content(v, depth + 1, budget)?;
            }
        }
        Value::Object(values) => {
            for v in values.values() {
                bound_content(v, depth + 1, budget)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Same typed canonical tree as TypeScript, independent of serde/JS number formatting.
fn canonical(value: &Value) -> Result<Value, String> {
    Ok(match value {
        Value::Null => json!(["null"]),
        Value::Bool(v) => json!(["boolean", v]),
        Value::String(v) => json!(["string", v]),
        Value::Number(v) => {
            let number = v.as_f64().filter(|n| n.is_finite()).ok_or(ERROR)?;
            let bits = if number == 0.0 {
                0.0f64.to_bits()
            } else {
                number.to_bits()
            };
            json!(["number", format!("{bits:016x}")])
        }
        Value::Array(values) => json!([
            "array",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
        ]),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            let rows: Vec<Value> = entries
                .iter()
                .map(|(k, v)| Ok(json!([k, canonical(v)?])))
                .collect::<Result<_, String>>()?;
            json!(["object", rows])
        }
    })
}
fn content_hash(content: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(&canonical(content)?).map_err(|_| ERROR)?;
    Ok(digest(&SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn summaries(connection: &Connection, game_id: &str) -> Result<Vec<Value>, String> {
    let mut query=connection.prepare("SELECT id,original_game_id,content_version,content_hash,created_at FROM game_releases WHERE game_id=?1 ORDER BY rowid").map_err(db_error)?;
    let releases=query.query_map([game_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"originalGameId":r.get::<_,String>(1)?,"contentVersion":r.get::<_,String>(2)?,"contentHash":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?}))).map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    if releases.len() > LIMIT {
        return Err("Release history limit exceeded".into());
    }
    Ok(releases)
}
fn state(connection: &Connection, game: &Value, hash: &str) -> Result<Value, String> {
    let releases = summaries(connection, game["id"].as_str().ok_or(ERROR)?)?;
    let selected: Option<String> = connection
        .query_row(
            "SELECT release_id FROM game_release_selection WHERE game_id=?1",
            [game["id"].as_str().ok_or(ERROR)?],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let current = releases
        .iter()
        .find(|r| r["id"].as_str() == selected.as_deref());
    Ok(
        json!({"originalGameId":game["originalGameId"],"contentHash":hash,"currentRelease":current,"releases":releases,"modified":current.is_some_and(|r|r["contentHash"]!=hash)}),
    )
}
fn get_release(connection: &Connection, game_id: &str, release_id: &str) -> Result<Value, String> {
    if !valid_uuid(release_id) {
        return Err(ERROR.into());
    }
    let mut summary = summaries(connection, game_id)?
        .into_iter()
        .find(|r| r["id"] == release_id)
        .ok_or("Game release not found")?;
    let raw: String = connection
        .query_row(
            "SELECT content FROM game_releases WHERE game_id=?1 AND id=?2",
            params![game_id, release_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    summary["content"] = serde_json::from_str(&raw).map_err(|_| ERROR)?;
    Ok(summary)
}
fn finalize(
    connection: &Connection,
    game: &Value,
    version: &str,
    ignore: bool,
    expected: Option<&str>,
) -> Result<Value, String> {
    if !semver(version)
        || expected.is_some_and(|v| !valid_hash(v))
        || (ignore && expected.is_none())
    {
        return Err(ERROR.into());
    }
    if game.get("trashedAt").is_some_and(|v| !v.is_null()) {
        return Err("Cannot release a trashed game".into());
    }
    let content = content(connection, game)?;
    let hash = content_hash(&content)?;
    if expected.is_some_and(|value| value != hash) {
        return Err(super::CONFLICT.into());
    }
    let game_id = game["id"].as_str().ok_or(ERROR)?;
    let releases = summaries(connection, game_id)?;
    let existing = releases
        .iter()
        .find(|r| r["contentVersion"] == version && r["contentHash"] == hash);
    if existing.is_none() {
        let mut query=connection.prepare("SELECT DISTINCT content_hash FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.original_game_id=?1 AND r.content_version=?2 AND json_extract(g.value,'$.trashedAt') IS NULL AND r.content_hash<>?3 ORDER BY content_hash").map_err(db_error)?;
        let hashes = query
            .query_map(
                params![game["originalGameId"].as_str().ok_or(ERROR)?, version, hash],
                |r| r.get::<_, String>(0),
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        if hashes.len() > LIMIT {
            return Err("Release conflict limit exceeded".into());
        }
        if !hashes.is_empty() && !ignore {
            return Ok(
                json!({"kind":"conflict","contentVersion":version,"existingHashes":hashes,"incomingHash":hash}),
            );
        }
        if releases.len() >= LIMIT {
            return Err("Release history limit exceeded".into());
        }
    }
    let id = match existing {
        Some(row) => row["id"].as_str().ok_or(ERROR)?.to_owned(),
        None => uuid()?,
    };
    if existing.is_none() {
        let now = time::OffsetDateTime::now_utc();
        let created = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            now.year(),
            now.month() as u8,
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond()
        );
        connection.execute("INSERT INTO game_releases(id,game_id,original_game_id,content_version,content_hash,created_at,content) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,game_id,game["originalGameId"].as_str().ok_or(ERROR)?,version,hash,created,content.to_string()]).map_err(db_error)?;
    }
    connection.execute("INSERT INTO game_release_selection(game_id,release_id) VALUES(?1,?2) ON CONFLICT(game_id) DO UPDATE SET release_id=excluded.release_id",params![game_id,id]).map_err(db_error)?;
    Ok(json!({"kind":"released","state":state(connection,game,&hash)?}))
}
pub(super) fn request(connection: &mut Connection, input: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(input).map_err(|_| ERROR)?;
    let game_id = match &request {
        Request::Read { game_id, .. }
        | Request::GetRelease { game_id, .. }
        | Request::Release { game_id, .. } => game_id,
    };
    if game_id.trim().is_empty() {
        return Err(ERROR.into());
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (raw, version): (String, i64) = tx
        .query_row(
            "SELECT value,version FROM games WHERE id=?1",
            [game_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    if !(0..=9_007_199_254_740_991).contains(&version) {
        return Err(ERROR.into());
    }
    let mut reply = json!({"version":version,"records":[]});
    if let Request::GetRelease { release_id, .. } = &request {
        reply["release"] = get_release(&tx, game_id, release_id)?;
    } else {
        let game: Value = serde_json::from_str(&raw).map_err(|_| ERROR)?;
        if !game["originalGameId"].as_str().is_some_and(valid_uuid) {
            return Err(ERROR.into());
        }
        match &request {
            Request::Read { .. } => {
                reply["versioning"] = state(&tx, &game, &content_hash(&content(&tx, &game)?)?)?
            }
            Request::Release {
                content_version,
                ignore_conflict,
                expected_content_hash,
                ..
            } => {
                reply["releaseResult"] = finalize(
                    &tx,
                    &game,
                    content_version,
                    *ignore_conflict,
                    expected_content_hash.as_deref(),
                )?
            }
            Request::GetRelease { .. } => unreachable!(),
        }
    }
    tx.commit().map_err(db_error)?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../src/lib/testing/fixtures/game-releases.json"
        ))
        .unwrap()
    }
    fn connection() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        db.execute_batch(super::super::MIGRATION).unwrap();
        initialize(&mut db).unwrap();
        db
    }
    fn install(db: &Connection, id: &str) -> Value {
        let mut game = fixtures()[0]["game"].clone();
        game["id"] = json!(id);
        game["activeSessionId"] = json!(format!("session-{id}"));
        let session = json!({"schemaVersion":1,"id":game["activeSessionId"],"gameId":id,"title":"Session","messageCount":0,"createdAt":game["createdAt"],"updatedAt":game["updatedAt"]});
        db.execute(
            "INSERT INTO games(id,value) VALUES(?1,?2)",
            params![id, game.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions(id,game_id,value) VALUES(?1,?2,?3)",
            params![session["id"].as_str().unwrap(), id, session.to_string()],
        )
        .unwrap();
        game
    }
    fn save(db: &Connection, game: &Value) {
        db.execute(
            "UPDATE games SET value=?1 WHERE id=?2",
            params![game.to_string(), game["id"].as_str().unwrap()],
        )
        .unwrap();
    }
    fn read(db: &mut Connection, id: &str) -> Value {
        request(db, json!({"kind":"versioning","action":"read","gameId":id})).unwrap()["versioning"]
            .clone()
    }
    fn release(db: &mut Connection, id: &str, version: &str) -> Value {
        request(
            db,
            json!({"kind":"versioning","action":"release","gameId":id,"contentVersion":version}),
        )
        .unwrap()["releaseResult"]
            .clone()
    }

    #[test]
    fn strict_semver_syntax_never_accepts_invalid_override_versions() {
        for version in [
            "0.0.0",
            "1.2.3-alpha.0.9-z+build.01",
            "999999999999999999.0.0",
            "1.0.0+001",
        ] {
            assert!(semver(version), "{version}");
        }
        for version in [
            "1",
            "1.2",
            "v1.2.3",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.0.0-01",
            "1.0.0-",
            "1.0.0+",
            "1.0.0-a..b",
            "1.0.0+a+b",
            "1.0.0\n",
            " 1.0.0",
            "1.0.0-한글",
        ] {
            assert!(!semver(version), "{version}");
        }
        let mut db = connection();
        install(&db, "one");
        let hash = read(&mut db, "one")["contentHash"].clone();
        assert!(request(&mut db,json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"01.0.0","ignoreConflict":true,"expectedContentHash":hash})).is_err());
        assert!(
            read(&mut db, "one")["releases"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn matches_typescript_digest_and_portable_content_fixtures() {
        let db = connection();
        for fixture in fixtures() {
            let frozen = content(&db, &fixture["game"]).unwrap();
            assert_eq!(frozen, fixture["content"], "{}", fixture["name"]);
            assert_eq!(
                content_hash(&frozen).unwrap(),
                fixture["hash"].as_str().unwrap(),
                "{}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn digest_ignores_runtime_identity_and_caches_but_resolves_actual_media() {
        let db = connection();
        let mut game = fixtures()[0]["game"].clone();
        let baseline = content_hash(&content(&db, &game).unwrap()).unwrap();
        game["id"] = json!("another-installation");
        game["activeSessionId"] = json!("another-session");
        game["updatedAt"] = json!("2026-11-24T00:00:00Z");
        game["originalGameId"] = json!(uuid().unwrap());
        game["scripts"]["rules"]["compiled"] = json!("changed compiled output");
        game["ui"]["compiled"]["factories"] = json!("new factories");
        game["initialState"]["😀"] = json!(-0.0);
        assert_eq!(
            content_hash(&content(&db, &game).unwrap()).unwrap(),
            baseline
        );
        game["id"] = json!("one");
        install(&db, "one");
        let reference = "a".repeat(64);
        let data = game["resources"]["portrait"]["data"].clone();
        let blob =
            json!({"schemaVersion":1,"id":reference,"gameId":"one","mime":"image/png","data":data});
        db.execute(
            "INSERT INTO blobs(id,game_id,value) VALUES(?1,'one',?2)",
            params![reference, blob.to_string()],
        )
        .unwrap();
        game["resources"]["portrait"]["data"] = json!(format!("helia-asset:{reference}"));
        assert_eq!(
            content_hash(&content(&db, &game).unwrap()).unwrap(),
            baseline
        );
        db.execute("UPDATE blobs SET value=json_set(value,'$.data','data:image/png;base64,AA==') WHERE id=?1",[reference]).unwrap();
        assert_ne!(
            content_hash(&content(&db, &game).unwrap()).unwrap(),
            baseline
        );
    }

    #[test]
    fn freezes_releases_selects_explicit_versions_and_keeps_old_media_after_restart() {
        let path = std::env::temp_dir().join(format!("helia-releases-{}.sqlite", uuid().unwrap()));
        let mut db = super::super::open(&path).unwrap();
        let mut game = install(&db, "one");
        assert_eq!(read(&mut db, "one")["currentRelease"], Value::Null);
        let first = release(&mut db, "one", "9.0.0")["state"]["currentRelease"].clone();
        let frozen = get_release(&db, "one", first["id"].as_str().unwrap()).unwrap();
        game["title"] = json!("Changed working game");
        game["resources"] = json!({});
        save(&db, &game);
        assert_eq!(read(&mut db, "one")["modified"], true);
        let second = release(&mut db, "one", "1.0.0")["state"]["currentRelease"].clone();
        assert_eq!(second["contentVersion"], "1.0.0");
        assert_eq!(read(&mut db, "one")["modified"], false);
        assert!(
            db.execute(
                "UPDATE game_releases SET content_hash='bad' WHERE id=?1",
                [first["id"].as_str().unwrap()]
            )
            .is_err()
        );
        drop(db);
        let mut db = super::super::open(&path).unwrap();
        assert_eq!(read(&mut db, "one")["currentRelease"], second);
        assert_eq!(
            get_release(&db, "one", first["id"].as_str().unwrap()).unwrap(),
            frozen
        );
        assert_eq!(
            frozen["content"]["resources"]["portrait"]["data"],
            "data:image/png;base64,AAEC/w=="
        );
        let session_count: i64 = db
            .query_row(
                "SELECT count(*) FROM sessions WHERE game_id='one'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(session_count, 1);
        // Retrieval has no dependency on the validity/digest of current working content.
        game["settings"] = Value::Null;
        save(&db, &game);
        let fetched=super::super::execute_request(&path,json!({"kind":"versioning","action":"getRelease","gameId":"one","releaseId":first["id"]})).unwrap();
        assert_eq!(fetched["release"], frozen);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn conflicts_are_atomic_pinned_and_idempotent_across_active_installations() {
        let mut db = connection();
        let mut game = install(&db, "one");
        let original = release(&mut db, "one", "1.0.0")["state"]["currentRelease"].clone();
        game["description"] = json!("Different content");
        save(&db, &game);
        let conflict = release(&mut db, "one", "1.0.0");
        assert_eq!(conflict["kind"], "conflict");
        assert_eq!(conflict["existingHashes"], json!([original["contentHash"]]));
        let mut confirm = json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0","ignoreConflict":true});
        assert!(request(&mut db, confirm.clone()).is_err());
        confirm["expectedContentHash"] = conflict["incomingHash"].clone();
        game["description"] = json!("Changed after confirmation");
        save(&db, &game);
        assert_eq!(
            request(&mut db, confirm.clone()).unwrap_err(),
            super::super::CONFLICT
        );
        confirm["expectedContentHash"] = read(&mut db, "one")["contentHash"].clone();
        let overridden = request(&mut db, confirm).unwrap()["releaseResult"].clone();
        assert_eq!(overridden["kind"], "released");
        assert_eq!(release(&mut db, "one", "1.0.0"), overridden);
        assert_eq!(
            read(&mut db, "one")["releases"].as_array().unwrap().len(),
            2
        );
        let mut other = install(&db, "two");
        other["description"] = json!("Third variant");
        save(&db, &other);
        assert_eq!(release(&mut db, "two", "1.0.0")["kind"], "conflict");
        game["trashedAt"] = json!("2026-11-24T00:00:00Z");
        save(&db, &game);
        assert_eq!(release(&mut db, "two", "1.0.0")["kind"], "released");
        assert!(get_release(&db, "two", original["id"].as_str().unwrap()).is_err());
    }

    #[test]
    fn preserves_original_identity_and_additively_initializes_existing_games() {
        let mut db = connection();
        let mut game = install(&db, "one");
        let origin = game["originalGameId"].clone();
        game.as_object_mut().unwrap().remove("originalGameId");
        assert_eq!(
            preserve_identity(&db, "one", &game).unwrap()["originalGameId"],
            origin
        );
        game["originalGameId"] = json!(uuid().unwrap());
        assert!(preserve_identity(&db, "one", &game).is_err());
        game.as_object_mut().unwrap().remove("originalGameId");
        save(&db, &game);
        initialize(&mut db).unwrap();
        let backfilled = read(&mut db, "one")["originalGameId"].clone();
        assert!(valid_uuid(backfilled.as_str().unwrap()));
        assert_ne!(backfilled, "one");
        initialize(&mut db).unwrap();
        assert_eq!(read(&mut db, "one")["originalGameId"], backfilled);
    }
}
