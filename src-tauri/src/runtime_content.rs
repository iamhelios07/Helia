//! Immutable derived execution artifacts and game-owned media; no general file access.
use crate::storage;
use base64::Engine;
use ring::digest::{SHA256, digest};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;

const ERROR: &str = "Runtime content unavailable";
pub(crate) const SCHEMA: &str = include_str!("../../src/lib/storage/runtime-content.sql");
pub(crate) const MEDIA_SCHEMA: &str = include_str!("../../src/lib/storage/media.sql");
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
pub(crate) fn valid_hash(value: &str) -> bool {
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

pub(crate) struct OpenMedia<'a> {
    pub mime: String,
    pub size: u64,
    pub etag: String,
    /// Pinned at open time, even if a later lookup would select another object.
    pub object_id: Option<String>,
    chunks: MediaChunks<'a>,
}

impl<'a> OpenMedia<'a> {
    /// Byte interval [start, end), with the original object pinned for every read.
    pub(crate) fn read(&self, start: u64, end: u64) -> Result<MediaChunks<'a>, String> {
        if start > end || end > self.size {
            return Err(ERROR.into());
        }
        let mut chunks = self.chunks.clone();
        chunks.start = start;
        chunks.end = end;
        if let Some(bytes) = chunks.inline.as_mut() {
            bytes.copy_within(start as usize..end as usize, 0);
            bytes.truncate((end - start) as usize);
        }
        Ok(chunks)
    }
}

#[derive(Clone)]
pub(crate) struct MediaChunks<'a> {
    connection: &'a Connection,
    object_id: String,
    chunk_size: u64,
    size: u64,
    start: u64,
    end: u64,
    inline: Option<Vec<u8>>,
}

impl Iterator for MediaChunks<'_> {
    type Item = Result<Vec<u8>, String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.start == self.end {
            return None;
        }
        if let Some(bytes) = self.inline.take() {
            self.start = self.end;
            return Some(Ok(bytes));
        }
        let index = self.start / self.chunk_size;
        let chunk_start = index * self.chunk_size;
        let expected = self.chunk_size.min(self.size - chunk_start);
        let result = self.connection.query_row(
            "SELECT data FROM media_chunks WHERE object_id=?1 AND idx=?2",
            params![self.object_id, index as i64],
            |row| row.get::<_, Vec<u8>>(0),
        );
        match result {
            Ok(mut bytes) if bytes.len() as u64 == expected => {
                let from = (self.start - chunk_start) as usize;
                let to = expected.min(self.end - chunk_start) as usize;
                bytes.copy_within(from..to, 0);
                bytes.truncate(to - from);
                self.start += bytes.len() as u64;
                Some(Ok(bytes))
            }
            _ => {
                self.start = self.end;
                Some(Err(ERROR.into()))
            }
        }
    }
}

