use super::*;
use std::path::PathBuf;

struct Db(PathBuf);
impl Db {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("media-test-{}", releases::uuid().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let db = super::super::open(&path).unwrap();
        db.execute("INSERT INTO games(id,value) VALUES('g','{}')", [])
            .unwrap();
        Self(path)
    }
    fn connect(&self) -> Connection {
        super::super::open(&self.0).unwrap()
    }
}
impl Drop for Db {
    fn drop(&mut self) {
        // The private directory also contains any remaining SQLite -wal and -shm files.
        std::fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
    }
}
fn new_upload(db: &mut Connection, size: i64) -> Value {
    let data = begin(
        db,
        &json!({"gameId":"g","size":size,"mime":"image/png","purpose":"edit"}),
    )
    .unwrap();
    json!({"gameId":"g","uploadId":data["uploadId"]})
}
fn packet(u: &Value, index: i64, data: &[u8]) -> Value {
    json!({"gameId":u["gameId"],"uploadId":u["uploadId"],"index":index,"sha256":sha256(data),"data":STANDARD.encode(data)})
}
fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn drain(db: &mut Connection) {
    while lifetime::step(db).unwrap() {}
}

#[test]
fn document_finish_deadline_is_fixed_and_expired_bytes_are_reclaimed() {
    let file = Db::new();
    let mut db = file.connect();
    let begun = begin(&mut db, &json!({"gameId":"g","purpose":"document","operation":"draftSave","mime":"application/json","size":2})).unwrap();
    let command = json!({"gameId":"g","uploadId":begun["uploadId"]});
    chunk(&mut db, &packet(&command, 0, b"{}")).unwrap();
    finish(&mut db, &file.0, &command).unwrap();
    let id = begun["uploadId"].as_str().unwrap();
    let remaining: f64 = db
        .query_row(
            "SELECT (julianday(expires_at)-julianday('now'))*86400 FROM media_uploads WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert!((590.0..=601.0).contains(&remaining));
    db.execute("UPDATE media_uploads SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute') WHERE id=?", [id]).unwrap();
    let (fixed, object): (String, String) = db
        .query_row(
            "SELECT expires_at,object_id FROM media_uploads WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let other = new_upload(&mut db, 1);
    chunk(&mut db, &packet(&other, 0, &[1])).unwrap();
    finish(&mut db, &file.0, &other).unwrap();
    finish(&mut db, &file.0, &command).unwrap();
    let after: String = db
        .query_row(
            "SELECT expires_at FROM media_uploads WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, fixed);
    db.execute(
        "UPDATE media_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        [id],
    )
    .unwrap();
    lifetime::expire(&mut db, false).unwrap();
    let (state, detached): (String, bool) = db
        .query_row(
            "SELECT state,object_id IS NULL FROM media_uploads WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "cancelled");
    assert!(detached);
    drain(&mut db);
    let remaining: i64 = db
        .query_row(
            "SELECT count(*) FROM media_objects WHERE id=?",
            [&object],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}
fn reason<T>(result: Result<T>) -> &'static str {
    result.err().expect("expected rejection").0
}

#[test]
fn boundary_chunks_retries_dedup_and_retained_result() {
    let f = Db::new();
    let mut db = f.connect();
    let bytes = vec![19; CHUNK as usize + 2];
    let u = new_upload(&mut db, bytes.len() as i64);
    let last = packet(&u, 1, &bytes[CHUNK as usize..]);
    chunk(&mut db, &last).unwrap();
    chunk(&mut db, &last).unwrap();
    assert_eq!(reason(finish(&mut db, &f.0, &u)), "uploadIncomplete");
    assert_eq!(
        reason(chunk(&mut db, &packet(&u, 1, b"01"))),
        "chunkConflict"
    );
    assert_eq!(reason(chunk(&mut db, &packet(&u, 1, b"0"))), "chunkInvalid");
    let mut invalid = last.clone();
    invalid["sha256"] = json!("0".repeat(64));
    assert_eq!(reason(chunk(&mut db, &invalid)), "chunkInvalid");
    chunk(&mut db, &packet(&u, 0, &bytes[..CHUNK as usize])).unwrap();
    let original = finish(&mut db, &f.0, &u).unwrap();
    assert_eq!(original["sha256"], sha256(&bytes));
    assert_eq!(
        original["blobId"],
        crate::runtime_content::blob_id(
            "g",
            &format!("data:image/png;base64,{}", STANDARD.encode(&bytes))
        )
    );
    let dup = new_upload(&mut db, bytes.len() as i64);
    for (i, data) in bytes.chunks(CHUNK as usize).enumerate() {
        chunk(&mut db, &packet(&dup, i as i64, data)).unwrap();
    }
    assert_eq!(finish(&mut db, &f.0, &dup).unwrap(), original);
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 1);
    // Simulate a response retrieved near the end of retention, through a fresh connection.
    db.execute(
        "UPDATE media_uploads SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')",
        [],
    )
    .unwrap();
    assert_eq!(finish(&mut f.connect(), &f.0, &u).unwrap(), original);
    assert_eq!(status(&mut db, &u).unwrap()["result"], original);
    assert_eq!(cancel(&mut db, &u).unwrap()["alreadyCompleted"], original);
    db.execute("UPDATE media_uploads SET expires_at='2000'", [])
        .unwrap();
    lifetime::expire(&mut db, false).unwrap();
    drain(&mut db);
    assert_eq!(reason(status(&mut db, &u)), "uploadMissing");
    assert_eq!(count(&db, "blobs"), 1);
    assert_eq!(count(&db, "media_chunks"), 2);
}
#[test]
fn ownership_purpose_lock_and_disk_full() {
    let f = Db::new();
    let mut db = f.connect();
    let u = new_upload(&mut db, CHUNK);
    let mut other = u.clone();
    other["gameId"] = json!("other");
    assert_eq!(reason(cancel(&mut db, &other)), "scopeMismatch");
    db.execute("UPDATE media_uploads SET purpose='install'", [])
        .unwrap();
    assert_eq!(reason(finish(&mut db, &f.0, &u)), "scopeMismatch");
    db.execute_batch(
        "UPDATE media_uploads SET purpose='edit';UPDATE games SET value='{\"editLock\":true}'",
    )
    .unwrap();
    let begin_req = json!({"gameId":"g","purpose":"edit","size":1,"mime":"image/png"});
    let part = packet(&u, 0, &vec![0; CHUNK as usize]);
    for r in [
        begin(&mut db, &begin_req),
        chunk(&mut db, &part),
        status(&mut db, &u),
        finish(&mut db, &f.0, &u),
        cancel(&mut db, &u),
    ] {
        assert_eq!(reason(r), "gameNotWritable");
    }
    db.execute("UPDATE games SET value='{}'", []).unwrap();
    let pages: i64 = db
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    db.pragma_update(None, "max_page_count", pages).unwrap();
    assert_eq!(reason(chunk(&mut db, &part)), "storageFull");
    assert_eq!(status(&mut db, &u).unwrap()["received"], 0);
}
#[test]
fn locked_game_takes_precedence_over_invalid_chunk() {
    let f = Db::new();
    let mut db = f.connect();
    let mut u = new_upload(&mut db, 1);
    u["index"] = json!(0);
    u["data"] = json!("invalid base64");
    db.execute("UPDATE games SET value='{\"editLock\":true}'", [])
        .unwrap();
    assert_eq!(reason(chunk(&mut db, &u)), "gameNotWritable");
}
#[test]
fn declarations_and_failed_integrity_reclaim() {
    let f = Db::new();
    let mut db = f.connect();
    let r = begin(
        &mut db,
        &json!({"purpose":"edit","gameId":"g","mime":"image/png","size":1,"sha256":"0".repeat(64)}),
    )
    .unwrap();
    let mut u = json!({"gameId":"g","uploadId":r["uploadId"],"sha256":sha256(b"x")});
    chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
    assert_eq!(reason(finish(&mut db, &f.0, &u)), "integrity");
    assert_eq!(status(&mut db, &u).unwrap()["state"], "receiving");
    assert_eq!(count(&db, "media_leases"), 0);
    u.as_object_mut().unwrap().remove("sha256");
    assert_eq!(reason(finish(&mut db, &f.0, &u)), "integrity");
    let s = status(&mut db, &u).unwrap();
    assert_eq!(s["state"], "failed");
    assert_eq!(s["error"], "integrity");
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 0);
    assert_eq!(count(&db, "media_chunks"), 0);
}
#[test]
fn cancel_interrupts_hash_after_claim_and_preserves_cancelled_state() {
    let f = Db::new();
    let mut db = f.connect();
    for state in ["receiving", "verified", "finishing"] {
        let u = new_upload(&mut db, 1);
        chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
        let job = if state == "finishing" {
            Some(start_hash(&mut db, &u).unwrap())
        } else {
            db.execute(
                "UPDATE media_uploads SET state=? WHERE id=?",
                params![state, id(&u).unwrap()],
            )
            .unwrap();
            None
        };
        if job.is_some() {
            assert_eq!(reason(finish(&mut f.connect(), &f.0, &u)), "inProgress");
        }
        cancel(&mut f.connect(), &u).unwrap();
        if let Some(job) = job {
            assert_eq!(
                reason(hash_chunks(&f.connect(), &mut db, &job, Instant::now)),
                "uploadState"
            );
        }
        assert_eq!(status(&mut db, &u).unwrap()["error"], "userCancelled");
    }
    drain(&mut db);
    for table in ["media_objects", "media_chunks", "blobs", "media_leases"] {
        assert_eq!(count(&db, table), 0);
    }
}
#[test]
fn cancel_verified_without_treating_install_as_an_edit() {
    let f = Db::new();
    let mut db = f.connect();
    let mut u = new_upload(&mut db, 1);
    chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
    db.execute_batch("UPDATE media_objects SET state='verified',game_id=NULL; UPDATE media_uploads SET scope='future',purpose='install',state='verified'").unwrap();
    u["gameId"] = json!("future");
    assert_eq!(reason(finish(&mut db, &f.0, &u)), "scopeMismatch");
    assert_eq!(status(&mut db, &u).unwrap()["state"], "verified");
    cancel(&mut db, &u).unwrap();
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 0);
}

#[test]
fn restart_cancels_all_active_states_and_collects_orphans() {
    let f = Db::new();
    let mut db = f.connect();
    let mut sessions = Vec::new();
    for state in ["receiving", "verified", "finishing"] {
        let u = new_upload(&mut db, 1);
        chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
        db.execute(
            "UPDATE media_uploads SET state=? WHERE id=?",
            params![state, id(&u).unwrap()],
        )
        .unwrap();
        sessions.push(u);
    }
    for state in ["staging", "verified", "ready"] {
        db.execute(
            "INSERT INTO media_objects VALUES(?1,?2,?1,1,1,'x',0,'now')",
            params![state, if state == "ready" { "gone" } else { "g" }],
        )
        .unwrap();
    }
    drop(db);
    let mut db = f.connect();
    lifetime::expire(&mut db, true).unwrap();
    drain(&mut db);
    for u in sessions {
        let s = status(&mut db, &u).unwrap();
        assert_eq!(s["state"], "cancelled");
        assert_eq!(s["error"], "restarted");
    }
    assert_eq!(count(&db, "media_objects"), 0);
    assert_eq!(count(&db, "media_chunks"), 0);
}
#[test]
fn scope_activity_renews_verified_and_stalled_finishing_expires() {
    let f = Db::new();
    let mut db = f.connect();
    let verified = new_upload(&mut db, 1);
    db.execute("UPDATE media_uploads SET state='verified',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')",[]).unwrap();
    let active = new_upload(&mut db, 1);
    let remaining: f64 = db
        .query_row(
            "SELECT julianday(expires_at)-julianday('now') FROM media_uploads WHERE id=?",
            [id(&verified).unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(remaining * 1440.0 > 9.9);
    db.execute(
        "UPDATE media_uploads SET state='finishing',expires_at='2000' WHERE id=?",
        [id(&active).unwrap()],
    )
    .unwrap();
    lifetime::expire(&mut db, false).unwrap();
    assert_eq!(status(&mut db, &verified).unwrap()["state"], "verified");
    assert_eq!(status(&mut db, &active).unwrap()["error"], "expired");
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 1);
}
#[test]
fn purge_preserves_active_tombstones_and_leased_bytes() {
    let f = Db::new();
    let mut db = f.connect();
    let done = new_upload(&mut db, 1);
    chunk(&mut db, &packet(&done, 0, b"x")).unwrap();
    let blob = finish(&mut db, &f.0, &done).unwrap();
    let active = new_upload(&mut db, 1);
    let verified = new_upload(&mut db, 1);
    db.execute(
        "UPDATE media_uploads SET state='verified' WHERE id=?",
        [id(&verified).unwrap()],
    )
    .unwrap();
    db.execute("UPDATE media_objects SET state='verified' WHERE id=(SELECT object_id FROM media_uploads WHERE id=?)",[id(&verified).unwrap()]).unwrap();
    db.execute_batch("INSERT INTO media_leases SELECT 'reader','g',id,'read','9999' FROM media_objects WHERE state='ready';INSERT INTO media_leases VALUES('editor','g',NULL,'editor','9999');UPDATE games SET value='{\"trashedAt\":\"today\"}'").unwrap();
    let reader = f.connect();
    let media = crate::runtime_content::open_media(&reader, "g", blob["blobId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    super::super::execute_request(&f.0, json!({"kind":"purge","gameId":"g"})).unwrap();
    assert_eq!(reason(status(&mut db, &done)), "uploadMissing");
    for u in [active, verified] {
        let s = status(&mut db, &u).unwrap();
        assert_eq!(s["state"], "cancelled");
        assert_eq!(s["error"], "gameDeleted");
    }
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 1);
    assert_eq!(count(&db, "media_leases"), 1);
    assert_eq!(media.read(0, 1).unwrap().next().unwrap().unwrap(), b"x");
    db.execute("DELETE FROM media_leases", []).unwrap();
    drain(&mut db);
    assert_eq!(count(&db, "media_objects"), 0);
    assert_eq!(count(&db, "media_chunks"), 0);
}
#[test]
fn publish_rechecks_game_and_session_after_the_last_read() {
    for change in ["purge", "trash", "editLock"] {
        let f = Db::new();
        let mut db = f.connect();
        let u = new_upload(&mut db, 1);
        chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
        let job = start_hash(&mut db, &u).unwrap();
        let digest = hash_chunks(&hash_reader(&f.0).unwrap(), &mut db, &job, Instant::now).unwrap();
        // Interleave a competing commit exactly between the last read and the publishing IMMEDIATE.
        let other = f.connect();
        let purged = change == "purge";
        let value = if change == "editLock" {
            json!({"editLock":true})
        } else {
            json!({"trashedAt":"today"})
        };
        other
            .execute("UPDATE games SET value=? WHERE id='g'", [value.to_string()])
            .unwrap();
        if purged {
            super::super::execute_request(&f.0, json!({"kind":"purge","gameId":"g"})).unwrap();
        }
        assert_eq!(
            reason(finish_hash(&mut db, &u, &job, Ok(digest))),
            if purged {
                "uploadState"
            } else {
                "gameNotWritable"
            }
        );
        let (state, object, error, result): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = db
            .query_row(
                "SELECT state,object_id,error,result FROM media_uploads WHERE id=?",
                [&job.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(state, if purged { "cancelled" } else { "finishing" });
        assert_eq!(object, if purged { None } else { job.object.clone() });
        assert_eq!(error.as_deref(), purged.then_some("gameDeleted"));
        assert!(result.is_none());
        let state: String = db
            .query_row(
                "SELECT state FROM media_objects WHERE id=?",
                [&job.object],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, if purged { "deleting" } else { "staging" });
        for table in ["media_leases", "blobs", "runtime_assets"] {
            assert_eq!(count(&db, table), 0);
        }
        drain(&mut db);
        assert_eq!(count(&db, "media_chunks"), if purged { 0 } else { 1 });
    }
}
#[test]
fn heartbeat_renews_scope_and_lease_and_retries_a_blocked_write_on_the_next_chunk() {
    for block_first in [false, true] {
        let f = Db::new();
        let mut db = f.connect();
        let _sibling = new_upload(&mut db, 1);
        let u = new_upload(&mut db, CHUNK + 1);
        chunk(&mut db, &packet(&u, 0, &vec![0; CHUNK as usize])).unwrap();
        chunk(&mut db, &packet(&u, 1, b"x")).unwrap();
        let job = start_hash(&mut db, &u).unwrap();
        // Age the persisted wall-clock deadlines, and advance the hash worker's monotonic clock.
        db.execute_batch(
            "UPDATE media_uploads SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+9 minutes');
            UPDATE media_leases SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes')",
        )
        .unwrap();
        db.busy_timeout(Duration::ZERO).unwrap();
        let other = f.connect();
        if block_first {
            other.execute_batch("BEGIN IMMEDIATE").unwrap();
        }
        let scope_renewed = || {
            count(
                &other,
                "media_uploads WHERE expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+595 seconds')",
            )
        };
        let lease_renewed = || {
            count(
                &other,
                "media_leases WHERE kind='read' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+175 seconds')",
            )
        };
        let start = Instant::now();
        let mut ticks = [0, 60, 61].into_iter();
        let hashed = hash_chunks(&hash_reader(&f.0).unwrap(), &mut db, &job, || {
            let seconds = ticks.next().unwrap();
            if seconds == 61 {
                assert_eq!(scope_renewed(), if block_first { 0 } else { 2 });
                assert_eq!(lease_renewed(), if block_first { 0 } else { 1 });
                if block_first {
                    other.execute_batch("ROLLBACK").unwrap();
                }
            }
            start + Duration::from_secs(seconds)
        });
        assert_eq!(scope_renewed(), 2);
        assert_eq!(lease_renewed(), 1);
        assert!(finish_hash(&mut db, &u, &job, hashed).is_ok());
    }
}
#[test]
fn hash_reads_retry_both_sqlite_lock_codes() {
    use rusqlite::ffi::{Error, SQLITE_BUSY, SQLITE_LOCKED};
    let mut conflicts = [SQLITE_BUSY, SQLITE_LOCKED].into_iter();
    let read = retry_busy(|| match conflicts.next() {
        Some(code) => Err(rusqlite::Error::SqliteFailure(Error::new(code), None).into()),
        None => Ok(b'x'),
    });
    assert_eq!(read.unwrap(), b'x');
}
#[test]
fn busy_hash_read_preserves_chunks_for_a_second_finish() {
    let f = Db::new();
    let mut db = f.connect();
    let u = new_upload(&mut db, 1);
    chunk(&mut db, &packet(&u, 0, b"x")).unwrap();
    let job = start_hash(&mut db, &u).unwrap();
    // In rollback-journal mode a competing EXCLUSIVE transaction blocks the separate reader.
    db.execute_batch("PRAGMA journal_mode=DELETE").unwrap();
    let reader = hash_reader(&f.0).unwrap();
    let timeout: i64 = reader
        .pragma_query_value(None, "busy_timeout", |r| r.get(0))
        .unwrap();
    assert_eq!(timeout, 5000);
    reader.busy_timeout(Duration::ZERO).unwrap();
    let other = Connection::open(&f.0).unwrap();
    other.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let hashed = hash_chunks(&reader, &mut db, &job, Instant::now);
    other.execute_batch("ROLLBACK").unwrap();
    assert_eq!(reason(finish_hash(&mut db, &u, &job, hashed)), "busy");
    assert_eq!(status(&mut db, &u).unwrap()["state"], "receiving");
    assert_eq!(count(&db, "media_leases"), 0);
    assert_eq!(count(&db, "media_chunks"), 1);
    assert_eq!(finish(&mut db, &f.0, &u).unwrap()["sha256"], sha256(b"x"));
}
#[test]
fn busy_does_not_starve_another_game() {
    let q = queue::Queue::new(2, 1);
    let a = q.acquire("a", WAIT).unwrap();
    assert_eq!(reason(q.acquire("a", Duration::from_millis(5))), "busy");
    let b = q.acquire("b", WAIT).unwrap();
    assert_eq!(reason(q.acquire("c", Duration::ZERO)), "busy");
    drop(a);
    let _c = q.acquire("c", Duration::ZERO).unwrap();
    drop(b);
}
