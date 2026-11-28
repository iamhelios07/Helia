use super::{Fixture, game, media_uploads, open};
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::digest::{SHA256, digest};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn run(file: &Fixture) -> Value {
    file.request(json!({"kind":"cleanStorage"})).unwrap()["storageCleanup"].clone()
}

fn upload(file: &Fixture, game: &str, mime: &str, seed: u8) -> (Value, Value) {
    let bytes = [seed, 2, 3];
    let started = file.request(json!({"kind":"mediaUploadBegin","gameId":game,"purpose":"edit","mime":mime,"size":bytes.len()})).unwrap();
    let id = &started["uploadId"];
    let sha = digest(&SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    file.request(json!({"kind":"mediaUploadChunk","gameId":game,"uploadId":id,"index":0,"sha256":sha,"data":STANDARD.encode(bytes)})).unwrap();
    let result = file
        .request(json!({"kind":"mediaUploadFinish","gameId":game,"uploadId":id}))
        .unwrap();
    assert_eq!(result["kind"], "blob");
    (result, id.clone())
}

fn game_row(db: &Connection, id: &str) {
    db.execute("INSERT INTO games(id,value) VALUES(?,'{}')", [id])
        .unwrap();
}
fn draft_row(db: &Connection, game: &str, value: &str) {
    db.execute("INSERT INTO editor_drafts VALUES(?,1,?)", [game, value])
        .unwrap();
}
fn scalar<T: rusqlite::types::FromSql>(db: &Connection, sql: &str) -> T {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}
fn count(db: &Connection, table: &str) -> i64 {
    scalar(db, &format!("SELECT count(*) FROM {table}"))
}
fn has_blob(db: &Connection, id: &Value) -> bool {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=?)",
        [id.as_str().unwrap()],
        |r| r.get(0),
    )
    .unwrap()
}
fn resources(result: &Value) -> Value {
    json!({"asset":{"name":"image.png","mime":"image/png","data":format!("helia-asset:{}",result["blobId"].as_str().unwrap())}})
}
fn set_game_resources(db: &Connection, assets: &Value) {
    db.execute(
        "UPDATE games SET value=? WHERE id='g'",
        [json!({"resources":assets}).to_string()],
    )
    .unwrap();
}
fn expired(db: &Connection) {
    db.execute("UPDATE media_uploads SET expires_at='2000'", [])
        .unwrap();
}
fn totals(
    files: u64,
    blobs: u64,
    objects: u64,
    bytes: &str,
    editing: u64,
    unreadable: u64,
) -> Value {
    json!({"cleanedFiles":files,"removedBlobs":blobs,"queuedObjects":objects,"reclaimableBytes":bytes,
        "skippedEditing":editing,"skippedUnreadable":unreadable,"skippedFailed":0})
}

