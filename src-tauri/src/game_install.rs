//! Authoritative package installation. Pure decisions are shared with future upgrades.
use super::*;
use std::collections::BTreeMap;
use std::sync::OnceLock;

const ERROR_PREFIX: &str = "GAME_PACKAGE:";
const ERROR_CODES: &[&str] = &[
    "format",
    "version",
    "integrity",
    "limit",
    "content",
    "nonCanonical",
    "installOnlyKey",
    "newerHeliaRequired",
    "staleAcknowledgement",
    "mediaType",
    "mediaSize",
    "uploadMissing",
    "uploadState",
    "scopeMismatch",
    "gameNotWritable",
    "chunkInvalid",
    "chunkConflict",
    "uploadIncomplete",
    "storageFull",
    "busy",
    "requestLimit",
    "inProgress",
    "missingAsset",
    "packageReference",
    "exportFormatPending",
];
pub(in crate::storage) fn error(code: &str) -> String {
    format!("{ERROR_PREFIX}{code}")
}
fn require(condition: bool, code: &str) -> Result<(), String> {
    if condition { Ok(()) } else { Err(error(code)) }
}
pub(in crate::storage) fn bridge_error(message: String) -> Value {
    match message
        .strip_prefix(ERROR_PREFIX)
        .filter(|code| ERROR_CODES.contains(code))
    {
        Some(code) => json!({"errorCode":code}),
        None => json!(message),
    }
}

// v1: content (16 MiB) + ceil(assets (24 MiB) * 4/3) + 여유분 = 64 MiB.
// 앱 리소스 한도(1 MiB/3 MiB)를 없애면 재검토. 웹 본문 한도는 별도다.
// The scalar JSON is the single source for native and desktop transport limits.
pub(in crate::storage) fn check_request_size(input: &Value) -> Result<(), String> {
    check_json_size(
        serde_json::to_vec(input)
            .map_err(|_| error("format"))?
            .len(),
    )
}
fn check_json_size(bytes: usize) -> Result<(), String> {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    let limit = LIMIT.get_or_init(|| {
        include_str!("../../src/lib/storage/install-request-limit.json")
            .trim()
            .parse()
            .expect("install request limit")
    });
    require(bytes <= *limit, "limit")
}
pub(in crate::storage) fn parse_install_json(input: &Value) -> Result<Value, String> {
    let raw = string(&input["json"], "format")?;
    check_json_size(raw.len())?;
    // B1 normally rejects lone surrogates first. This parser is defense in depth
    // and preserves package error codes rather than a generic Tauri IPC rejection.
    let value: Value = serde_json::from_str(raw).map_err(|_| error("content"))?;
    require(value["kind"] == "install", "format")?;
    Ok(value)
}
fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|row| row.len() == keys.len() && keys.iter().all(|key| row.contains_key(*key)))
}
fn string<'a>(value: &'a Value, code: &str) -> Result<&'a str, String> {
    value.as_str().ok_or_else(|| error(code))
}
fn origin(value: &Value) -> Result<&str, String> {
    let id = string(value, "format")?;
    require(valid_uuid(id) && id == id.to_ascii_lowercase(), "format")?;
    Ok(id)
}
fn version(value: &Value) -> Result<&str, String> {
    let value = string(value, "format")?;
    require(semver(value), "format")?;
    Ok(value)
}
fn hash<'a>(value: &'a Value, code: &str) -> Result<&'a str, String> {
    let value = string(value, code)?;
    require(valid_hash(value), code)?;
    Ok(value)
}
fn package_timestamp(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if value.len() != 24
        || !value.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'.',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |a, b| value[a..b].parse::<u16>().unwrap_or(0);
    let year = number(0, 4);
    year > 0
        && time::Month::try_from(number(5, 7) as u8)
            .ok()
            .is_some_and(|month| {
                time::Date::from_calendar_date(year as i32, month, number(8, 10) as u8).is_ok()
            })
        && time::Time::from_hms_milli(
            number(11, 13) as u8,
            number(14, 16) as u8,
            number(17, 19) as u8,
            number(20, 23),
        )
        .is_ok()
}
pub(in crate::storage) fn valid_installed_from(value: &Value) -> bool {
    exact_keys(
        value,
        &[
            "kind",
            "packageFormatVersion",
            "packageRelease",
            "versionChanged",
            "installedAt",
        ],
    ) && value["kind"] == "package"
        && value["packageFormatVersion"]
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n))
        && value["versionChanged"].is_boolean()
        && package_timestamp(&value["installedAt"])
        && exact_keys(
            &value["packageRelease"],
            &["contentVersion", "contentHash", "createdAt"],
        )
        && version(&value["packageRelease"]["contentVersion"]).is_ok()
        && hash(&value["packageRelease"]["contentHash"], "format").is_ok()
        && package_timestamp(&value["packageRelease"]["createdAt"])
}

