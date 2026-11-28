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
    operation: Option<String>,
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
                operation,expires_at,result,error,expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
                    operation: r.get(9)?,
                    expires: r.get(10)?,
                    result: r.get(11)?,
                    error: r.get(12)?,
                    expired: r.get(13)?,
                })
            },
        )
        .optional()?;
    if let Some(u) = &u {
        ensure(
            u.scope == game(v)? && (!edit_only || u.purpose == "edit" || u.purpose == "document"),
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
    let size = integer(&v["size"])
        .filter(|n| *n > 0)
        .ok_or(Failure("mediaSize"))?;
    let purpose = v["purpose"].as_str().ok_or(Failure("scopeMismatch"))?;
    let operation = v.get("operation").and_then(Value::as_str);
    let mime = match purpose {
        "edit" => {
            ensure(operation.is_none(), "scopeMismatch")?;
            v["mime"]
                .as_str()
                .filter(|m| super::MEDIA_MIMES.contains(m))
                .ok_or(Failure("mediaType"))?
        }
        "document" => {
            let limit = operation
                .and_then(super::document_operation_limit)
                .ok_or(Failure("scopeMismatch"))?;
            ensure(v["mime"] == "application/json", "mediaType")?;
            ensure(size as u64 <= limit, "mediaSize")?;
            v["mime"].as_str().ok_or(Failure("mediaType"))?
        }
        _ => return Err(Failure("scopeMismatch")),
    };
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
        "INSERT INTO media_uploads(id,scope,purpose,mime,label,operation,size,chunk_size,chunk_count,object_id,
            state,declared_sha256,created_at,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,'receiving',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')) RETURNING expires_at",
        params![id,g,purpose,mime,label,operation,size,CHUNK,count,object,declared], |r| r.get(0)
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
fn receiving(db: &Connection, v: &Value) -> Result<Upload> {
    let u = session(db, v)?;
    ensure(u.state == "receiving", "uploadState")?;
    Ok(u)
}
fn chunk(db: &mut Connection, v: &Value) -> Result<Value> {
    let _permit = queue::WRITES.acquire(game(v)?, WAIT)?;
    let u = {
        let tx = immediate(db)?;
        let u = receiving(&tx, v)?;
        tx.commit()?;
        u
    };
    let index = integer(&v["index"])
        .filter(|i| *i < u.count)
        .ok_or(Failure("chunkInvalid"))?;
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
    ensure(
        data.len() as i64 == CHUNK.min(u.size - index * CHUNK) && sha256(&data) == sha,
        "chunkInvalid",
    )?;
    // Decode and hash outside the writer; Cancel, purge or a lock may have won meanwhile.
    let tx = immediate(db)?;
    let u = receiving(&tx, v)?;
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
    if u.state == "completed" || (u.state == "verified" && u.result.is_some()) {
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
fn retry_busy<T>(mut work: impl FnMut() -> Result<T>) -> Result<T> {
    for delay in [10, 20, 40] {
        match work() {
            Err(Failure("busy")) => std::thread::sleep(Duration::from_millis(delay)),
            result => return result,
        }
    }
    work()
}
fn hash_reader(path: &Path) -> Result<Connection> {
    let reader = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    reader.busy_timeout(Duration::from_secs(5))?;
    reader.pragma_update(None, "foreign_keys", true)?;
    Ok(reader)
}
fn renew_hash(db: &mut Connection, u: &Upload) -> Result<()> {
    let tx = immediate(db)?;
    // A previous heartbeat may have missed the shorter lease TTL. Reacquire only for a live job.
    let live = tx.execute("INSERT OR REPLACE INTO media_leases
        SELECT id,scope,object_id,'read',strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes')
        FROM media_uploads WHERE id=? AND state='finishing' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')", [&u.id])?;
    ensure(live == 1, "uploadState")?;
    activity(&tx, &u.scope)?;
    tx.commit()?;
    Ok(())
}
fn hash_chunks(
    reader: &Connection,
    db: &mut Connection,
    u: &Upload,
    mut now: impl FnMut() -> Instant,
) -> Result<MediaIdentityResult> {
    let mut identity = MediaIdentity::new(&u.scope, &u.mime);
    let mut statement = retry_busy(|| {
        Ok(reader.prepare("SELECT data FROM media_uploads u JOIN media_chunks c ON c.object_id=u.object_id WHERE u.id=? AND u.state='finishing' AND c.idx=?")?)
    })?;
    let mut renewed = now();
    for i in 0..u.count {
        let data: Vec<u8> = retry_busy(|| {
            Ok(statement
                .query_row(params![u.id, i], |r| r.get(0))
                .optional()?)
        })?
        .ok_or(Failure("uploadState"))?;
        identity.update(&data).map_err(|_| Failure("integrity"))?;
        let tick = now();
        let elapsed = tick.duration_since(renewed);
        if elapsed >= Duration::from_secs(60) {
            match renew_hash(db, u) {
                Ok(()) => renewed = tick,
                Err(Failure("uploadState")) => return Err(Failure("uploadState")),
                Err(error) if elapsed >= Duration::from_secs(600) => return Err(error),
                Err(_) => {} // Still due: retry after the next chunk, without rehashing any bytes.
            }
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
/// A document upload only confirms verification; its bytes never become a blob (§3.9).
fn publish_document(
    db: &mut Connection,
    v: &Value,
    u: &Upload,
    hash: MediaIdentityResult,
) -> Result<Value> {
    let tx = immediate(db)?;
    let current = session(&tx, v)?;
    ensure(
        current.state == "finishing" && current.generation == u.generation,
        "uploadState",
    )?;
    tx.execute(
        "UPDATE media_objects SET state='verified',sha256=?,crc32=? WHERE id=?",
        params![hash.raw, hash.crc, u.object],
    )?;
    let result = json!({"kind":"upload","ref":format!("helia-upload:{}",u.id),"sha256":hash.raw,"size":u.size,"mime":u.mime,"crc32":hash.crc});
    tx.execute("UPDATE media_uploads SET state='verified',result=?,expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') WHERE id=?",params![result.to_string(),u.id])?;
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
    let hashed = retry_busy(|| hash_reader(path))
        .and_then(|reader| hash_chunks(&reader, db, &u, Instant::now));
    finish_hash(db, v, &u, hashed)
}
/// Release the claim without losing bytes on host errors. Only definitive hash failures detach
/// the object, and only if another operation hasn't already ended this session.
fn abandon_hash(tx: &Transaction, id: &str, error: &Failure) -> Result<()> {
    if !matches!(error.0, "integrity" | "uploadState") {
        tx.execute(
            "UPDATE media_uploads SET state='receiving' WHERE id=? AND state='finishing'",
            [id],
        )?;
        return Ok(());
    }
    let expired: Option<bool> = tx.query_row(
        "SELECT expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM media_uploads WHERE id=? AND state='finishing'",
        [id], |r| r.get(0),
    ).optional()?;
    match expired {
        Some(true) => lifetime::end(tx, id, "cancelled", "expired"),
        Some(false) => lifetime::end(tx, id, "failed", error.0),
        None => Ok(()),
    }
}
fn finish_hash(
    db: &mut Connection,
    v: &Value,
    u: &Upload,
    hashed: Result<MediaIdentityResult>,
) -> Result<Value> {
    let hash_failed = hashed.is_err();
    let result = hashed.and_then(|hash| {
        if u.purpose == "document" {
            publish_document(db, v, u, hash)
        } else {
            publish(db, v, u, hash)
        }
    });
    if let Err(error) = &result {
        retry_busy(|| {
            let tx = immediate(db)?;
            // A publish guard failure leaves the session as-is. A busy writer is retryable.
            if hash_failed || error.0 == "busy" {
                abandon_hash(&tx, &u.id, error)?;
            }
            tx.execute("DELETE FROM media_leases WHERE id=?", [&u.id])?;
            tx.commit()?;
            Ok(())
        })?;
    }
    wake();
    result
}
pub(super) fn request(path: &Path, request: MediaRequest) -> std::result::Result<Value, String> {
    // Application setup owns migrations. A chunk should never rescan/migrate all games.
    let mut db = open_raw(path).map_err(Failure::message)?;
    match request {
        MediaRequest::MediaUploadBegin(v) => begin(&mut db, &v),
        MediaRequest::MediaUploadChunk(v) => chunk(&mut db, &v),
        MediaRequest::MediaUploadStatus(v) => status(&mut db, &v),
        MediaRequest::MediaUploadFinish(v) => finish(&mut db, path, &v),
        MediaRequest::MediaUploadCancel(v) => cancel(&mut db, &v),
    }
    .map_err(Failure::message)
}
fn open_raw(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    Ok(db)
}

/// Identifies a verified document session whose bytes a processing request is about to use.
pub(crate) struct DocumentClaim {
    pub id: String,
    pub game: String,
    pub operation: String,
    pub generation: i64,
}
fn document_operation(kind: &str, action: Option<&str>) -> Option<&'static str> {
    match kind {
        "writeDraft" => Some("draftSave"),
        "commit" | "create" => Some("commit"),
        "versioning" if action == Some("release") => Some("releaseCreate"),
        _ => None,
    }
}
/// Replaces a `bodyRef` stub with its uploaded request body, binding operation and game (§3.9).
pub(crate) fn resolve_body_ref(
    path: &Path,
    command: &Value,
) -> std::result::Result<Option<(Value, DocumentClaim)>, String> {
    resolve_body_ref_inner(path, command).map_err(Failure::message)
}
fn resolve_body_ref_inner(path: &Path, command: &Value) -> Result<Option<(Value, DocumentClaim)>> {
    let Some(reference) = command.get("bodyRef").and_then(Value::as_str) else {
        return Ok(None);
    };
    let kind = command["kind"].as_str().ok_or(Failure("scopeMismatch"))?;
    let action = command.get("action").and_then(Value::as_str);
    let operation = document_operation(kind, action).ok_or(Failure("scopeMismatch"))?;
    let game = command["gameId"].as_str().ok_or(Failure("scopeMismatch"))?;
    let (text, claim) = read_document(path, game, reference, operation)?;
    let resolved: Value = serde_json::from_str(&text).map_err(|_| Failure("format"))?;
    ensure(
        resolved["kind"] == kind && resolved["gameId"] == game,
        "scopeMismatch",
    )?;
    Ok(Some((resolved, claim)))
}
/// Reads a verified document body within its operation budget for a processing request.
fn read_document(
    path: &Path,
    game: &str,
    reference: &str,
    operation: &str,
) -> Result<(String, DocumentClaim)> {
    let id = reference
        .strip_prefix("helia-upload:")
        .filter(|s| !s.is_empty())
        .ok_or(Failure("format"))?;
    let mut db = open_raw(path)?;
    let u = {
        let tx = immediate(&mut db)?;
        let u = lookup(&tx, &json!({"gameId":game,"uploadId":id}), false)?
            .ok_or(Failure("uploadMissing"))?;
        ensure(
            u.purpose == "document" && u.operation.as_deref() == Some(operation),
            "scopeMismatch",
        )?;
        ensure(u.state == "verified", "uploadState")?;
        tx.commit()?;
        u
    };
    let mut bytes = Vec::with_capacity(u.size as usize);
    {
        let mut statement =
            db.prepare("SELECT data FROM media_chunks WHERE object_id=? AND idx=?")?;
        for i in 0..u.count {
            let part: Vec<u8> = statement
                .query_row(params![u.object, i], |r| r.get(0))
                .optional()?
                .ok_or(Failure("uploadState"))?;
            bytes.extend_from_slice(&part);
        }
    }
    ensure(bytes.len() as i64 == u.size, "uploadState")?;
    let text = String::from_utf8(bytes).map_err(|_| Failure("format"))?;
    Ok((
        text,
        DocumentClaim {
            id: u.id,
            game: game.to_owned(),
            operation: operation.to_owned(),
            generation: u.generation,
        },
    ))
}
/// Marks the document consumed and its bytes deleting. The caller holds the write transaction.
pub(crate) fn consume_document(
    db: &Connection,
    claim: &DocumentClaim,
) -> std::result::Result<(), String> {
    consume_document_inner(db, claim).map_err(Failure::message)
}
fn consume_document_inner(db: &Connection, claim: &DocumentClaim) -> Result<()> {
    let row: Option<(String, i64, Option<String>, String, Option<String>)> = db
        .query_row(
            "SELECT state,generation,object_id,scope,operation FROM media_uploads WHERE id=?",
            [&claim.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let (state, generation, object, scope, operation) = row.ok_or(Failure("uploadState"))?;
    ensure(
        state == "verified"
            && generation == claim.generation
            && object.is_some()
            && scope == claim.game
            && operation.as_deref() == Some(claim.operation.as_str()),
        "uploadState",
    )?;
    db.execute(
        "UPDATE media_objects SET state='deleting' WHERE id=?",
        [&object],
    )?;
    db.execute("UPDATE media_uploads SET state='consumed',object_id=NULL,expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE id=?",[&claim.id])?;
    Ok(())
}