#[test]
fn protects_each_root_in_isolation() {
    for root in ["game", "base", "assets", "snapshot", "release"] {
        let file = Fixture::new();
        let db = open(&file.0).unwrap();
        assert_eq!(scalar::<i64>(&db, "PRAGMA foreign_keys"), 1);
        game_row(&db, "g");
        let (kept, _) = upload(&file, "g", "image/png", 1);
        let (unused, _) = upload(&file, "g", "image/png", 4);
        expired(&db);
        let assets = resources(&kept);
        match root {
            "game" => set_game_resources(&db, &assets),
            "base" => draft_row(
                &db,
                "g",
                &json!({"baseContent":{"resources":assets},"documents":{"assets":"{}"}})
                    .to_string(),
            ),
            "assets" => draft_row(
                &db,
                "g",
                &json!({"baseContent":{},"documents":{"assets":assets.to_string()}}).to_string(),
            ),
            "snapshot" => {
                db.execute(
                    "INSERT INTO snapshot_resources VALUES('s','g','snap',?)",
                    [json!({"blobId":kept["blobId"]}).to_string()],
                )
                .unwrap();
            }
            "release" => {
                db.execute(
                    "INSERT INTO game_releases VALUES('r','g','g','1.0.0','digest','today',?)",
                    [json!({"resources":assets}).to_string()],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(run(&file), totals(1, 1, 1, "3", 0, 0), "{root}");
        assert!(has_blob(&db, &kept["blobId"]));
        assert!(!has_blob(&db, &unused["blobId"]));
        assert_eq!(count(&db, "runtime_assets"), 2);
    }
}

fn lease(file: &Fixture, game: &str, id: &str, action: &str) -> Result<Value, String> {
    file.request(json!({"kind":"editorLease","gameId":game,"leaseId":id,"action":action}))
}

#[test]
fn skips_unreadable_and_editing_games_and_rolls_back_a_failing_game_only() {
    let file = Fixture::new();
    let db = open(&file.0).unwrap();
    for name in [
        "a-draft",
        "b-assets",
        "c-scheme",
        "d-edit",
        "e-failure",
        "f-good",
        "g-invalid",
    ] {
        game_row(&db, name);
        upload(&file, name, "image/png", 1);
    }
    expired(&db);
    draft_row(&db, "a-draft", "{");
    draft_row(
        &db,
        "b-assets",
        &json!({"baseContent":{},"documents":{"assets":"{"}}).to_string(),
    );
    db.execute(
        "UPDATE games SET value=? WHERE id='c-scheme'",
        [json!({"resources":{"bad":{"data":"helia-asset:unknown-id"}}}).to_string()],
    )
    .unwrap();
    db.execute_batch(
        "CREATE TRIGGER stop_delete BEFORE UPDATE ON media_objects WHEN OLD.game_id='e-failure'
        BEGIN SELECT RAISE(ABORT, 'fixture failure after alias and blob deletion'); END;
        PRAGMA ignore_check_constraints=ON;
        UPDATE games SET value='{' WHERE id='g-invalid';
        PRAGMA ignore_check_constraints=OFF;",
    )
    .unwrap();
    let id = "a".repeat(32);
    lease(&file, "d-edit", &id, "renew").unwrap();
    let mut expected = totals(1, 1, 1, "3", 1, 4);
    expected["skippedFailed"] = json!(1);
    assert_eq!(run(&file), expected);
    assert_eq!(
        scalar::<String>(
            &db,
            "SELECT group_concat(game_id) FROM (SELECT game_id FROM blobs ORDER BY game_id)"
        ),
        "a-draft,b-assets,c-scheme,d-edit,e-failure,g-invalid"
    );
    assert_eq!(count(&db, "runtime_assets"), 12);
    lease(&file, "d-edit", &id, "release").unwrap();
    expected["skippedEditing"] = json!(0);
    assert_eq!(run(&file), expected);
}

#[test]
fn preserves_shared_and_read_leased_objects_and_v1() {
    let file = Fixture::new();
    let mut db = open(&file.0).unwrap();
    game_row(&db, "g");
    let (kept, _) = upload(&file, "g", "image/png", 1);
    let (other_mime, _) = upload(&file, "g", "image/jpeg", 1);
    let (read, _) = upload(&file, "g", "image/png", 5);
    let id: String = db
        .query_row(
            "SELECT id FROM media_objects WHERE sha256=? AND state='ready'",
            [read["sha256"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    db.execute(
        "INSERT INTO media_leases VALUES('read','g',?,'read','9999')",
        [&id],
    )
    .unwrap();
    set_game_resources(&db, &resources(&kept));
    expired(&db);
    db.execute_batch(
        "INSERT INTO blobs VALUES('legacy','g','{\"schemaVersion\":1}');
        INSERT INTO runtime_assets VALUES('g','legacy','legacy');",
    )
    .unwrap();
    assert_eq!(run(&file), totals(2, 2, 0, "0", 0, 0));
    assert!(has_blob(&db, &kept["blobId"]));
    assert!(!has_blob(&db, &other_mime["blobId"]));
    assert!(!has_blob(&db, &read["blobId"]));
    assert!(has_blob(&db, &json!("legacy")));
    assert_eq!(count(&db, "runtime_assets"), 3);
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT count(*) FROM media_objects WHERE state='ready'"
        ),
        2
    );
    db.execute("UPDATE media_leases SET expires_at='2000'", [])
        .unwrap();
    media_uploads::expire_for_test(&mut db, false);
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT count(*) FROM media_objects WHERE state='ready'"
        ),
        2
    );
    assert_eq!(run(&file), totals(1, 0, 1, "3", 0, 0));
}

#[test]
fn completed_results_are_retained_and_normal_lifecycle_never_sweeps_blobs() {
    let file = Fixture::new();
    file.create();
    let (result, upload_id) = upload(&file, "game", "image/png", 1);
    let blob = &result["blobId"];
    let mut db = open(&file.0).unwrap();
    assert!((3590.0..=3601.0).contains(&scalar::<f64>(
        &db,
        "SELECT (julianday(expires_at)-julianday('now'))*86400 FROM media_uploads"
    )));
    assert_eq!(run(&file), totals(0, 0, 0, "0", 0, 0));
    let status = file
        .request(json!({"kind":"mediaUploadStatus","gameId":"game","uploadId":upload_id}))
        .unwrap();
    assert_eq!(&status["result"]["blobId"], blob);
    expired(&db);
    media_uploads::expire_for_test(&mut db, false);
    assert_eq!(count(&db, "media_uploads"), 0);
    let draft = json!({"version":3,"gameId":"game","baseContent":game("Draft"),"documents":{"info":"{}","instructions":"{}","state":"{}","code":"{}","lorebook":"{}","regex":"[]","assets":"{}"}});
    file.request(json!({"kind":"writeDraft","gameId":"game","version":0,"draft":draft}))
        .unwrap();
    assert!(has_blob(&db, blob));
    file.request(json!({"kind":"commit","gameId":"game","version":0,"records":[],"deleteSessions":[],"gamePatch":{"set":{"title":"Applied"},"remove":[]}})).unwrap();
    assert!(has_blob(&db, blob));
    file.request(
        json!({"kind":"versioning","action":"release","gameId":"game","contentVersion":"1.0.0"}),
    )
    .unwrap();
    assert!(has_blob(&db, blob));
    drop(db);
    let mut db = open(&file.0).unwrap();
    media_uploads::expire_for_test(&mut db, true);
    while media_uploads::step_for_test(&mut db) {}
    assert!(has_blob(&db, blob));
    assert_eq!(count(&db, "media_chunks"), 1);
    assert_eq!(run(&file), totals(1, 1, 1, "3", 0, 0));
    assert_eq!(count(&db, "runtime_assets"), 0);
    assert!(!has_blob(&db, blob));
    assert!(media_uploads::step_for_test(&mut db));
    assert_eq!(count(&db, "media_objects"), 0);
    assert_eq!(count(&db, "media_chunks"), 0);
}

#[test]
fn reclaims_an_object_in_32_chunk_transactions_with_writes_between_batches() {
    let file = Fixture::new();
    let mut db = open(&file.0).unwrap();
    game_row(&db, "g");
    db.execute_batch(
        "INSERT INTO media_objects VALUES('large','g','ready',65*1048576,1048576,'hash',0,'today');
        WITH RECURSIVE idx(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM idx WHERE i<64)
        INSERT INTO media_chunks SELECT 'large',i,'hash',zeroblob(1048576) FROM idx;",
    )
    .unwrap();
    assert_eq!(run(&file), totals(1, 0, 1, "68157440", 0, 0));
    assert_eq!(count(&db, "media_chunks"), 65);
    let started = std::time::Instant::now();
    assert!(media_uploads::step_for_test(&mut db));
    game_row(&open(&file.0).unwrap(), "interleaved");
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
    assert_eq!(count(&db, "media_chunks"), 33);
    assert!(media_uploads::step_for_test(&mut db));
    assert_eq!(count(&db, "media_chunks"), 1);
    assert!(media_uploads::step_for_test(&mut db));
    assert_eq!(count(&db, "media_objects"), 0);
}

#[test]
fn editor_lease_renewal_is_scoped_and_expiry_is_fifteen_minutes() {
    let file = Fixture::new();
    let db = open(&file.0).unwrap();
    game_row(&db, "g");
    game_row(&db, "other");
    let id = "a".repeat(32);
    lease(&file, "g", &id, "renew").unwrap();
    db.execute("UPDATE media_leases SET expires_at='2000'", [])
        .unwrap();
    lease(&file, "g", &id, "renew").unwrap();
    assert!((890.0..=901.0).contains(&scalar::<f64>(&db, "SELECT (julianday(expires_at)-julianday('now'))*86400 FROM media_leases WHERE kind='editor' AND object_id IS NULL")));
    lease(&file, "other", &id, "release").unwrap();
    assert!(lease(&file, "other", &id, "renew").is_err());
    assert_eq!(run(&file)["skippedEditing"], 1);
    lease(&file, "g", &"b".repeat(32), "renew").unwrap();
    db.execute(
        "INSERT INTO media_leases VALUES('read','g','object','read','9999')",
        [],
    )
    .unwrap();
    lease(&file, "g", &id, "release").unwrap();
    assert_eq!(count(&db, "media_leases"), 2);
    assert_eq!(run(&file)["skippedEditing"], 1);
    db.execute(
        "UPDATE media_leases SET expires_at=? WHERE kind='editor'",
        params!["2000"],
    )
    .unwrap();
    assert_eq!(run(&file)["skippedEditing"], 0);
}
