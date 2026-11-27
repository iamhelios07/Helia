//! Immutable derived execution artifacts and game-owned media; no general file access.
use crate::storage;
use base64::Engine;
use ring::digest::{SHA256, digest};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;

const ERROR: &str = "Runtime content unavailable";
pub(crate) const SCHEMA: &str = include_str!("../../src/lib/storage/runtime-content.sql");
pub(crate) fn hash(value: &Value) -> String {
    digest(&SHA256, &serde_json::to_vec(value).unwrap_or_default())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
/// Game-owned blob ID for runtime media; `blobs.id` is a global primary key.
/// Must equal the web host's `runtimeBlobId` (SHA-256 of JSON `[gameId, data]`).
pub(crate) fn blob_id(game_id: &str, data: &str) -> String {
    hash(&json!([game_id, data]))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn artifact(
    connection: &Connection,
    game_id: &str,
    kind: &str,
    value: &Value,
) -> Result<String, String> {
    let fingerprint = hash(&json!([kind, value]));
    connection.execute("INSERT OR IGNORE INTO runtime_artifacts (game_id,hash,kind,value) VALUES (?1,?2,?3,?4)",params![game_id,fingerprint,kind,value.to_string()]).map_err(|_|ERROR)?;
    Ok(fingerprint)
}
pub(crate) fn asset(
    connection: &Connection,
    game_id: &str,
    mime: &str,
    data: &str,
) -> Result<String, String> {
    if let Some(reference) = data
        .strip_prefix("helia-asset:")
        .filter(|value| valid_hash(value))
    {
        return Ok(reference.to_owned());
    }
    if !data.starts_with(&format!("data:{mime};base64,")) {
        return Err(ERROR.into());
    }
    let fingerprint = hash(&json!(data));
    let indexed: Option<String> = connection
        .query_row(
            "SELECT blob_id FROM runtime_assets WHERE game_id=?1 AND hash=?2",
            params![game_id, fingerprint],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ERROR)?;
    let blob_id = if let Some(id) = indexed {
        id
    } else {
        let existing: Option<String> = connection
            .query_row(
                "SELECT id FROM blobs WHERE game_id=?1 AND json_extract(value,'$.data')=?2",
                params![game_id, data],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ERROR)?;
        let id = existing.unwrap_or_else(|| blob_id(game_id, data));
        let value = json!({"schemaVersion":1,"id":id,"gameId":game_id,"mime":mime,"data":data});
        connection
            .execute(
                "INSERT OR IGNORE INTO blobs (id,game_id,value) VALUES (?1,?2,?3)",
                params![id, game_id, value.to_string()],
            )
            .map_err(|_| ERROR)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id) VALUES (?1,?2,?3)",
                params![game_id, fingerprint, id],
            )
            .map_err(|_| ERROR)?;
        id
    };
    connection
        .execute(
            "INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id) VALUES (?1,?2,?3)",
            params![game_id, blob_id, blob_id],
        )
        .map_err(|_| ERROR)?;
    Ok(blob_id)
}
pub(crate) fn read_artifact(path: &Path, input: &Value) -> Result<Value, String> {
    let game_id = input["gameId"].as_str().ok_or(ERROR)?;
    let fingerprint = input["hash"]
        .as_str()
        .filter(|value| valid_hash(value))
        .ok_or(ERROR)?;
    let connection = storage::open(path)?;
    let text: String = connection
        .query_row(
            "SELECT value FROM runtime_artifacts WHERE game_id=?1 AND hash=?2",
            params![game_id, fingerprint],
            |row| row.get(0),
        )
        .map_err(|_| ERROR)?;
    serde_json::from_str(&text).map_err(|_| ERROR.into())
}
pub(crate) fn read_asset(
    connection: &Connection,
    game_id: &str,
    fingerprint: &str,
) -> Result<Option<Value>, String> {
    let text:Option<String>=connection.query_row("SELECT b.value FROM runtime_assets a JOIN blobs b ON b.game_id=a.game_id AND b.id=a.blob_id WHERE a.game_id=?1 AND a.hash=?2",params![game_id,fingerprint],|row|row.get(0)).optional().map_err(|_|ERROR)?;
    text.map(|text| serde_json::from_str(&text).map_err(|_| ERROR.into()))
        .transpose()
}
pub(crate) fn project(
    connection: &Connection,
    table: &str,
    game_id: &str,
    input: &Value,
) -> Result<Value, String> {
    let mut value = input.clone();
    if table == "blobs" {
        value["data"] = json!(
            "helia-asset:".to_owned()
                + &asset(
                    connection,
                    game_id,
                    input["mime"].as_str().ok_or(ERROR)?,
                    input["data"].as_str().ok_or(ERROR)?
                )?
        );
        return Ok(value);
    }
    if !matches!(table, "games" | "snapshots") {
        return Ok(value);
    }
    value.as_object_mut().ok_or(ERROR)?.remove("code");
    if let Some(scripts) = value["scripts"].as_object_mut() {
        for script in scripts.values_mut() {
            if let Some(source) = script["compiled"].as_str() {
                let fingerprint = artifact(
                    connection,
                    game_id,
                    "logic",
                    &json!({"version":1,"source":source}),
                )?;
                *script = json!({"language":"typescript","source":"","artifact":fingerprint});
            }
        }
    }
    if let Some(compiled) = value["ui"].get("compiled").cloned() {
        let fingerprint = artifact(connection, game_id, "ui", &compiled)?;
        let ui = value["ui"].as_object_mut().ok_or(ERROR)?;
        ui.remove("compiled");
        ui.insert("modules".into(), json!({}));
        ui.insert("artifact".into(), json!(fingerprint));
    }
    if let Some(resources) = value["resources"].as_object_mut() {
        for resource in resources.values_mut() {
            let fingerprint = asset(
                connection,
                game_id,
                resource["mime"].as_str().ok_or(ERROR)?,
                resource["data"].as_str().ok_or(ERROR)?,
            )?;
            resource["data"] = json!("helia-asset:".to_owned() + &fingerprint);
        }
    }
    Ok(value)
}
pub(crate) fn media_response(path: &Path, route: &str) -> tauri::http::Response<Vec<u8>> {
    let read = || -> Result<(String, Vec<u8>), String> {
        let decoded = route.replace("%2F", "/").replace("%2f", "/");
        let segments: Vec<_> = decoded.trim_start_matches('/').split('/').collect();
        if segments.len() != 2
            || segments[0].len() > 100
            || !segments[0]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !valid_hash(segments[1])
        {
            return Err(ERROR.into());
        }
        let connection = storage::open(path)?;
        let value = read_asset(&connection, segments[0], segments[1])?.ok_or(ERROR)?;
        let mime = value["mime"].as_str().ok_or(ERROR)?.to_owned();
        if ![
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
        .contains(&mime.as_str())
        {
            return Err(ERROR.into());
        }
        let prefix = format!("data:{mime};base64,");
        let data = value["data"]
            .as_str()
            .and_then(|value| value.strip_prefix(&prefix))
            .ok_or(ERROR)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| ERROR)?;
        Ok((mime, bytes))
    };
    match read() {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=31536000, immutable")
            .header("X-Content-Type-Options", "nosniff")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SQLite opened through `storage::open`, so tests run on the real migrated schema
    /// (including the `blobs.game_id` cascade) with games `one` and `two` installed.
    struct TestDb {
        connection: Option<Connection>,
        path: std::path::PathBuf,
    }

    impl std::ops::Deref for TestDb {
        type Target = Connection;
        fn deref(&self) -> &Connection {
            self.connection.as_ref().unwrap()
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            self.connection.take();
            for suffix in ["", "-wal", "-shm"] {
                let mut name = self.path.clone().into_os_string();
                name.push(suffix);
                let _ = std::fs::remove_file(name);
            }
        }
    }

    fn connection() -> TestDb {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "helia-runtime-content-{}-{}.sqlite",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let db = storage::open(&path).unwrap();
        for id in ["one", "two"] {
            db.execute("INSERT INTO games(id,value) VALUES(?1,'{}')", [id])
                .unwrap();
        }
        TestDb {
            connection: Some(db),
            path,
        }
    }

    #[test]
    fn prepared_content_is_immutable_and_game_scoped() {
        let db = connection();
        let value = json!({"version":1,"source":"const x=1;"});
        let fingerprint = artifact(&db, "one", "logic", &value).unwrap();
        assert_eq!(fingerprint, artifact(&db, "one", "logic", &value).unwrap());
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM runtime_artifacts WHERE game_id='two' AND hash=?1",
                [fingerprint],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let blob = asset(&db, "one", "image/png", "data:image/png;base64,AA==").unwrap();
        assert!(read_asset(&db, "two", &blob).unwrap().is_none());
        assert_eq!(
            blob,
            asset(&db, "one", "image/png", "data:image/png;base64,AA==").unwrap()
        );
    }

    const PNG: &str = "data:image/png;base64,AA==";
    // Shared with src/lib/server/runtime-content.spec.ts; both hosts must produce these values.
    const MEDIA_HASH: &str = "9d5195c090c835cc7998e488ac91f7820df9893d128fde89778cf1c7839dd9db";
    const BLOB_ID_GAME_A: &str = "ded57360c9689691f2457f7730c39195339340d171dd9240f33d92af2d0776f5";

    #[test]
    fn blob_ids_match_the_web_host_vector() {
        assert_eq!(hash(&json!(PNG)), MEDIA_HASH);
        assert_eq!(blob_id("game-a", PNG), BLOB_ID_GAME_A);
        assert_ne!(blob_id("game-b", PNG), BLOB_ID_GAME_A);
    }

    #[test]
    fn games_sharing_media_own_separate_blobs_that_survive_deletion() {
        let db = connection();
        let one = asset(&db, "one", "image/png", PNG).unwrap();
        let two = asset(&db, "two", "image/png", PNG).unwrap();
        assert_eq!(one, blob_id("one", PNG));
        assert_eq!(two, blob_id("two", PNG));
        for game in ["one", "two"] {
            let count: i64 = db
                .query_row(
                    "SELECT count(*) FROM blobs WHERE game_id=?1",
                    [game],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            assert_eq!(
                read_asset(&db, game, MEDIA_HASH).unwrap().unwrap()["data"],
                PNG
            );
        }
        db.execute("DELETE FROM games WHERE id='one'", []).unwrap();
        let rows = |table: &str, game: &str| -> i64 {
            db.query_row(
                &format!("SELECT count(*) FROM {table} WHERE game_id=?1"),
                [game],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(rows("blobs", "one"), 0);
        assert_eq!(rows("runtime_assets", "one"), 0);
        assert_eq!(rows("blobs", "two"), 1);
        assert!(read_asset(&db, "one", MEDIA_HASH).unwrap().is_none());
        assert_eq!(
            read_asset(&db, "two", MEDIA_HASH).unwrap().unwrap()["data"],
            PNG
        );
    }

    #[test]
    fn legacy_global_blob_ids_keep_reading() {
        let db = connection();
        let value =
            json!({"schemaVersion":1,"id":MEDIA_HASH,"gameId":"one","mime":"image/png","data":PNG});
        db.execute(
            "INSERT INTO blobs VALUES(?1,'one',?2)",
            params![MEDIA_HASH, value.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO runtime_assets (game_id,hash,blob_id) VALUES ('one',?1,?1)",
            [MEDIA_HASH],
        )
        .unwrap();
        assert_eq!(asset(&db, "one", "image/png", PNG).unwrap(), MEDIA_HASH);
        assert_eq!(
            read_asset(&db, "one", MEDIA_HASH).unwrap().unwrap()["data"],
            PNG
        );
    }

    #[test]
    fn projection_retains_source_and_reuses_portable_blobs() {
        let db = connection();
        let original = json!({"code":{"files":{"main.ts":{}}},"scripts":{"main":{"language":"typescript","source":"const n:number=1;","compiled":"const n=1;"}},"resources":{"icon":{"name":"icon.png","mime":"image/png","data":"data:image/png;base64,AA=="}}});
        let portable = json!({"schemaVersion":1,"id":"a".repeat(64),"gameId":"one","mime":"image/png","data":"data:image/png;base64,AA=="});
        db.execute(
            "INSERT INTO blobs VALUES(?1,'one',?2)",
            params!["a".repeat(64), portable.to_string()],
        )
        .unwrap();
        let play = project(&db, "games", "one", &original).unwrap();
        assert!(play.get("code").is_none());
        assert_eq!(play["scripts"]["main"]["source"], "");
        assert_eq!(
            play["resources"]["icon"]["data"],
            "helia-asset:".to_owned() + &"a".repeat(64)
        );
        assert_eq!(original["scripts"]["main"]["source"], "const n:number=1;");
        let count: i64 = db
            .query_row("SELECT count(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