/// Opens an alias or blob ID. V2 bytes are fetched only as the iterator advances.
pub(crate) fn open_media<'a>(
    connection: &'a Connection,
    game_id: &str,
    fingerprint: &str,
) -> Result<Option<OpenMedia<'a>>, String> {
    let text: Option<String> = connection.query_row(
        "SELECT value FROM blobs WHERE game_id=?1 AND id=COALESCE((SELECT blob_id FROM runtime_assets WHERE game_id=?1 AND hash=?2),?2)",
        params![game_id, fingerprint], |row| row.get(0),
    ).optional().map_err(|_| ERROR)?;
    let Some(text) = text else { return Ok(None) };
    let value: Value = serde_json::from_str(&text).map_err(|_| ERROR)?;
    if value["gameId"].as_str() != Some(game_id) {
        return Err(ERROR.into());
    }
    if !value["mime"]
        .as_str()
        .is_some_and(|mime| storage::MEDIA_MIMES.contains(&mime))
    {
        return Err(ERROR.into());
    }
    if value["schemaVersion"] == 1 {
        let asset = read_asset(connection, game_id, fingerprint)?.unwrap_or(value);
        let mime = asset["mime"].as_str().ok_or(ERROR)?.to_owned();
        let prefix = format!("data:{mime};base64,");
        let data = asset["data"]
            .as_str()
            .and_then(|data| data.strip_prefix(&prefix))
            .ok_or(ERROR)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| ERROR)?;
        return Ok(Some(OpenMedia {
            mime,
            size: bytes.len() as u64,
            etag: format!("\"{fingerprint}\""),
            object_id: None,
            chunks: MediaChunks {
                connection,
                object_id: String::new(),
                chunk_size: 0,
                size: bytes.len() as u64,
                start: 0,
                end: bytes.len() as u64,
                inline: Some(bytes),
            },
        }));
    }
    if value["schemaVersion"] != 2 || !storage::valid_blob(&value) {
        return Err(ERROR.into());
    }
    let object: Option<(String, i64, i64)> = connection.query_row(
        "SELECT id,size,chunk_size FROM media_objects WHERE game_id=?1 AND sha256=?2 AND state='ready'",
        params![game_id, value["object"].as_str().ok_or(ERROR)?],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|_| ERROR)?;
    let Some((object_id, size, chunk_size)) = object else {
        return Ok(None);
    };
    if size <= 0
        || value["size"].as_u64() != u64::try_from(size).ok()
        || chunk_size <= 0
        || chunk_size > 1_048_576
    {
        return Err(ERROR.into());
    }
    Ok(Some(OpenMedia {
        mime: value["mime"].as_str().ok_or(ERROR)?.to_owned(),
        size: size as u64,
        etag: format!("\"{fingerprint}\""),
        object_id: Some(object_id.clone()),
        chunks: MediaChunks {
            connection,
            object_id,
            chunk_size: chunk_size as u64,
            size: size as u64,
            start: 0,
            end: size as u64,
            inline: None,
        },
    }))
}
pub(crate) fn project(
    connection: &Connection,
    table: &str,
    game_id: &str,
    input: &Value,
) -> Result<Value, String> {
    let mut value = input.clone();
    if table == "blobs" {
        if input["schemaVersion"] == 2 {
            if !storage::valid_blob(input) || input["gameId"].as_str() != Some(game_id) {
                return Err(ERROR.into());
            }
            let id = input["id"].as_str().ok_or(ERROR)?;
            // SELECT avoids a dangling alias if cleanup removed the validated blob meanwhile.
            // Its stable id is still returned; a removed asset will no longer resolve.
            connection
                .execute(
                    "INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id)
                     SELECT game_id,id,id FROM blobs WHERE game_id=?1 AND id=?2",
                    params![game_id, id],
                )
                .map_err(|_| ERROR)?;
            return Ok(value);
        }
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
        if !storage::MEDIA_MIMES.contains(&mime.as_str()) {
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

    fn seed_media(db: &Connection, bytes: &[u8], object_id: &str) -> Value {
        let mut identity = crate::media_identity::MediaIdentity::new("one", "video/mp4");
        identity.update(bytes).unwrap();
        let identity = identity.digest();
        db.execute(
            "INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?1,'one','ready',?2,1048576,?3,?4,'now')",
            params![object_id, bytes.len() as i64, identity.raw, identity.crc],
        ).unwrap();
        for (index, chunk) in bytes.chunks(1_048_576).enumerate() {
            let mut chunk_identity = crate::media_identity::MediaIdentity::new("one", "video/mp4");
            chunk_identity.update(chunk).unwrap();
            db.execute(
                "INSERT INTO media_chunks VALUES(?1,?2,?3,?4)",
                params![object_id, index as i64, chunk_identity.digest().raw, chunk],
            )
            .unwrap();
        }
        let blob = json!({"schemaVersion":2,"id":identity.blob_id,"gameId":"one","mime":"video/mp4","object":identity.raw,"size":bytes.len()});
        db.execute(
            "INSERT OR REPLACE INTO blobs VALUES(?1,'one',?2)",
            params![identity.blob_id, blob.to_string()],
        )
        .unwrap();
        for hash in [&identity.asset_hash, &identity.blob_id] {
            db.execute(
                "INSERT OR REPLACE INTO runtime_assets VALUES('one',?1,?2)",
                params![hash, identity.blob_id],
            )
            .unwrap();
        }
        blob
    }

    #[test]
    fn media_v2_streams_chunk_boundaries_and_scopes_objects() {
        for size in [1_usize, 1_048_576, 1_048_577, 2_097_155] {
            let db = connection();
            let bytes: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            let blob = seed_media(&db, &bytes, "original");
            let id = blob["id"].as_str().unwrap();
            let media = open_media(&db, "one", id).unwrap().unwrap();
            assert_eq!(media.object_id.as_deref(), Some("original"));
            assert_eq!(media.mime, "video/mp4");
            assert_eq!(media.size, size as u64);
            let chunks = media.chunks.collect::<Result<Vec<_>, _>>().unwrap();
            assert_eq!(chunks.concat(), bytes);
            assert_eq!(chunks.len(), size.div_ceil(1_048_576));
            for (index, chunk) in chunks.iter().enumerate() {
                assert_eq!(chunk.len(), (size - index * 1_048_576).min(1_048_576));
            }
            assert!(open_media(&db, "two", id).unwrap().is_none());
            db.execute("UPDATE media_objects SET game_id='two'", [])
                .unwrap();
            assert!(open_media(&db, "one", id).unwrap().is_none());
            db.execute(
                "UPDATE media_objects SET game_id='one',state='verified'",
                [],
            )
            .unwrap();
            assert!(open_media(&db, "one", id).unwrap().is_none());
            db.execute("UPDATE media_objects SET state='ready',size=size+1", [])
                .unwrap();
            assert!(open_media(&db, "one", id).is_err());
        }
    }

    #[test]
    fn media_v2_pins_objects_and_does_not_block_game_purge() {
        let db = connection();
        let bytes = vec![17; 1_048_579];
        let blob = seed_media(&db, &bytes, "original");
        let id = blob["id"].as_str().unwrap();
        let media = open_media(&db, "one", id).unwrap().unwrap();
        db.execute("UPDATE media_objects SET state='deleting'", [])
            .unwrap();
        seed_media(&db, &bytes, "replacement");
        db.execute("INSERT INTO media_uploads(id,scope,purpose,mime,size,chunk_size,chunk_count,object_id,state,created_at,expires_at) VALUES('upload','one','edit','video/mp4',1,1,1,'replacement','receiving','now','later')", []).unwrap();
        db.execute(
            "INSERT INTO media_leases VALUES('read','one','original','read','later')",
            [],
        )
        .unwrap();
        assert_eq!(
            open_media(&db, "one", id)
                .unwrap()
                .unwrap()
                .object_id
                .as_deref(),
            Some("replacement")
        );
        db.execute(
            "UPDATE games SET value='{\"trashedAt\":\"2026-11-28\"}' WHERE id='one'",
            [],
        )
        .unwrap();
        storage::execute_request(&db.path, json!({"kind":"purge","gameId":"one"})).unwrap();
        assert!(open_media(&db, "one", id).unwrap().is_none());
        assert_eq!(
            media
                .chunks
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .concat(),
            bytes
        );
        let objects: i64 = db
            .query_row(
                "SELECT count(*) FROM media_objects WHERE game_id='one'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(objects, 2);
        let foreign_keys: i64 = db
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn media_v2_and_v1_reject_unsupported_mime_at_open_time() {
        let db = connection();
        let blob = seed_media(&db, &[1], "original");
        let id = blob["id"].as_str().unwrap();
        for version in [1, 2] {
            let mut unsafe_blob = blob.clone();
            unsafe_blob["schemaVersion"] = json!(version);
            unsafe_blob["mime"] = json!("text/html");
            unsafe_blob["data"] = json!("data:text/html;base64,AA==");
            db.execute(
                "UPDATE blobs SET value=?1 WHERE id=?2",
                params![unsafe_blob.to_string(), id],
            )
            .unwrap();
            assert!(open_media(&db, "one", id).is_err());
        }
    }

    #[test]
    fn media_v2_rejects_chunks_larger_than_one_mib_at_open_time() {
        let db = connection();
        let blob = seed_media(&db, &[1], "original");
        db.execute("UPDATE media_objects SET chunk_size=1048577", [])
            .unwrap();
        assert!(open_media(&db, "one", blob["id"].as_str().unwrap()).is_err());
    }

    #[test]
    fn media_v2_reads_lazily_and_fails_on_missing_or_short_chunks() {
        let db = connection();
        let blob = seed_media(&db, &vec![9; 1_048_577], "original");
        let id = blob["id"].as_str().unwrap();
        let mut media = open_media(&db, "one", id).unwrap().unwrap();
        db.execute("DELETE FROM media_chunks WHERE idx=1", [])
            .unwrap();
        assert_eq!(media.chunks.next().unwrap().unwrap().len(), 1_048_576);
        assert!(media.chunks.next().unwrap().is_err());
        assert!(media.chunks.next().is_none());
        db.execute("UPDATE media_chunks SET data=x'01' WHERE idx=0", [])
            .unwrap();
        assert!(
            open_media(&db, "one", id)
                .unwrap()
                .unwrap()
                .chunks
                .next()
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn media_v2_reads_ranges_without_loading_unrelated_chunks() {
        let db = connection();
        let bytes = vec![23; 2_097_155];
        let blob = seed_media(&db, &bytes, "original");
        let id = blob["id"].as_str().unwrap();
        let media = open_media(&db, "one", id).unwrap().unwrap();
        assert_eq!(media.etag, format!("\"{id}\""));
        for (start, end) in [
            (0, 1),
            (1_048_575, 1_048_577),
            (media.size - 1, media.size),
            (0, 0),
        ] {
            let actual = media
                .read(start, end)
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .concat();
            assert_eq!(actual, bytes[start as usize..end as usize]);
        }
        assert!(media.read(2, 1).is_err());
        assert!(media.read(0, media.size + 1).is_err());
        db.execute("DELETE FROM media_chunks WHERE idx<>1", [])
            .unwrap();
        let actual = media
            .read(1_048_576, 1_048_578)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .concat();
        assert_eq!(actual, vec![23, 23]);
    }

    #[test]
    fn media_v2_migrates_existing_sqlite_and_keeps_v1_response_bytes() {
        let db = connection();
        let id = asset(&db, "one", "image/png", PNG).unwrap();
        db.execute_batch("DROP TABLE media_uploads; DROP TABLE media_chunks; DROP TABLE media_leases; DROP TABLE media_objects;").unwrap();
        let reopened = storage::open(&db.path).unwrap();
        for table in [
            "media_objects",
            "media_chunks",
            "media_uploads",
            "media_leases",
        ] {
            let count: i64 = reopened
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
        let media = open_media(&reopened, "one", &id).unwrap().unwrap();
        assert_eq!(media.mime, "image/png");
        assert_eq!(media.size, 1);
        assert_eq!(media.object_id, None);
        assert_eq!(
            media
                .chunks
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .concat(),
            vec![0]
        );
        assert_eq!(
            read_asset(&reopened, "one", &id).unwrap().unwrap()["data"],
            PNG
        );
        let response = media_response(&db.path, &format!("/one/{id}"));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.body(), &vec![0]);
        assert!(
            media_response(&db.path, &format!("/two/{id}"))
                .status()
                .is_client_error()
        );
    }

    #[test]
    fn media_v2_schema_enforces_lifetime_and_noncascading_references() {
        let db = connection();
        seed_media(&db, &[1], "original");
        let copy = "INSERT INTO media_objects SELECT ?1,game_id,?2,size,chunk_size,sha256,crc32,created_at FROM media_objects WHERE id='original'";
        assert!(db.execute(copy, params!["duplicate", "ready"]).is_err());
        assert!(db.execute(copy, params!["staging", "staging"]).is_ok());
        assert!(
            db.execute("DELETE FROM media_objects WHERE id='original'", [])
                .is_err()
        );
        let upload = "INSERT INTO media_uploads(id,scope,purpose,mime,size,chunk_size,chunk_count,object_id,state,created_at,expires_at) VALUES(?1,'one','edit','image/png',1,1,1,?2,?3,'now','later')";
        assert!(
            db.execute(
                upload,
                params!["missing", Option::<String>::None, "receiving"]
            )
            .is_err()
        );
        assert!(
            db.execute(upload, params!["done", "original", "completed"])
                .is_err()
        );
        db.execute(upload, params!["active", "original", "receiving"])
            .unwrap();
        db.execute(
            upload,
            params!["complete", Option::<String>::None, "completed"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO media_leases VALUES('editor','not-installed',NULL,'editor','later')",
            [],
        )
        .unwrap();
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