/// Metadata-only input permits reuse by an upgrade request without release.content.
pub(in crate::storage) fn effective_version(request: &Value) -> Result<&str, String> {
    let source = version(&request["release"]["contentVersion"])?;
    match request.get("installContentVersion") {
        None => Ok(source),
        Some(value) => {
            let target = version(value)?;
            require(target != source, "format")?;
            Ok(target)
        }
    }
}
fn validate_acknowledgement(value: &Value) -> Result<(), String> {
    require(value.is_object(), "format")?;
    origin(&value["originalGameId"])?;
    version(&value["contentVersion"])?;
    let incoming = hash(&value["incomingHash"], "format")?;
    let hashes = value["existingHashes"]
        .as_array()
        .ok_or_else(|| error("format"))?;
    require(hashes.len() <= LIMIT, "format")?;
    let mut previous = None;
    for item in hashes {
        let item = hash(item, "format")?;
        require(
            item != incoming && previous.is_none_or(|p| p < item),
            "format",
        )?;
        previous = Some(item);
    }
    Ok(())
}
fn validate_request(request: &Value) -> Result<(), String> {
    require(
        request["packageFormatVersion"].as_f64() == Some(1.0),
        "format",
    )?;
    let release = &request["release"];
    require(release.is_object(), "format")?;
    super::super::validate_resource_list_budget(release["content"].get("resources"))?;
    bound_content(&release["content"], 0, &mut (0, 0)).map_err(|_| error("content"))?;
    hash(&release["contentHash"], "content")?;
    require(
        exact_keys(
            release,
            &[
                "originalGameId",
                "contentVersion",
                "contentHash",
                "createdAt",
                "content",
            ],
        ),
        "format",
    )?;
    for key in ["gameId", "sessionId"] {
        require(valid_uuid(string(&request[key], "format")?), "format")?;
    }
    origin(&release["originalGameId"])?;
    effective_version(request)?;
    require(package_timestamp(&release["createdAt"]), "format")?;
    if let Some(ack) = request.get("conflictAcknowledgement") {
        validate_acknowledgement(ack)?;
    }
    Ok(())
}
fn now() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
pub(in crate::storage) fn installed_from(request: &Value, now: &str) -> Result<Value, String> {
    Ok(
        json!({"kind":"package","packageFormatVersion":request["packageFormatVersion"],
        "packageRelease":pick(&request["release"], &["contentVersion","contentHash","createdAt"]),
        "versionChanged":effective_version(request)? != request["release"]["contentVersion"],"installedAt":now}),
    )
}
pub(in crate::storage) fn release_timestamp<'a>(
    request: &'a Value,
    now: &'a str,
) -> Result<&'a str, String> {
    if effective_version(request)? == request["release"]["contentVersion"] {
        string(&request["release"]["createdAt"], "format")
    } else {
        Ok(now)
    }
}
fn verify(
    connection: &Connection,
    request: &Value,
    now: &str,
) -> Result<(Value, Value, String), String> {
    let input = &request["release"]["content"];
    require(input.is_object(), "format")?;
    let install_only = [
        "schemaVersion",
        "id",
        "originalGameId",
        "activeSessionId",
        "createdAt",
        "updatedAt",
        "trashedAt",
        "installedFrom",
        "editLock",
    ];
    require(
        !install_only.iter().any(|key| input.get(*key).is_some()),
        "installOnlyKey",
    )?;
    let mut game = input.clone();
    if game.get("scripts").is_none() {
        game["scripts"] = json!({});
    }
    game["schemaVersion"] = json!(2);
    game["id"] = request["gameId"].clone();
    game["originalGameId"] = request["release"]["originalGameId"].clone();
    game["activeSessionId"] = request["sessionId"].clone();
    game["createdAt"] = json!(now);
    game["updatedAt"] = json!(now);
    let normalized = content(connection, &game).map_err(|_| error("content"))?;
    require(
        canonical(&normalized).map_err(|_| error("content"))?
            == canonical(input).map_err(|_| error("content"))?,
        "nonCanonical",
    )?;
    let hash = content_hash(&normalized).map_err(|_| error("content"))?;
    require(hash == request["release"]["contentHash"], "integrity")?;
    // Store the normalized game, just like parseGame in the TS host.
    let mut game = normalized.clone();
    if game.get("scripts").is_none() {
        game["scripts"] = json!({});
    }
    for key in [
        "schemaVersion",
        "id",
        "originalGameId",
        "activeSessionId",
        "createdAt",
        "updatedAt",
    ] {
        game[key] = match key {
            "schemaVersion" => json!(2),
            "id" => request["gameId"].clone(),
            "originalGameId" => request["release"]["originalGameId"].clone(),
            "activeSessionId" => request["sessionId"].clone(),
            _ => json!(now),
        };
    }
    game["installedFrom"] = installed_from(request, now)?;
    game["editLock"] = json!(true);
    Ok((game, normalized, hash))
}

