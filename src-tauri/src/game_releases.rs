//! Immutable portable releases, separate from runtime snapshots and installation/session revisions.
use base64::Engine;
use ring::digest::{SHA256, digest};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const SCHEMA: &str = include_str!("../../src/lib/storage/game-releases.sql");
const ERROR: &str = "Invalid game release";
const LIMIT: usize = 10_000;

#[path = "game_install.rs"]
pub(super) mod packages;

fn db_error(_: rusqlite::Error) -> String {
    "Game release storage unavailable".into()
}
pub(super) fn uuid() -> Result<String, String> {
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
    // Existing databases need no write lock, including advisory install previews.
    let missing: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM games WHERE json_extract(value,'$.originalGameId') IS NULL)",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    if !missing {
        return Ok(());
    }
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
    let (saved, provenance): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT json_extract(value,'$.originalGameId'),json_extract(value,'$.installedFrom') FROM games WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or_default();
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
    super::edit_lock::preserve(connection, id, &mut game)?;
    game["originalGameId"] = json!(origin);
    if let Some(raw) = provenance {
        game["installedFrom"] = serde_json::from_str(&raw).map_err(|_| ERROR)?;
    } else {
        game.as_object_mut().ok_or(ERROR)?.remove("installedFrom");
    }
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
    VerifyRelease {
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
    let game_id = game["id"].as_str().ok_or(ERROR)?;
    for (id, asset) in game
        .get("resources")
        .map(|v| v.as_object().ok_or(ERROR))
        .transpose()?
        .unwrap_or(&empty)
    {
        let mime = asset["mime"].as_str().ok_or(ERROR)?;
        let raw = asset["data"].as_str().ok_or(ERROR)?;
        let prefix = format!("data:{mime};base64,");
        if let Some(hash) = raw.strip_prefix("helia-asset:") {
            if !valid_hash(hash) {
                return Err(ERROR.into());
            }
            let blob = blob_row(connection, game_id, hash)?;
            if blob["schemaVersion"] == 2 {
                if blob["mime"].as_str() != Some(mime) {
                    return Err(packages::error("mediaType"));
                }
                // v2 media stays a reference; legacy v1 rows resolve to their inline bytes.
                result.insert(
                    id.clone(),
                    json!({"name":asset["name"],"mime":mime,"data":raw}),
                );
                continue;
            }
            let data = blob["data"].as_str().ok_or(ERROR)?;
            let encoded = data.strip_prefix(&prefix).ok_or(ERROR)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| ERROR)?;
            result.insert(id.clone(),json!({"name":asset["name"],"mime":mime,"data":format!("{prefix}{}",base64::engine::general_purpose::STANDARD.encode(bytes))}));
            continue;
        }
        let encoded = raw.strip_prefix(&prefix).ok_or(ERROR)?;
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

/// Read a same-game blob row by id. The WHERE clause scopes ownership to this game;
/// callers that need the JSON identity guard use `owned_blob` instead.
fn blob_row(connection: &Connection, game_id: &str, blob_id: &str) -> Result<Value, String> {
    let text: Option<String> = connection
        .query_row(
            "SELECT value FROM blobs WHERE game_id=?1 AND id=?2",
            params![game_id, blob_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let text = text.ok_or_else(|| packages::error("missingAsset"))?;
    serde_json::from_str(&text).map_err(|_| packages::error("missingAsset"))
}

/// A blob row owned by this exact game; missing or foreign rows are `missingAsset` (§2.4).
pub(super) fn owned_blob(
    connection: &Connection,
    game_id: &str,
    blob_id: &str,
) -> Result<Value, String> {
    let blob = blob_row(connection, game_id, blob_id)?;
    if blob["gameId"].as_str() != Some(game_id) || blob["id"].as_str() != Some(blob_id) {
        return Err(packages::error("missingAsset"));
    }
    Ok(blob)
}

/// Every `helia-asset:` reference must point at a same-game blob with the same MIME.
pub(super) fn assert_owned_resources(
    connection: &Connection,
    game_id: &str,
    resources: Option<&Value>,
) -> Result<(), String> {
    let Some(entries) = resources.and_then(Value::as_object) else {
        return Ok(());
    };
    for asset in entries.values() {
        let Some(hash) = asset["data"]
            .as_str()
            .and_then(|data| data.strip_prefix("helia-asset:"))
        else {
            continue;
        };
        let blob = owned_blob(connection, game_id, hash)?;
        let mime = asset["mime"].as_str().ok_or(ERROR)?;
        if blob["mime"].as_str() != Some(mime) {
            return Err(packages::error("mediaType"));
        }
    }
    Ok(())
}

/// Drafts keep the working asset document as text; it may be unfinished JSON while editing,
/// so its references are only checked when it parses into an object.
pub(super) fn assert_owned_draft_references(
    connection: &Connection,
    game_id: &str,
    draft: &Value,
) -> Result<(), String> {
    assert_owned_resources(connection, game_id, draft["baseContent"].get("resources"))?;
    if let Some(text) = draft["documents"]["assets"].as_str() {
        if let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(text) {
            for asset in entries.values() {
                let Some(hash) = asset["data"]
                    .as_str()
                    .and_then(|data| data.strip_prefix("helia-asset:"))
                else {
                    continue;
                };
                let blob = owned_blob(connection, game_id, hash)?;
                if let Some(mime) = asset["mime"].as_str() {
                    if blob["mime"].as_str() != Some(mime) {
                        return Err(packages::error("mediaType"));
                    }
                }
            }
        }
    }
    Ok(())
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
            let name = js_trim(folder.as_str().ok_or(ERROR)?);
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
/// ECMAScript WhiteSpace + LineTerminator (`\s`, `String.prototype.trim`); unlike
/// `char::is_whitespace` it includes U+FEFF and excludes U+0085.
fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
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
        // Bounded validation first: normalize_layout recurses without a depth limit.
        if !super::panel_layout(layout, 0, &mut std::collections::HashSet::new()) {
            return Err(ERROR.into());
        }
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
    let rest = rest.trim_start_matches(js_whitespace);
    let rest = if offset == 6 {
        rest.strip_prefix('(')?.trim_start_matches(js_whitespace)
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
        // TS `\.{1,2}\/[^'"]+\.jsx?` needs a name before the extension: './.js' stays as is.
        if path == "./" || path == "../" {
            continue;
        }
        result.push_str(&source[copied..path_start]);
        result.push_str(path);
        result.push(source.as_bytes()[quote] as char);
        copied = end + 1;
    }
    result.push_str(&source[copied..]);
    result
}
/// Mirrors TS `parseCodeProject` normalization and limits (code-project.ts `parseFiles`,
/// `stylesheetSize`, `parseFolders`, `parsePresentation`). Sizes are UTF-8 bytes of the raw source.
pub(super) fn normalize_code(code: &Value) -> Result<Value, String> {
    let raw_files = code["files"].as_object().ok_or(ERROR)?;
    if raw_files.len() > 64 {
        return Err(ERROR.into());
    }
    let mut files = Map::new();
    let mut bytes = 0;
    for (path, file) in raw_files {
        let target = typed_path(path);
        if files.contains_key(&target) {
            return Err(ERROR.into());
        }
        let language = match file["language"].as_str().ok_or(ERROR)? {
            "jsx" | "tsx" => "tsx",
            "css" => "css",
            "javascript" | "typescript" => "typescript",
            _ => return Err(ERROR.into()),
        };
        let source = file["source"].as_str().ok_or(ERROR)?;
        bytes += source.len();
        if bytes > 512 * 1024 || (language == "css" && source.len() > 64 * 1024) {
            return Err(ERROR.into());
        }
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
        let folders = folders.as_array().ok_or(ERROR)?;
        if folders.len() > 128 {
            return Err(ERROR.into());
        }
        let mut unique = vec![];
        for folder in folders {
            if !unique.contains(folder) {
                unique.push(folder.clone());
            }
        }
        result["folders"] = json!(unique);
    }
    if let Some(presentation) = code.get("presentation") {
        if presentation
            .as_object()
            .ok_or(ERROR)?
            .keys()
            .any(|key| !["layout", "chatDock", "chatRatio", "chatStyle"].contains(&key.as_str()))
        {
            return Err(ERROR.into());
        }
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
        result[key] = json!(js_trim(game[key].as_str().ok_or(ERROR)?));
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

fn bound_content(value: &Value, depth: usize, budget: &mut (u64, u64)) -> Result<(), String> {
    budget.0 = budget.0.checked_add(1).ok_or(ERROR)?;
    if let Value::String(v) = value {
        budget.1 = budget
            .1
            .checked_add(v.encode_utf16().count() as u64)
            .ok_or(ERROR)?;
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
            for (key, v) in values {
                budget.1 = budget
                    .1
                    .checked_add(key.encode_utf16().count() as u64)
                    .ok_or(ERROR)?;
                if depth == 0 && key == "resources" {
                    validate_resource_format(v)?;
                    continue;
                }
                bound_content(v, depth + 1, budget)?;
            }
        }
        _ => {}
    }
    if budget.1 > 16 * 1024 * 1024 {
        return Err("Release content limit exceeded".into());
    }
    Ok(())
}

fn validate_resource_format(value: &Value) -> Result<(), String> {
    let mut resources = value.clone();
    for resource in resources.as_object_mut().ok_or(ERROR)?.values_mut() {
        if let Some(hash) = resource["data"]
            .as_str()
            .and_then(|v| v.strip_prefix("helia-package:assets/"))
        {
            let reference = format!("helia-asset:{hash}");
            resource["data"] = json!(reference);
        }
    }
    if !super::resources(Some(&resources)) {
        return Err(ERROR.into());
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

fn content_has_references(content: &Value) -> bool {
    content["resources"].as_object().is_some_and(|entries| {
        entries.values().any(|asset| {
            asset["data"]
                .as_str()
                .is_some_and(|data| data.starts_with("helia-asset:"))
        })
    })
}

/// Stream the canonical digest outside any write transaction, under read leases (§2.8, §7.3).
fn stream_release_digest(
    connection: &Connection,
    game_id: &str,
    content: &Value,
) -> Result<String, String> {
    let mut objects: Vec<String> = Vec::new();
    if let Some(entries) = content["resources"].as_object() {
        for asset in entries.values() {
            if let Some(hash) = asset["data"]
                .as_str()
                .and_then(|data| data.strip_prefix("helia-asset:"))
            {
                let media = crate::runtime_content::open_media(connection, game_id, hash)?
                    .ok_or_else(|| packages::error("missingAsset"))?;
                if let Some(object_id) = media.object_id {
                    objects.push(object_id);
                }
            }
        }
    }
    objects.sort();
    objects.dedup();
    let mut leases: Vec<String> = Vec::new();
    for object in &objects {
        let id = uuid()?;
        connection.execute(
            "INSERT INTO media_leases(id,game_id,object_id,kind,expires_at) VALUES(?1,?2,?3,'read',strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes'))",
            params![id, game_id, object],
        ).map_err(db_error)?;
        leases.push(id);
    }
    let result = crate::media_identity::hash_release_content(content, &mut |reference, sink| {
        let hash = reference.strip_prefix("helia-asset:").ok_or(ERROR)?;
        let media = crate::runtime_content::open_media(connection, game_id, hash)?
            .ok_or_else(|| packages::error("missingAsset"))?;
        for chunk in media.read(0, media.size)? {
            sink(&chunk?);
        }
        Ok(())
    });
    for id in &leases {
        let _ = connection.execute("DELETE FROM media_leases WHERE id=?1", [id]);
    }
    result
}

fn release_digest(
    connection: &Connection,
    game: &Value,
    content: &Value,
) -> Result<String, String> {
    if content_has_references(content) {
        stream_release_digest(connection, game["id"].as_str().ok_or(ERROR)?, content)
    } else {
        content_hash(content)
    }
}

/// Host-confirmed {mime, size, sha256} for every reference kept in a stored release.
fn release_assets(
    connection: &Connection,
    game_id: &str,
    content: &Value,
) -> Result<Option<Value>, String> {
    let mut references: Vec<String> = Vec::new();
    if let Some(entries) = content["resources"].as_object() {
        for asset in entries.values() {
            if let Some(hash) = asset["data"]
                .as_str()
                .and_then(|data| data.strip_prefix("helia-asset:"))
            {
                references.push(hash.to_owned());
            }
        }
    }
    references.sort();
    references.dedup();
    if references.is_empty() {
        return Ok(None);
    }
    let mut assets = Map::new();
    for blob_id in references {
        let blob = owned_blob(connection, game_id, &blob_id)?;
        if blob["schemaVersion"] != 2 {
            return Err(packages::error("missingAsset"));
        }
        assets.insert(
            blob_id,
            json!({"mime":blob["mime"],"size":blob["size"],"sha256":blob["object"]}),
        );
    }
    Ok(Some(Value::Object(assets)))
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
    Ok(state_from_history(
        game,
        hash,
        releases,
        selected.as_deref(),
    ))
}
fn state_from_history(
    game: &Value,
    hash: &str,
    releases: Vec<Value>,
    selected: Option<&str>,
) -> Value {
    let current = releases.iter().find(|r| r["id"].as_str() == selected);
    json!({"originalGameId":game["originalGameId"],"contentHash":hash,"currentRelease":current,"releases":releases,"modified":current.is_some_and(|r|r["contentHash"]!=hash)})
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
    let content: Value = serde_json::from_str(&raw).map_err(|_| ERROR)?;
    summary["content"] = content.clone();
    if let Some(assets) = release_assets(connection, game_id, &content)? {
        summary["assets"] = assets;
    }
    Ok(summary)
}
fn finalize(
    connection: &Connection,
    game: &Value,
    version: &str,
    ignore: bool,
    expected: Option<&str>,
    content: &Value,
    hash: &str,
) -> Result<Value, String> {
    super::validate_resource_list_budget(game.get("resources"))?;
    if !semver(version)
        || expected.is_some_and(|v| !valid_hash(v))
        || (ignore && expected.is_none())
    {
        return Err(ERROR.into());
    }
    if game.get("trashedAt").is_some_and(|v| !v.is_null()) {
        return Err("Cannot release a trashed game".into());
    }
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
    Ok(json!({"kind":"released","state":state(connection,game,hash)?}))
}
fn read_saved(connection: &Connection, game_id: &str) -> Result<(Value, i64), String> {
    let (raw, version): (String, i64) = connection
        .query_row(
            "SELECT value,version FROM games WHERE id=?1",
            [game_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    if !(0..=9_007_199_254_740_991).contains(&version) {
        return Err(ERROR.into());
    }
    let game: Value = serde_json::from_str(&raw).map_err(|_| ERROR)?;
    if !game["originalGameId"].as_str().is_some_and(valid_uuid) {
        return Err(ERROR.into());
    }
    Ok((game, version))
}

pub(super) fn request(connection: &mut Connection, input: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(input).map_err(|_| ERROR)?;
    let game_id = match &request {
        Request::Read { game_id, .. }
        | Request::GetRelease { game_id, .. }
        | Request::VerifyRelease { game_id, .. }
        | Request::Release { game_id, .. } => game_id,
    };
    if game_id.trim().is_empty() {
        return Err(ERROR.into());
    }
    match &request {
        Request::GetRelease { release_id, .. } => {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .map_err(db_error)?;
            let (_, version) = read_saved(&tx, game_id)?;
            let mut reply = json!({"version":version,"records":[]});
            reply["release"] = get_release(&tx, game_id, release_id)?;
            tx.commit().map_err(db_error)?;
            Ok(reply)
        }
        Request::VerifyRelease { release_id, .. } => {
            if !valid_uuid(release_id) {
                return Err(ERROR.into());
            }
            let (game, version) = read_saved(connection, game_id)?;
            let (raw, stored): (String, String) = connection
                .query_row(
                    "SELECT content,content_hash FROM game_releases WHERE game_id=?1 AND id=?2",
                    params![game_id, release_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| "Game release not found")?;
            let content: Value = serde_json::from_str(&raw).map_err(|_| ERROR)?;
            let hash = release_digest(connection, &game, &content)?;
            if hash != stored {
                return Err(packages::error("integrity"));
            }
            Ok(json!({"version":version,"records":[],"releaseVerification":{"contentHash":hash}}))
        }
        Request::Read { .. } => {
            // Advisory read: the digest is streamed outside any write lock.
            let (game, version) = read_saved(connection, game_id)?;
            let content = content(connection, &game)?;
            let hash = release_digest(connection, &game, &content)?;
            let mut reply = json!({"version":version,"records":[]});
            reply["versioning"] = state(connection, &game, &hash)?;
            Ok(reply)
        }
        Request::Release {
            content_version,
            ignore_conflict,
            expected_content_hash,
            ..
        } => {
            // The edit lock outranks content validation; check it before hashing (§2.8).
            let (game, version) = read_saved(connection, game_id)?;
            super::edit_lock::guard(connection, game_id, "release")?;
            let content = content(connection, &game)?;
            let hash = release_digest(connection, &game, &content)?;
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let (fresh, fresh_version) = read_saved(&tx, game_id)?;
            if fresh_version != version {
                return Err(super::CONFLICT.into());
            }
            super::edit_lock::guard(&tx, game_id, "release")?;
            assert_owned_resources(&tx, game_id, fresh.get("resources"))?;
            let mut reply = json!({"version":fresh_version,"records":[]});
            reply["releaseResult"] = finalize(
                &tx,
                &fresh,
                content_version,
                *ignore_conflict,
                expected_content_hash.as_deref(),
                &content,
                &hash,
            )?;
            tx.commit().map_err(db_error)?;
            Ok(reply)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_budget_counts_keys_and_excludes_resource_nodes() {
        let mut value = Map::new();
        value.insert("k".repeat(16 * 1024 * 1024), Value::Null);
        assert!(bound_content(&Value::Object(value.clone()), 0, &mut (0, 0)).is_ok());
        value.insert("x".into(), Value::Null);
        assert!(bound_content(&Value::Object(value), 0, &mut (0, 0)).is_err());
        let control = json!({"x":"\0".repeat(16 * 1024 * 1024 - 1)});
        assert!(bound_content(&control, 0, &mut (0, 0)).is_ok());
        assert!(
            serde_json::to_vec(&control).unwrap().len() as u64
                <= super::super::DOCUMENT_COMMIT_BYTES
        );
        let mut numbers = vec![json!("\0".repeat(16 * 1024 * 1024))];
        numbers.extend(
            (0..99998).map(|index| json!(if index % 2 == 0 { f64::MAX } else { -f64::MAX })),
        );
        let value = Value::Array(numbers);
        assert!(bound_content(&value, 0, &mut (0, 0)).is_ok());
        let bytes = serde_json::to_vec(&value).unwrap().len() as u64;
        assert!(bytes > 6 * 16 * 1024 * 1024 + 8 * 100_000 + 65536);
        assert!(bytes <= super::super::DOCUMENT_COMMIT_BYTES - super::super::RESOURCE_LIST_BYTES);
        let resources = json!({"image":{"name":"image.png","mime":"image/png","data":format!("helia-asset:{}", "a".repeat(64))}});
        assert!(bound_content(&json!({"resources":resources}), 0, &mut (0, 0)).is_ok());
        for field in ["name", "mime", "data"] {
            let mut invalid = resources.clone();
            invalid["image"][field] = json!("invalid:\0");
            assert!(bound_content(&json!({"resources":invalid}), 0, &mut (0, 0)).is_err());
        }
    }

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

    fn legacy_code() -> Value {
        fixtures()[2]["game"]["code"].clone()
    }

    #[test]
    fn trims_and_parses_imports_with_javascript_whitespace_semantics() {
        assert!(js_whitespace('\u{feff}') && js_whitespace('\u{3000}') && js_whitespace('\n'));
        assert!(!js_whitespace('\u{0085}') && !js_whitespace('\u{200b}'));
        let db = connection();
        let mut game = fixtures()[0]["game"].clone();
        game["title"] = json!("\u{feff}\u{3000} Title\u{0085}\u{2029}");
        game["genre"] = json!("\u{0085}Genre\u{feff}");
        game["description"] = json!("\u{205f}Desc\u{00a0}");
        let frozen = content(&db, &game).unwrap();
        assert_eq!(frozen["title"], "Title\u{0085}");
        assert_eq!(frozen["genre"], "\u{0085}Genre");
        assert_eq!(frozen["description"], "Desc");
        // A title made only of JS whitespace (incl. U+FEFF) is empty after TS `trim()` and rejected.
        game["title"] = json!("\u{feff}\u{3000}");
        assert!(content(&db, &game).is_err());
        // U+0085 survives TS `trim()`, so it counts toward the 120-character limit.
        game["title"] = json!(format!("{}\u{0085}", "a".repeat(119)));
        assert!(content(&db, &game).is_ok());
        game["title"] = json!(format!("{}\u{0085}", "a".repeat(120)));
        assert!(content(&db, &game).is_err());
        assert_eq!(
            retarget_imports("import x from\u{feff}'./a.js';import(\u{3000}'./b.jsx')"),
            "import x from\u{feff}'./a';import(\u{3000}'./b')"
        );
        assert_eq!(
            retarget_imports("import x from\u{0085}'./a.js'"),
            "import x from\u{0085}'./a.js'"
        );
        let mut ai = json!({"version":1,"lorebook":[],"folders":["\u{feff}Lore\u{0085}"]});
        assert_eq!(ai_content(&ai).unwrap()["folders"], json!(["Lore\u{0085}"]));
        ai["folders"] = json!(["\u{feff}"]);
        assert!(ai_content(&ai).is_err());
    }

    #[test]
    fn storage_game_metadata_uses_javascript_trim_boundaries() {
        let valid = |title: String, genre: &str, description: String| {
            let mut game = fixtures()[0]["game"].clone();
            game["title"] = json!(title);
            game["genre"] = json!(genre);
            game["description"] = json!(description);
            super::super::valid_value(super::super::Table::Games, &game)
        };
        let plain = || "Description".to_owned();
        assert!(valid("Title".into(), "Genre", plain()));
        // BOM-only: empty after TS `trim()` (Rust `str::trim` keeps U+FEFF).
        assert!(!valid("\u{feff}".into(), "Genre", plain()));
        assert!(!valid("\u{feff}\u{3000} \n".into(), "Genre", plain()));
        // U+0085-only: not JS whitespace, so the title is non-empty.
        assert!(valid("\u{0085}".into(), "Genre", plain()));
        // U+0085 survives trimming and counts toward the 120-character limit.
        assert!(valid(
            format!("{}\u{0085}", "a".repeat(119)),
            "Genre",
            plain()
        ));
        assert!(!valid(
            format!("{}\u{0085}", "a".repeat(120)),
            "Genre",
            plain()
        ));
        // U+FEFF padding is trimmed before measuring.
        assert!(valid(
            format!("\u{feff}{}\u{feff}", "a".repeat(120)),
            "Genre",
            plain()
        ));
        assert!(valid(
            "Title".into(),
            &format!("{}\u{feff}", "g".repeat(80)),
            plain()
        ));
        assert!(!valid(
            "Title".into(),
            &format!("{}\u{0085}", "g".repeat(80)),
            plain()
        ));
        assert!(valid(
            "Title".into(),
            "Genre",
            format!("\u{feff}{}", "d".repeat(2000))
        ));
        assert!(!valid(
            "Title".into(),
            "Genre",
            format!("\u{0085}{}", "d".repeat(2000))
        ));
    }

    #[test]
    fn leaves_bare_relative_directory_imports_untouched() {
        let source = "import a from './.js';import b from \"../.jsx\";import('./.jsx');export * from './..js';import c from './c.js';";
        assert_eq!(
            retarget_imports(source),
            "import a from './.js';import b from \"../.jsx\";import('./.jsx');export * from './.';import c from './c';"
        );
    }

    #[test]
    fn code_normalization_enforces_typescript_project_limits() {
        assert!(normalize_code(&legacy_code()).is_ok());
        let mut code = legacy_code();
        let files = code["files"].as_object_mut().unwrap();
        while files.len() < 64 {
            let index = files.len();
            files.insert(
                format!("extra-{index}.ts"),
                json!({"language":"typescript","source":""}),
            );
        }
        assert!(normalize_code(&code).is_ok());
        code["files"]["one-too-many.ts"] = json!({"language":"typescript","source":""});
        assert!(normalize_code(&code).is_err());

        let mut code = legacy_code();
        code["files"]["big.ts"] = json!({"language":"typescript","source":"a".repeat(512 * 1024)});
        assert!(normalize_code(&code).is_err());
        code["files"]["big.ts"]["source"] = json!("a".repeat(400 * 1024));
        assert!(normalize_code(&code).is_ok());
        // Multi-byte sources count UTF-8 bytes, like TS TextEncoder.
        code["files"]["big.ts"]["source"] = json!("가".repeat(180 * 1024));
        assert!(normalize_code(&code).is_err());

        let mut code = legacy_code();
        code["files"]["style.css"]["source"] = json!("a".repeat(64 * 1024));
        assert!(normalize_code(&code).is_ok());
        code["files"]["style.css"]["source"] = json!("a".repeat(64 * 1024 + 1));
        assert!(normalize_code(&code).is_err());

        let mut code = legacy_code();
        code["folders"] = json!(vec!["same"; 128]);
        assert_eq!(normalize_code(&code).unwrap()["folders"], json!(["same"]));
        code["folders"] = json!(vec!["same"; 129]);
        assert!(normalize_code(&code).is_err());

        let mut code = legacy_code();
        code["files"]["other.js"]["language"] = json!("python");
        assert!(normalize_code(&code).is_err());
        code["files"]["other.js"]["language"] = json!("javascript");
        assert_eq!(
            normalize_code(&code).unwrap()["files"]["other.ts"]["language"],
            "typescript"
        );
    }

    #[test]
    fn presentation_layout_is_validated_before_normalization() {
        let mut code = legacy_code();
        // Previously this recursed through `null` children without bound.
        code["presentation"]["layout"] = json!({"kind":"bogus"});
        assert!(normalize_code(&code).is_err());
        let mut deep = json!({"kind":"panel","id":"leaf"});
        for index in 0..9 {
            deep = json!({"kind":"split","axis":"vertical","ratio":0.5,"first":deep,"second":{"kind":"panel","id":format!("p{index}")}});
        }
        assert!(super::super::panel_layout(
            &deep["first"],
            0,
            &mut Default::default()
        ));
        code["presentation"]["layout"] = deep;
        assert!(normalize_code(&code).is_err());
        code["presentation"]["layout"] = json!({"kind":"split","axis":"horizontal","ratio":0.5,"first":{"kind":"panel","id":"a"},"second":{"kind":"panel","id":"a"}});
        assert!(normalize_code(&code).is_err());
        let mut ui = json!({"layout":{"kind":"bogus"}});
        assert!(normalize_presentation(&mut ui).is_err());
    }

    #[test]
    fn presentation_rejects_unknown_keys_instead_of_dropping_them() {
        let mut code = legacy_code();
        code["presentation"]["theme"] = json!("dark");
        assert!(normalize_code(&code).is_err());
        code["presentation"] = json!("left");
        assert!(normalize_code(&code).is_err());
    }

    #[test]
    fn storage_validates_the_normalized_code_project() {
        let mut code = legacy_code();
        assert!(super::super::code_project(Some(&code)));
        // A canonical entry may point at a legacy `.js` file, as in TS parseCodeProject.
        code["entry"] = json!("main.tsx");
        assert!(super::super::code_project(Some(&code)));
        code["entry"] = json!("missing.ts");
        assert!(!super::super::code_project(Some(&code)));
        let mut code = legacy_code();
        code["files"]["main.tsx"] = code["files"]["main.jsx"].clone();
        assert!(!super::super::code_project(Some(&code)));
        let mut code = legacy_code();
        code["folders"] = json!(vec!["same"; 129]);
        assert!(!super::super::code_project(Some(&code)));
        let mut code = legacy_code();
        code["presentation"]["theme"] = json!("dark");
        assert!(!super::super::code_project(Some(&code)));
        let mut code = legacy_code();
        code["version"] = json!(2);
        assert!(!super::super::code_project(Some(&code)));
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

    /// The release `connection()` omits runtime/media tables; reference digests need them.
    fn media_connection() -> Connection {
        let db = connection();
        db.execute_batch(crate::runtime_content::SCHEMA).unwrap();
        db.execute_batch(crate::runtime_content::MEDIA_SCHEMA)
            .unwrap();
        db
    }

    /// Seed a ready v2 object plus its owning blob, mirroring runtime_content::tests::seed_media.
    fn seed_media(db: &Connection, game_id: &str, bytes: &[u8], mime: &str) -> Value {
        let mut identity = crate::media_identity::MediaIdentity::new(game_id, mime);
        identity.update(bytes).unwrap();
        let identity = identity.digest();
        let object_id = format!("object-{game_id}");
        db.execute(
            "INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?1,?2,'ready',?3,1048576,?4,?5,'now')",
            params![object_id, game_id, bytes.len() as i64, identity.raw, identity.crc],
        ).unwrap();
        for (index, chunk) in bytes.chunks(1_048_576).enumerate() {
            let mut chunk_identity = crate::media_identity::MediaIdentity::new(game_id, mime);
            chunk_identity.update(chunk).unwrap();
            db.execute(
                "INSERT INTO media_chunks VALUES(?1,?2,?3,?4)",
                params![object_id, index as i64, chunk_identity.digest().raw, chunk],
            )
            .unwrap();
        }
        let blob = json!({"schemaVersion":2,"id":identity.blob_id,"gameId":game_id,"mime":mime,"object":identity.raw,"size":bytes.len()});
        db.execute(
            "INSERT OR REPLACE INTO blobs VALUES(?1,?2,?3)",
            params![identity.blob_id, game_id, blob.to_string()],
        )
        .unwrap();
        for hash in [&identity.asset_hash, &identity.blob_id] {
            db.execute(
                "INSERT OR REPLACE INTO runtime_assets VALUES(?1,?2,?3)",
                params![game_id, hash, identity.blob_id],
            )
            .unwrap();
        }
        blob
    }

    fn reference_resources(blob_id: &str, mime: &str) -> Value {
        json!({"portrait":{"name":"images/portrait.png","mime":mime,"data":format!("helia-asset:{blob_id}")}})
    }

    #[test]
    fn reference_releases_keep_references_confirm_assets_and_verify_the_streamed_digest() {
        let mut db = media_connection();
        let mut game = install(&db, "one");
        let bytes = vec![1u8, 2, 3];
        let blob = seed_media(&db, "one", &bytes, "image/png");
        let blob_id = blob["id"].as_str().unwrap().to_owned();
        game["resources"] = reference_resources(&blob_id, "image/png");
        save(&db, &game);
        let released = release(&mut db, "one", "1.0.0");
        assert_eq!(released["kind"], "released");
        let release_id = released["state"]["currentRelease"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let frozen = get_release(&db, "one", &release_id).unwrap();
        // The stored release keeps the reference instead of inline bytes.
        assert_eq!(
            frozen["content"]["resources"]["portrait"]["data"],
            format!("helia-asset:{blob_id}")
        );
        assert_eq!(frozen["assets"][blob_id.as_str()]["mime"], "image/png");
        assert_eq!(frozen["assets"][blob_id.as_str()]["size"], 3);
        assert_eq!(frozen["assets"][blob_id.as_str()]["sha256"], blob["object"]);
        let verified = request(
            &mut db,
            json!({"kind":"versioning","action":"verifyRelease","gameId":"one","releaseId":release_id}),
        )
        .unwrap();
        let hash = verified["releaseVerification"]["contentHash"]
            .as_str()
            .unwrap();
        assert_eq!(
            hash,
            released["state"]["currentRelease"]["contentHash"]
                .as_str()
                .unwrap()
        );
        // Streaming the referenced bytes equals hashing the same bytes inline.
        let mut inline = frozen["content"].clone();
        inline["resources"]["portrait"]["data"] = json!(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ));
        assert_eq!(content_hash(&inline).unwrap(), hash);
    }

    #[test]
    fn releases_reject_missing_foreign_and_mime_mismatched_references() {
        let mut db = media_connection();
        let mut game = install(&db, "one");
        install(&db, "two");
        let attempt = |db: &mut Connection| {
            request(
                db,
                json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0"}),
            )
            .unwrap_err()
        };
        // Missing blob.
        game["resources"] = reference_resources(&"0".repeat(64), "image/png");
        save(&db, &game);
        assert_eq!(attempt(&mut db), packages::error("missingAsset"));
        // A blob owned by another installation is not visible to this game.
        let foreign = seed_media(&db, "two", &[1], "image/png");
        game["resources"] = reference_resources(foreign["id"].as_str().unwrap(), "image/png");
        save(&db, &game);
        assert_eq!(attempt(&mut db), packages::error("missingAsset"));
        // Same-game blob but a declared MIME that does not match.
        let owned = seed_media(&db, "one", &[1], "image/png");
        game["resources"] = reference_resources(owned["id"].as_str().unwrap(), "video/mp4");
        save(&db, &game);
        assert_eq!(attempt(&mut db), packages::error("mediaType"));
        // The matching reference is accepted.
        game["resources"] = reference_resources(owned["id"].as_str().unwrap(), "image/png");
        save(&db, &game);
        assert_eq!(release(&mut db, "one", "1.0.0")["kind"], "released");
    }

    #[test]
    fn reference_releases_require_fresh_content_confirmation() {
        let mut db = media_connection();
        let mut game = install(&db, "one");
        let blob = seed_media(&db, "one", &[1, 2, 3], "image/png");
        game["resources"] = reference_resources(blob["id"].as_str().unwrap(), "image/png");
        save(&db, &game);
        assert_eq!(
            request(
                &mut db,
                json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0","expectedContentHash":"0".repeat(64)}),
            )
            .unwrap_err(),
            super::super::CONFLICT
        );
        let hash = read(&mut db, "one")["contentHash"].clone();
        let released = request(
            &mut db,
            json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0","expectedContentHash":hash}),
        )
        .unwrap();
        assert_eq!(released["releaseResult"]["kind"], "released");
    }
}
