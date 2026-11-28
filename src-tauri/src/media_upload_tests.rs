use super::*;
use std::path::PathBuf;

struct Db(PathBuf);
impl Db {
    fn new() -> Self {
        let path = std::env::current_dir()
            .unwrap()
            .join(format!("media-test-{}.sqlite", releases::uuid().unwrap()));
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
        std::fs::remove_file(&self.0).unwrap();
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
                reason(hash_chunks(&f.connect(), &mut db, &job)),
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