pub(in crate::storage) fn conflict_hashes(
    db: &Connection,
    origin: &str,
    version: &str,
    incoming: &str,
) -> Result<Vec<String>, String> {
    let mut query = db.prepare("SELECT DISTINCT r.content_hash FROM game_releases r JOIN games g ON g.id=r.game_id WHERE r.original_game_id=?1 AND r.content_version=?2 AND json_extract(g.value,'$.trashedAt') IS NULL AND r.content_hash<>?3 ORDER BY r.content_hash LIMIT 10001").map_err(db_error)?;
    let hashes = query
        .query_map(params![origin, version, incoming], |row| {
            row.get::<_, String>(0)
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    require(hashes.len() <= LIMIT, "limit")?;
    for item in &hashes {
        hash(&json!(item), "format")?;
    }
    Ok(hashes)
}
/// Binding is checked even when K is empty; a conflict result always has nonempty K.
pub(in crate::storage) fn conflict_decision(
    actual: &Value,
    ack: Option<&Value>,
) -> Result<Option<Value>, String> {
    let bound = ack.is_none_or(|ack| {
        ["originalGameId", "contentVersion", "incomingHash"]
            .iter()
            .all(|key| ack[*key] == actual[*key])
    });
    let empty = actual["existingHashes"]
        .as_array()
        .is_some_and(Vec::is_empty);
    require(bound || !empty, "staleAcknowledgement")?;
    if empty || (bound && ack.is_some_and(|ack| ack["existingHashes"] == actual["existingHashes"]))
    {
        return Ok(None);
    }
    let mut result = actual.clone();
    result["kind"] = json!("conflict");
    Ok(Some(result))
}
pub(in crate::storage) fn store_release(
    db: &Connection,
    request: &Value,
    content: &Value,
    now: &str,
) -> Result<Value, String> {
    let game_id = string(&request["gameId"], "format")?;
    let version = effective_version(request)?;
    let hash = string(&request["release"]["contentHash"], "format")?;
    let existing: Option<(String,String,String)> = db.query_row("SELECT id,original_game_id,created_at FROM game_releases WHERE game_id=?1 AND content_version=?2 AND content_hash=?3", params![game_id,version,hash], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_error)?;
    let (id, created) = if let Some((id, origin, created)) = existing {
        require(origin == request["release"]["originalGameId"], "format")?;
        (id, created)
    } else {
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM game_releases WHERE game_id=?1",
                [game_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        require(count < LIMIT as i64, "limit")?;
        let id = uuid()?;
        let created = release_timestamp(request, now)?.to_owned();
        db.execute("INSERT INTO game_releases(id,game_id,original_game_id,content_version,content_hash,created_at,content) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,game_id,string(&request["release"]["originalGameId"],"format")?,version,hash,created,content.to_string()]).map_err(db_error)?;
        (id, created)
    };
    Ok(
        json!({"id":id,"originalGameId":request["release"]["originalGameId"],"contentVersion":version,"contentHash":hash,"createdAt":created}),
    )
}
pub(in crate::storage) fn select_release(
    db: &Connection,
    game_id: &str,
    release_id: &str,
) -> Result<(), String> {
    db.execute("INSERT INTO game_release_selection(game_id,release_id) VALUES(?1,?2) ON CONFLICT(game_id) DO UPDATE SET release_id=excluded.release_id", params![game_id,release_id]).map_err(db_error)?;
    Ok(())
}
fn install(
    db: &Connection,
    request: &Value,
    now: &str,
    verified: (Value, Value, String),
) -> Result<Value, String> {
    let (game, content, hash) = verified;
    let game_id = string(&request["gameId"], "format")?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM games WHERE id=?1)",
            [game_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    require(!exists, "format")?;
    let identity = string(&request["release"]["originalGameId"], "format")?;
    let version = effective_version(request)?;
    let actual = json!({"originalGameId":identity,"contentVersion":version,"incomingHash":hash,
        "existingHashes":conflict_hashes(db,identity,version,&hash)?});
    if let Some(conflict) = conflict_decision(&actual, request.get("conflictAcknowledgement"))? {
        return Ok(json!({"version":0,"records":[],"installResult":conflict}));
    }
    let session_id = string(&request["sessionId"], "format")?;
    let session = json!({"schemaVersion":1,"id":session_id,"gameId":game_id,"title":"첫 번째 세션","createdAt":now,"updatedAt":now});
    db.execute(
        "INSERT INTO games(id,value) VALUES(?1,?2)",
        params![game_id, game.to_string()],
    )
    .map_err(db_error)?;
    db.execute(
        "INSERT INTO sessions(id,game_id,value) VALUES(?1,?2,?3)",
        params![session_id, game_id, session.to_string()],
    )
    .map_err(db_error)?;
    let release = store_release(db, request, &content, now)?;
    select_release(db, game_id, string(&release["id"], "format")?)?;
    let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN games g ON g.id=s.game_id WHERE g.id=?1 AND s.id=json_extract(g.value,'$.activeSessionId'))",[game_id],|r|r.get(0)).map_err(db_error)?;
    require(valid, "format")?;
    let raw: String = db
        .query_row("SELECT value FROM games WHERE id=?1", [game_id], |r| {
            r.get(0)
        })
        .map_err(db_error)?;
    let stored: Value = serde_json::from_str(&raw).map_err(|_| error("content"))?;
    let actual_hash = content_hash(&super::content(db, &stored).map_err(|_| error("content"))?)
        .map_err(|_| error("content"))?;
    let versioning = state(db, &stored, &actual_hash)?;
    require(
        actual_hash == hash && versioning["modified"] == false,
        "integrity",
    )?;
    Ok(
        json!({"version":0,"records":[],"installResult":{"kind":"installed","gameId":game_id,"versioning":versioning}}),
    )
}

fn preview(db: &Connection, request: &Value) -> Result<Value, String> {
    let origin = origin(&request["originalGameId"])?;
    let version = version(&request["contentVersion"])?;
    let mut query = db.prepare("SELECT g.id,g.value,s.release_id,EXISTS(SELECT 1 FROM editor_drafts d WHERE d.game_id=g.id AND d.value IS NOT NULL) FROM games g LEFT JOIN game_release_selection s ON s.game_id=g.id WHERE json_extract(g.value,'$.originalGameId')=?1 AND json_extract(g.value,'$.trashedAt') IS NULL ORDER BY g.id LIMIT 10001").map_err(db_error)?;
    let rows = query
        .query_map([origin], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    require(rows.len() <= LIMIT, "limit")?;
    let mut histories: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut query = db.prepare("SELECT r.game_id,r.id,r.original_game_id,r.content_version,r.content_hash,r.created_at FROM game_releases r JOIN games g ON g.id=r.game_id WHERE json_extract(g.value,'$.originalGameId')=?1 AND json_extract(g.value,'$.trashedAt') IS NULL ORDER BY r.game_id,r.rowid").map_err(db_error)?;
    let releases = query.query_map([origin], |r| Ok((r.get::<_,String>(0)?,json!({"id":r.get::<_,String>(1)?,"originalGameId":r.get::<_,String>(2)?,"contentVersion":r.get::<_,String>(3)?,"contentHash":r.get::<_,String>(4)?,"createdAt":r.get::<_,String>(5)?})))).map_err(db_error)?;
    for release in releases {
        let (id, release) = release.map_err(db_error)?;
        let history = histories.entry(id).or_default();
        require(history.len() < LIMIT, "limit")?;
        history.push(release);
    }
    let mut entries = vec![];
    for (id, raw, selected, draft) in rows {
        let game: Value = serde_json::from_str(&raw).map_err(|_| error("content"))?;
        let hash = content_hash(&content(db, &game)?)?;
        let history = histories.remove(&id).unwrap_or_default();
        let hashes: std::collections::BTreeSet<_> = history
            .iter()
            .filter(|r| r["contentVersion"] == version)
            .map(|r| super::packages::hash(&r["contentHash"], "format").map(str::to_owned))
            .collect::<Result<_, _>>()?;
        entries.push(json!({"gameId":id,"title":js_trim(string(&game["title"],"content")?),"hasDraft":draft,
            "existingHashes":hashes,"versioning":state_from_history(&game,&hash,history,selected.as_deref())}));
    }
    Ok(json!({"version":0,"records":[],"installPreview":entries}))
}
pub(in crate::storage) fn request(
    connection: &mut Connection,
    input: Value,
) -> Result<Value, String> {
    let installing = input["kind"] == "install";
    if installing {
        // The bridge checks wire size before opening the DB: raw bytes for
        // installJson, serialized bytes only for an already parsed install.
        validate_request(&input)?;
    } else {
        require(input["kind"] == "installPreview", "format")?;
        origin(&input["originalGameId"])?;
        version(&input["contentVersion"])?;
    }
    let now = now();
    let verified = if installing {
        let read = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(db_error)?;
        let verified = verify(&read, &input, &now)?;
        // portable_assets may read blobs for helia-asset references, but they
        // cannot equal the normalized inline data URLs in the canonical tree.
        // Accepted input is therefore independent of blob state. Close this
        // snapshot before taking the write lock; existence and conflicts are
        // checked against current state inside install.
        read.commit().map_err(db_error)?;
        Some(verified)
    } else {
        None
    };
    let tx = connection
        .transaction_with_behavior(if installing {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })
        .map_err(db_error)?;
    let reply = if let Some(verified) = verified {
        install(&tx, &input, &now, verified)?
    } else {
        preview(&tx, &input)?
    };
    tx.commit().map_err(db_error)?;
    Ok(reply)
}

#[cfg(test)]
#[path = "game_install_tests.rs"]
mod tests;
