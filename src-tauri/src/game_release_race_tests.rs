// Test-only checkpoints make interleavings deterministic without changing the host API.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Checkpoint {
    ReadSaved,
    BeforeOpen,
    Chunk(usize),
}
type RaceHook = Box<dyn FnOnce(&Connection)>;
thread_local! {
    static RACE_HOOK: std::cell::RefCell<Option<(Checkpoint, RaceHook)>> = const { std::cell::RefCell::new(None) };
}
struct RaceHookGuard;
impl Drop for RaceHookGuard {
    fn drop(&mut self) {
        RACE_HOOK.with(|hook| {
            hook.borrow_mut().take();
        });
    }
}
fn set_hook(point: Checkpoint, action: impl FnOnce(&Connection) + 'static) -> RaceHookGuard {
    RACE_HOOK.with(|hook| *hook.borrow_mut() = Some((point, Box::new(action))));
    RaceHookGuard
}
pub(super) fn run_hook(connection: &Connection, point: Checkpoint) {
    let action = RACE_HOOK.with(|hook| {
        let matches = hook
            .borrow()
            .as_ref()
            .is_some_and(|(target, _)| *target == point);
        if matches {
            hook.borrow_mut().take()
        } else {
            None
        }
    });
    if let Some((_, action)) = action {
        action(connection);
    }
}

fn with_race_db(test: impl FnOnce(&mut Connection, &std::path::Path)) {
    let path = std::env::temp_dir().join(format!("helia-release-race-{}.sqlite", uuid().unwrap()));
    let mut db = super::super::open(&path).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    test(&mut db, &path);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

fn racing_commit(path: &std::path::Path, version: i64) {
    super::super::execute_request(
        path,
        json!({
            "kind":"commit","gameId":"one","version":version,"records":[],"deleteSessions":[],
            "gamePatch":{"set":{"title":"Concurrent change"},"remove":[]}
        }),
    )
    .unwrap();
}

#[test]
fn release_pins_before_opening_media_and_cleans_up_when_open_fails() {
    let mut db = media_connection();
    let mut game = install(&db, "one");
    let blob = seed_media(&db, "one", &[1, 2, 3], "image/png");
    game["resources"] = reference_resources(blob["id"].as_str().unwrap(), "image/png");
    save(&db, &game);
    let _hook = set_hook(Checkpoint::BeforeOpen, |connection| {
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM media_leases", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        connection
            .execute("UPDATE media_objects SET state='deleting'", [])
            .unwrap();
    });
    assert_eq!(
        request(
            &mut db,
            json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0"})
        )
        .unwrap_err(),
        packages::error("missingAsset")
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM media_leases", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(RACE_HOOK.with(|hook| hook.borrow().is_none()));
}

#[test]
fn inline_versioning_read_uses_one_deferred_snapshot() {
    with_race_db(|db, path| {
        install(db, "one");
        let before = release(db, "one", "1.0.0")["state"].clone();
        let writer_path = path.to_owned();
        let _hook =
            set_hook(Checkpoint::ReadSaved, move |reader| {
                assert!(!reader.is_autocommit());
                racing_commit(&writer_path, 0);
                super::super::execute_request(&writer_path, json!({
                "kind":"versioning","action":"release","gameId":"one","contentVersion":"2.0.0"
            })).unwrap();
            });
        let reply = request(
            db,
            json!({"kind":"versioning","action":"read","gameId":"one"}),
        )
        .unwrap();
        assert_eq!(reply["version"], 0);
        assert_eq!(reply["versioning"], before);
        let fresh = request(
            db,
            json!({"kind":"versioning","action":"read","gameId":"one"}),
        )
        .unwrap();
        assert_eq!(fresh["version"], 1);
        assert_eq!(fresh["versioning"]["releases"].as_array().unwrap().len(), 2);
        assert_ne!(
            fresh["versioning"]["contentHash"],
            reply["versioning"]["contentHash"]
        );
    });
}

#[test]
fn reference_versioning_read_retries_after_a_commit_during_the_second_chunk() {
    with_race_db(|db, path| {
        let mut game = install(db, "one");
        let blob = seed_media(db, "one", &vec![1; 3 * 1_048_576], "image/png");
        game["resources"] = reference_resources(blob["id"].as_str().unwrap(), "image/png");
        save(db, &game);
        let before = read(db, "one");
        let writer_path = path.to_owned();
        let _hook = set_hook(Checkpoint::Chunk(2), move |_| {
            racing_commit(&writer_path, 0)
        });
        let reply = request(
            db,
            json!({"kind":"versioning","action":"read","gameId":"one"}),
        )
        .unwrap();
        assert_eq!(reply["version"], 1);
        assert_ne!(reply["versioning"]["contentHash"], before["contentHash"]);
        assert_eq!(reply["versioning"], read(db, "one"));
    });
}

#[test]
fn reference_release_rechecks_commit_blob_deletion_and_purge_during_the_second_chunk() {
    for change in ["commit", "blob deletion", "purge"] {
        with_race_db(|db, path| {
            let mut game = install(db, "one");
            let blob = seed_media(db, "one", &vec![1; 3 * 1_048_576], "image/png");
            game["resources"] = reference_resources(blob["id"].as_str().unwrap(), "image/png");
            save(db, &game);
            let writer_path = path.to_owned();
            let _hook = set_hook(Checkpoint::Chunk(2), move |reader| {
                assert!(reader.is_autocommit());
                assert_eq!(
                    reader
                        .query_row("SELECT count(*) FROM media_leases", [], |r| r
                            .get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                match change {
                    "commit" => racing_commit(&writer_path, 0),
                    "blob deletion" => {
                        let writer = Connection::open(&writer_path).unwrap();
                        writer
                            .execute(
                                "DELETE FROM blobs WHERE id=?1",
                                [blob["id"].as_str().unwrap()],
                            )
                            .unwrap();
                    }
                    _ => {
                        super::super::execute_request(
                            &writer_path,
                            json!({"kind":"trash","gameId":"one"}),
                        )
                        .unwrap();
                        super::super::execute_request(
                            &writer_path,
                            json!({"kind":"purge","gameId":"one"}),
                        )
                        .unwrap();
                    }
                }
            });
            let error = request(db, json!({"kind":"versioning","action":"release","gameId":"one","contentVersion":"1.0.0"})).unwrap_err();
            if change == "commit" {
                assert_eq!(error, super::super::CONFLICT);
            }
            if change == "blob deletion" {
                assert_eq!(error, packages::error("missingAsset"));
            }
            assert_eq!(
                db.query_row("SELECT count(*) FROM game_releases", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                db.query_row("SELECT count(*) FROM media_leases", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(RACE_HOOK.with(|hook| hook.borrow().is_none()));
        });
    }
}
