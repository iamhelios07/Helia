//! Content synchronization shared by all desktop storage callers. Persisted rows remain portable.
use crate::storage;
use ring::digest::{SHA256, digest};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, path::Path};

const ERROR: &str = "Invalid storage synchronization request";
fn hash(value: &Value) -> String {
    digest(&SHA256, &serde_json::to_vec(value).unwrap_or_default())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn execute(path: &Path, input: Value) -> Result<Value, String> {
    if input["kind"] == "asset" {
        return asset(path, &input);
    }
    if matches!(
        input["request"]["kind"].as_str(),
        Some("install" | "installJson" | "installPreview" | "cleanStorage" | "editorLease")
    ) {
        return Err(ERROR.into());
    }
    let known = input["known"].as_array().ok_or(ERROR)?;
    if known.len() > 10000 {
        return Err(ERROR.into());
    }
    let known: HashSet<&str> = known
        .iter()
        .map(|value| value.as_str().filter(|hash| valid_hash(hash)).ok_or(ERROR))
        .collect::<Result<_, _>>()?;
    let (request, claim) = storage::take_body_ref(path, input["request"].clone())?;
    let request = expand(path, request)?;
    let playing = request["kind"] == "read" && request["play"] == true;
    let game_id = request["gameId"].as_str().unwrap_or("").to_owned();
    // A split body is always a stored write; other kinds keep the normal request routing.
    let mut reply = if claim.is_some() {
        storage::execute_stored(path, request, claim)?
    } else {
        storage::execute_request(path, request)?
    };
    let connection = storage::open(path)?;
    let rows = reply["records"].as_array().ok_or(ERROR)?;
    let records = rows
        .iter()
        .map(|row| {
            project(
                row,
                &known,
                if playing {
                    Some((&connection, game_id.as_str()))
                } else {
                    None
                },
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    reply["records"] = json!(records);
    Ok(reply)
}
fn project(
    row: &Value,
    known: &HashSet<&str>,
    runtime: Option<(&rusqlite::Connection, &str)>,
) -> Result<Value, String> {
    let mut value = row["value"].clone();
    if let Some((connection, game_id)) = runtime {
        value = crate::runtime_content::project(
            connection,
            row["table"].as_str().ok_or(ERROR)?,
            game_id,
            &value,
        )?;
    } else if row["table"] == "games" {
        if let Some(resources) = value["resources"].as_object_mut() {
            for resource in resources.values_mut() {
                if resource["data"]
                    .as_str()
                    .is_some_and(|data| data.starts_with("helia-asset:"))
                {
                    continue;
                }
                resource["data"] = json!({"asset":hash(&resource["data"])});
            }
        }
    } else if row["table"] == "blobs" && value["schemaVersion"] != 2 {
        value["data"] = json!({"asset":hash(&value["data"])});
    }
    let fields = if row["table"] == "games" {
        value.as_object().ok_or(ERROR)?.clone()
    } else {
        Map::from_iter([("value".into(), value)])
    };
    let parts: Map<String, Value> = fields
        .into_iter()
        .map(|(key, value)| {
            let domain = match (row["table"].as_str(), key.as_str()) {
                (Some("games"), "resources") => "game-resources",
                (Some("blobs"), _) => "blob",
                _ => "json",
            };
            let fingerprint = hash(&json!([domain, &value]));
            let part = if known.contains(fingerprint.as_str()) {
                json!({"hash":fingerprint})
            } else {
                json!({"hash":fingerprint,"value":value})
            };
            (key, part)
        })
        .collect();
    let mut result = row.as_object().ok_or(ERROR)?.clone();
    result.remove("value");
    result.insert("parts".into(), json!(parts));
    Ok(json!(result))
}
fn expand(path: &Path, mut request: Value) -> Result<Value, String> {
    if request["kind"] != "commit" {
        return Ok(request);
    }
    let game_id = request["gameId"].as_str().ok_or(ERROR)?.to_owned();
    let connection = storage::open(path)?;
    for row in request["records"].as_array_mut().ok_or(ERROR)? {
        if row["table"] != "games" || row.get("patch").is_none() {
            continue;
        }
        if row["id"] != game_id || row["gameId"] != game_id {
            return Err(ERROR.into());
        }
        let text: String = connection
            .query_row("SELECT value FROM games WHERE id=?1", [&game_id], |row| {
                row.get(0)
            })
            .map_err(|_| ERROR)?;
        let mut value: Value = serde_json::from_str(&text).map_err(|_| ERROR)?;
        let set = row["patch"]["set"].as_object().ok_or(ERROR)?;
        for (key, item) in set {
            value[key] = item.clone();
        }
        for key in row["patch"]["remove"].as_array().ok_or(ERROR)? {
            value
                .as_object_mut()
                .ok_or(ERROR)?
                .remove(key.as_str().ok_or(ERROR)?);
        }
        row.as_object_mut().ok_or(ERROR)?.remove("patch");
        row["value"] = value;
    }
    Ok(request)
}
fn asset(path: &Path, input: &Value) -> Result<Value, String> {
    let game_id = input["gameId"].as_str().ok_or(ERROR)?;
    let fingerprint = input["hash"]
        .as_str()
        .filter(|value| valid_hash(value))
        .ok_or(ERROR)?;
    let connection = storage::open(path)?;
    if let Some(value) = crate::runtime_content::read_asset(&connection, game_id, fingerprint)? {
        if value["schemaVersion"] == 2 {
            return Err("Asset unavailable".into());
        }
        return Ok(value);
    }
    let game: Option<String> = connection
        .query_row("SELECT value FROM games WHERE id=?1", [game_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| ERROR)?;
    let game: Value = serde_json::from_str(&game.ok_or(ERROR)?).map_err(|_| ERROR)?;
    if let Some(resources) = game["resources"].as_object() {
        for resource in resources.values() {
            if resource["data"]
                .as_str()
                .is_some_and(|data| data.starts_with("helia-asset:"))
            {
                continue;
            }
            if hash(&resource["data"]) == fingerprint {
                return Ok(resource.clone());
            }
        }
    }
    let mut statement = connection
        .prepare("SELECT value FROM blobs WHERE game_id=?1")
        .map_err(|_| ERROR)?;
    for text in statement
        .query_map(params![game_id], |row| row.get::<_, String>(0))
        .map_err(|_| ERROR)?
    {
        let value: Value = serde_json::from_str(&text.map_err(|_| ERROR)?).map_err(|_| ERROR)?;
        if value["schemaVersion"] == 2 {
            continue;
        }
        if hash(&value["data"]) == fingerprint {
            return Ok(value);
        }
    }
    Err("Asset unavailable".into())
}
