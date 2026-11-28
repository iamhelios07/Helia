//! Edit uploads use short IMMEDIATE transactions; the ordered hash pass holds no write lock.
use super::{MediaRequest, releases};
use crate::{
    media_identity::{MediaIdentity, MediaIdentityResult},
    runtime_content::valid_hash,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[path = "media_lifetime.rs"]
mod lifetime;
#[path = "media_queue.rs"]
mod queue;
pub(crate) use lifetime::purge;
#[cfg(feature = "desktop")]
pub(crate) use lifetime::start;
pub(super) fn wake() {
    lifetime::wake();
}
#[cfg(test)]
#[path = "media_upload_tests.rs"]
mod tests;
const CHUNK: i64 = 1048576;
const WAIT: Duration = Duration::from_secs(30);
#[derive(Debug)]
struct Failure(&'static str);
impl Failure {
    fn message(self) -> String {
        releases::packages::error(self.0)
    }
}
impl From<rusqlite::Error> for Failure {
    fn from(err: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::*;
        Self(match err.sqlite_error_code() {
            Some(DiskFull) => "storageFull",
            Some(DatabaseBusy | DatabaseLocked) => "busy",
            _ => "format",
        })
    }
}
type Result<T> = std::result::Result<T, Failure>;
fn ensure(ok: bool, code: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(Failure(code)) }
}
fn immediate(db: &mut Connection) -> Result<Transaction<'_>> {
    Ok(db.transaction_with_behavior(TransactionBehavior::Immediate)?)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or(Failure("format"))
}
fn game(v: &Value) -> Result<&str> {
    text(v, "gameId")
}
fn id(v: &Value) -> Result<&str> {
    text(v, "uploadId")
}
fn optional_hash(v: &Value) -> Result<Option<&str>> {
    v.get("sha256")
        .map(|s| {
            s.as_str()
                .filter(|s| valid_hash(s))
                .ok_or(Failure("integrity"))
        })
        .transpose()
}
fn integer(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| n.fract() == 0.0 && (0.0..=9007199254740991.0).contains(n))
        .map(|n| n as i64)
}
fn writable(db: &Connection, game: &str) -> Result<()> {
    ensure(db.query_row("SELECT EXISTS(SELECT 1 FROM games WHERE id=? AND json_extract(value,'$.trashedAt') IS NULL AND coalesce(json_type(value,'$.editLock'),'false')='false')",[game],|r|r.get(0))?,"gameNotWritable")
}
fn activity(db: &Connection, game: &str) -> Result<()> {
    db.execute("UPDATE media_uploads SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') WHERE scope=? AND object_id IS NOT NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",[game])?;
    Ok(())
}
struct Upload {
    id: String,
    scope: String,
    purpose: String,
    state: String,
    mime: String,
    size: i64,
    count: i64,
    object: Option<String>,
    generation: i64,
    declared: Option<String>,
    expires: String,
    result: Option<String>,
    error: Option<String>,
    expired: bool,
}
impl Upload {
    fn result(&self) -> Result<Value> {
        serde_json::from_str(self.result.as_deref().ok_or(Failure("uploadState"))?)
            .map_err(|_| Failure("uploadState"))
    }
}
fn check_owner(db: &Connection, u: &Upload) -> Result<()> {
    if matches!(u.purpose.as_str(), "install" | "package-content") {
        if u.object.is_some() {
            ensure(
                !db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM games WHERE id=?)",
                    [&u.scope],
                    |r| r.get::<_, bool>(0),
                )?,
                "gameNotWritable",
            )?;
        }
        return Ok(());
    }
    writable(db, &u.scope)
}
fn lookup(db: &Connection, v: &Value, edit_only: bool) -> Result<Option<Upload>> {
    let id = id(v)?;
    let u = db
        .query_row(
            "SELECT scope,purpose,state,mime,size,chunk_count,object_id,generation,declared_sha256,
                expires_at,result,error,expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM media_uploads WHERE id=?",
            [id],
            |r| {
                Ok(Upload {
                    id: id.into(),
                    scope: r.get(0)?,
                    purpose: r.get(1)?,
                    state: r.get(2)?,
                    mime: r.get(3)?,
                    size: r.get(4)?,
                    count: r.get(5)?,
                    object: r.get(6)?,
                    generation: r.get(7)?,
                    declared: r.get(8)?,
                    expires: r.get(9)?,
                    result: r.get(10)?,
                    error: r.get(11)?,
                    expired: r.get(12)?,
                })
            },
        )
        .optional()?;
    if let Some(u) = &u {
        ensure(
            u.scope == game(v)? && (!edit_only || u.purpose == "edit"),
            "scopeMismatch",
        )?;
        if u.expired {
            if u.object.is_none() {
                return Ok(None);
            }
            lifetime::end(db, id, "cancelled", "expired")?;
            wake();
            return lookup(db, v, edit_only);
        }
        if u.error.as_deref() != Some("gameDeleted") {
            check_owner(db, u)?;
        }
    }
    Ok(u)
}
fn session(db: &Connection, v: &Value) -> Result<Upload> {
    lookup(db, v, true)?.ok_or(Failure("uploadMissing"))
}
fn begin(db: &mut Connection, v: &Value) -> Result<Value> {
    let g = game(v)?;
    ensure(
        v["purpose"] == "edit" && v.get("operation").is_none(),
        "scopeMismatch",
    )?;
    let mime = v["mime"]
        .as_str()
        .filter(|m| super::MEDIA_MIMES.contains(m))
        .ok_or(Failure("mediaType"))?;
    let size = integer(&v["size"])
        .filter(|n| *n > 0)
        .ok_or(Failure("mediaSize"))?;
    let declared = optional_hash(v)?;
    let label = v
        .get("label")
        .map(|l| {
            l.as_str()
                .filter(|s| s.encode_utf16().count() <= 200)
                .ok_or(Failure("format"))
        })
        .transpose()?;
    let tx = immediate(db)?;
    writable(&tx, g)?;
    activity(&tx, g)?;
    let id = releases::uuid().map_err(|_| Failure("format"))?;
    let object = releases::uuid().map_err(|_| Failure("format"))?;
    let count = (size + CHUNK - 1) / CHUNK;
    tx.execute("INSERT INTO media_objects(id,game_id,state,size,chunk_size,created_at) VALUES(?,?,'staging',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![object,g,size,CHUNK])?;
    let expires: String = tx.query_row(
        "INSERT INTO media_uploads(id,scope,purpose,mime,label,size,chunk_size,chunk_count,object_id,
            state,declared_sha256,created_at,expires_at)
         VALUES(?,?,'edit',?,?,?,?,?,?,'receiving',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')) RETURNING expires_at",
        params![id,g,mime,label,size,CHUNK,count,object,declared], |r| r.get(0)
    )?;
    tx.commit()?;
    Ok(json!({"uploadId":id,"chunkSize":CHUNK,"chunkCount":count,"expiresAt":expires}))
}
fn sha256(data: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, data)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn chunk(db: &mut Connection, v: &Value) -> Result<Value> {
    let _permit = queue::WRITES.acquire(game(v)?, WAIT)?;
    let index = integer(&v["index"]).ok_or(Failure("chunkInvalid"))?;
    let sha = v["sha256"]
        .as_str()
        .filter(|s| valid_hash(s))
        .ok_or(Failure("chunkInvalid"))?;
    let encoded = v["data"]
        .as_str()
        .filter(|s| s.len() <= 4 * (CHUNK as usize).div_ceil(3))
        .ok_or(Failure("chunkInvalid"))?;
    let data = STANDARD
        .decode(encoded)
        .map_err(|_| Failure("chunkInvalid"))?;
    ensure(sha256(&data) == sha, "chunkInvalid")?;
    let tx = immediate(db)?;
    let u = session(&tx, v)?;
    ensure(u.state == "receiving", "uploadState")?;
    ensure(
        index < u.count && data.len() as i64 == CHUNK.min(u.size - index * CHUNK),
        "chunkInvalid",
    )?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT sha256 FROM media_chunks WHERE object_id=? AND idx=?",
            params![u.object, index],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        ensure(existing == sha, "chunkConflict")?;
    } else {
        tx.execute(
            "INSERT INTO media_chunks VALUES(?,?,?,?)",
            params![u.object, index, sha, data],
        )?;
        tx.execute(
            "UPDATE media_uploads SET generation=generation+1 WHERE id=?",
            [&u.id],
        )?;
    }
    activity(&tx, &u.scope)?;
    tx.commit()?;
    Ok(json!({"received":index}))
}
fn received(db: &Connection, u: &Upload) -> Result<i64> {
    Ok(db.query_row(
        "SELECT count(*) FROM media_chunks WHERE object_id=?",
        [&u.object],
        |r| r.get(0),
    )?)
}
fn status(db: &mut Connection, v: &Value) -> Result<Value> {
    let tx = immediate(db)?;
    let u = lookup(&tx, v, false)?.ok_or(Failure("uploadMissing"))?;
    let mut value = json!({"state":u.state,"expiresAt":u.expires,"received":if u.object.is_some(){received(&tx,&u)?}else{u.generation}});
    if u.result.is_some() {
        value["result"] = u.result()?;
    }
    if let Some(reason) = u.error {
        value["error"] = json!(reason);
    }
    tx.commit()?;
    Ok(value)
}
fn cancel(db: &mut Connection, v: &Value) -> Result<Value> {
    let tx = immediate(db)?;
    if let Some(u) = lookup(&tx, v, false)? {
        if u.state == "completed" || u.state == "consumed" {
            return Ok(json!({"alreadyCompleted":u.result()?}));
        }
        if u.object.is_some() {
            lifetime::end(&tx, &u.id, "cancelled", "userCancelled")?;
        }
    }
    tx.commit()?;
    wake();
    Ok(json!({"cancelled":true}))
}
fn finishable(db: &Connection, v: &Value) -> Result<Upload> {
    let mut u = session(db, v)?;
    if u.state == "completed" {
        return Ok(u);
    }
    ensure(u.state != "finishing", "inProgress")?;
    ensure(u.state == "receiving", "uploadState")?;
    if let Some(finish) = optional_hash(v)? {
        ensure(u.declared.as_ref().is_none_or(|s| s == finish), "integrity")?;
        u.declared = Some(finish.into());
    }
    ensure(received(db, &u)? == u.count, "uploadIncomplete")?;
    Ok(u)
}
fn start_hash(db: &mut Connection, v: &Value) -> Result<Upload> {
    let tx = immediate(db)?;
    let u = finishable(&tx, v)?;
    if u.state != "completed" {
        tx.execute(
            "UPDATE media_uploads SET state='finishing',declared_sha256=? WHERE id=?",
            params![u.declared, u.id],
        )?;
        tx.execute("INSERT INTO media_leases VALUES(?,?,?,'read',strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes'))",params![u.id,u.scope,u.object])?;
        activity(&tx, &u.scope)?;
    }
    tx.commit()?;
    Ok(u)
}
fn hash_chunks(
    reader: &Connection,
    db: &mut Connection,
    u: &Upload,
) -> Result<MediaIdentityResult> {
    let mut identity = MediaIdentity::new(&u.scope, &u.mime);
    let mut statement=reader.prepare("SELECT data FROM media_uploads u JOIN media_chunks c ON c.object_id=u.object_id WHERE u.id=? AND u.state='finishing' AND c.idx=?")?;
    let mut renewed = Instant::now();
    for i in 0..u.count {
        let data: Vec<u8> = statement
            .query_row(params![u.id, i], |r| r.get(0))
            .optional()?
            .ok_or(Failure("uploadState"))?;
        identity.update(&data).map_err(|_| Failure("integrity"))?;
        if renewed.elapsed() >= Duration::from_secs(60) {
            let tx = immediate(db)?;
            activity(&tx, &u.scope)?;
            tx.execute("UPDATE media_leases SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes') WHERE id=?",[&u.id])?;
            tx.commit()?;
            renewed = Instant::now();
        }
    }
    let hash = identity.digest();
    ensure(
        u.declared.as_ref().is_none_or(|s| s == &hash.raw),
        "integrity",
    )?;
    Ok(hash)
}
fn publish(db: &mut Connection, v: &Value, u: &Upload, hash: MediaIdentityResult) -> Result<Value> {
    let tx = immediate(db)?;
    let current = session(&tx, v)?;
    ensure(
        current.state == "finishing" && current.generation == u.generation,
        "uploadState",
    )?;
    let duplicate: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_objects WHERE state='ready' AND game_id=? AND sha256=?)",
        params![u.scope, hash.raw],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE media_objects SET state=?,sha256=?,crc32=? WHERE id=?",
        params![
            if duplicate { "deleting" } else { "ready" },
            hash.raw,
            hash.crc,
            u.object
        ],
    )?;
    let blob = json!({"schemaVersion":2,"id":hash.blob_id,"gameId":u.scope,"mime":u.mime,"object":hash.raw,"size":u.size});
    tx.execute(
        "INSERT OR IGNORE INTO blobs(id,game_id,value) VALUES(?,?,?)",
        params![hash.blob_id, u.scope, blob.to_string()],
    )?;
    for alias in [&hash.asset_hash, &hash.blob_id] {
        tx.execute(
            "INSERT OR IGNORE INTO runtime_assets(game_id,hash,blob_id) VALUES(?,?,?)",
            params![u.scope, alias, hash.blob_id],
        )?;
    }
    let result = json!({"kind":"blob","blobId":hash.blob_id,"sha256":hash.raw,"assetHash":hash.asset_hash,"size":u.size,"mime":u.mime});
    tx.execute("UPDATE media_uploads SET state='completed',result=?,object_id=NULL,expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE id=?",params![result.to_string(),u.id])?;
    tx.execute("DELETE FROM media_leases WHERE id=?", [&u.id])?;
    tx.commit()?;
    Ok(result)
}
fn finish(db: &mut Connection, path: &Path, v: &Value) -> Result<Value> {
    {
        let tx = immediate(db)?;
        let before = finishable(&tx, v)?;
        activity(&tx, &before.scope)?;
        tx.commit()?;
        if before.state == "completed" {
            return before.result();
        }
    }
    let _permit = queue::HASHES.acquire(game(v)?, WAIT)?;
    let u = start_hash(db, v)?;
    if u.state == "completed" {
        return u.result();
    }
    let hashed = (|| {
        let reader = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        reader.pragma_update(None, "foreign_keys", true)?;
        hash_chunks(&reader, db, &u)
    })();
    let result = match hashed {
        Ok(hash) => publish(db, v, &u, hash),
        Err(failure) => {
            let tx = immediate(db)?;
            let active: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM media_uploads WHERE id=? AND state='finishing')",
                [&u.id],
                |r| r.get(0),
            )?;
            if active {
                lifetime::end(&tx, &u.id, "failed", failure.0)?;
            }
            tx.commit()?;
            Err(failure)
        }
    };
    if result.is_err() {
        db.execute("DELETE FROM media_leases WHERE id=?", [&u.id])?;
    }
    wake();
    result
}
pub(super) fn request(path: &Path, request: MediaRequest) -> std::result::Result<Value, String> {
    // Application setup owns migrations. A chunk should never rescan/migrate all games.
    let mut db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .and_then(|db| {
            db.busy_timeout(Duration::from_secs(5))?;
            db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
            Ok(db)
        })
        .map_err(|error| Failure::from(error).message())?;
    match request {
        MediaRequest::MediaUploadBegin(v) => begin(&mut db, &v),
        MediaRequest::MediaUploadChunk(v) => chunk(&mut db, &v),
        MediaRequest::MediaUploadStatus(v) => status(&mut db, &v),
        MediaRequest::MediaUploadFinish(v) => finish(&mut db, path, &v),
        MediaRequest::MediaUploadCancel(v) => cancel(&mut db, &v),
    }
    .map_err(Failure::message)
}
