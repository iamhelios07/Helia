use super::*;

fn connection() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db.execute_batch(crate::storage::MIGRATION).unwrap();
    db.execute_batch("CREATE TABLE editor_drafts(game_id TEXT PRIMARY KEY REFERENCES games(id),version INTEGER NOT NULL,value TEXT)").unwrap();
    initialize(&mut db).unwrap();
    db
}
fn input() -> Value {
    let release: Value = serde_json::from_str(include_str!(
        "../../src/lib/games/package/fixtures/minimal-release.json"
    ))
    .unwrap();
    json!({"kind":"install","gameId":uuid().unwrap(),"sessionId":uuid().unwrap(),"packageFormatVersion":1,"release":release})
}
fn counts(db: &Connection) -> Vec<i64> {
    [
        "games",
        "sessions",
        "game_releases",
        "game_release_selection",
    ]
    .iter()
    .map(|table| {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    })
    .collect()
}
fn setup(db: &mut Connection, values: &Value) {
    for value in values.as_array().unwrap() {
        if value["kind"] == "trash" {
            let id = value["gameId"].as_str().unwrap();
            db.execute("UPDATE games SET value=json_set(value,'$.trashedAt','2026-11-24T00:00:00.000Z') WHERE id=?1",[id]).unwrap();
        } else {
            request(db, value.clone()).unwrap();
        }
    }
}
fn fixture(db: &mut Connection, fixture: &Value, raw_json: bool) {
    let before = counts(db);
    let input = if raw_json {
        parse_install_json(&json!({"json":fixture["request"].to_string()})).unwrap()
    } else {
        fixture["request"].clone()
    };
    let result = request(db, input);
    let expected = &fixture["expect"];
    if let Some(code) = expected["errorCode"].as_str() {
        assert_eq!(result.unwrap_err(), error(code), "{}", fixture["name"]);
        assert_eq!(counts(db), before);
        return;
    }
    let reply = result.unwrap_or_else(|error| panic!("{}: {error}", fixture["name"]));
    if expected.get("conflict").is_some() {
        assert_eq!(
            reply["installResult"], expected["conflict"],
            "{}",
            fixture["name"]
        );
        assert_eq!(counts(db), before);
        return;
    }
    assert_eq!(expected["accepted"], true, "{}", fixture["name"]);
    let installed = &reply["installResult"];
    assert_eq!(installed["kind"], "installed");
    assert_eq!(installed["versioning"]["modified"], false);
    assert_eq!(
        installed["versioning"]["contentHash"],
        expected["contentHash"]
    );
    let release = get_release(
        db,
        installed["gameId"].as_str().unwrap(),
        installed["versioning"]["currentRelease"]["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        release["content"], expected["normalizedContent"],
        "{}",
        fixture["name"]
    );
    let raw: String = db
        .query_row(
            "SELECT value FROM games WHERE id=?1",
            [installed["gameId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    let game: Value = serde_json::from_str(&raw).unwrap();
    let replace_now = |value: &Value| -> Value {
        serde_json::from_str(
            &value
                .to_string()
                .replace("$now", game["createdAt"].as_str().unwrap()),
        )
        .unwrap()
    };
    if let Some(expected) = expected.get("release") {
        for (key, value) in replace_now(expected).as_object().unwrap() {
            assert_eq!(&release[key], value);
        }
    }
    if let Some(expected) = expected.get("installedFrom") {
        assert_eq!(game["installedFrom"], replace_now(expected));
    }
    // Idempotence and digest parity of every accepted shared fixture.
    assert_eq!(content(db, &game).unwrap(), release["content"]);
    assert_eq!(
        content_hash(&release["content"]).unwrap(),
        installed["versioning"]["contentHash"]
    );
}

#[test]
fn shared_content_and_timestamp_fixtures() {
    for raw in [
        include_str!("../../src/lib/storage/fixtures/install/content-cases.json"),
        include_str!("../../src/lib/storage/fixtures/install/release-cases.json"),
    ] {
        let fixtures: Vec<Value> = serde_json::from_str(raw).unwrap();
        for case in fixtures {
            for raw in [false, true] {
                fixture(&mut connection(), &case, raw);
            }
        }
    }
}
#[test]
fn shared_conflict_fixtures() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/install/conflict-cases.json"
    ))
    .unwrap();
    for case in cases {
        for raw in [false, true] {
            let mut db = connection();
            if let Some(values) = case.get("setup") {
                setup(&mut db, values);
            }
            fixture(&mut db, &case, raw);
        }
    }
}
#[test]
fn shared_reconflict_scenario() {
    let scenario: Value = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/install/scenario.json"
    ))
    .unwrap();
    for raw in [false, true] {
        let mut db = connection();
        setup(&mut db, &scenario["setup"]);
        for step in scenario["steps"].as_array().unwrap() {
            fixture(&mut db, step, raw);
        }
        let id = scenario["steps"][2]["request"]["gameId"].as_str().unwrap();
        let versions: Vec<String> = db
            .prepare("SELECT content_version FROM game_releases WHERE game_id=?1")
            .unwrap()
            .query_map([id], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(versions, ["2.0.0"]);
    }
}
#[test]
fn structured_bridge_errors_share_all_nine_codes() {
    let codes: Vec<String> = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/install/error-codes.json"
    ))
    .unwrap();
    assert_eq!(codes, ERROR_CODES);
    for code in codes {
        assert_eq!(bridge_error(error(&code)), json!({"errorCode":code}));
    }
    assert_eq!(
        bridge_error(crate::storage::CONFLICT.into()),
        json!(crate::storage::CONFLICT)
    );
    assert_eq!(
        bridge_error(error("constructor")),
        json!(error("constructor"))
    );
}
#[test]
fn rolls_back_every_write_and_final_validation_failure() {
    for table in [
        "games",
        "sessions",
        "game_releases",
        "game_release_selection",
    ] {
        let mut db = connection();
        db.execute_batch(&format!(
            "CREATE TRIGGER fail AFTER INSERT ON {table} BEGIN SELECT RAISE(ABORT,'injected'); END"
        ))
        .unwrap();
        assert!(request(&mut db, input()).is_err());
        assert_eq!(counts(&db), [0, 0, 0, 0]);
    }
    for mutation in [
        "UPDATE games SET value=json_set(value,'$.activeSessionId','missing') WHERE id=NEW.game_id;",
        "UPDATE games SET value=json_set(value,'$.title','Changed') WHERE id=NEW.game_id;",
    ] {
        let mut db = connection();
        db.execute_batch(&format!(
            "CREATE TRIGGER corrupt AFTER INSERT ON game_release_selection BEGIN {mutation} END"
        ))
        .unwrap();
        assert!(request(&mut db, input()).is_err());
        assert_eq!(counts(&db), [0, 0, 0, 0]);
    }
}
#[test]
fn session_collision_rolls_back_game_insert() {
    let mut db = connection();
    let first = input();
    request(&mut db, first.clone()).unwrap();
    let mut second = input();
    second["sessionId"] = first["sessionId"].clone();
    assert!(request(&mut db, second).is_err());
    assert_eq!(counts(&db), [1, 1, 1, 1]);
}
#[test]
fn raw_complexity_precedes_normalization_and_install_only_keys() {
    let mut db = connection();
    let mut request_value = input();
    request_value["release"]["content"]["id"] = json!("forbidden");
    request_value["release"]["content"]["unknown"] = json!(vec![Value::Null; 100_000]);
    assert_eq!(
        request(&mut db, request_value).unwrap_err(),
        error("content")
    );
    let mut request_value = input();
    request_value["release"]["content"]["unknown"] = json!("x".repeat(16 * 1024 * 1024 + 1));
    assert_eq!(
        request(&mut db, request_value).unwrap_err(),
        error("content")
    );
    let mut nested = Value::Null;
    for _ in 0..65 {
        nested = json!([nested]);
    }
    let mut request_value = input();
    request_value["release"]["content"]["unknown"] = nested;
    assert_eq!(
        request(&mut db, request_value).unwrap_err(),
        error("content")
    );
    assert_eq!(counts(&db), [0, 0, 0, 0]);
}
#[test]
fn raw_budget_boundaries_count_utf16_values_and_not_keys() {
    assert!(bound_content(&json!(vec![Value::Null; 99_999]), 0, &mut (0, 0)).is_ok());
    assert!(bound_content(&json!(vec![Value::Null; 100_000]), 0, &mut (0, 0)).is_err());
    assert!(bound_content(&json!("😀".repeat(8 * 1024 * 1024)), 0, &mut (0, 0)).is_ok());
    assert!(bound_content(&json!("😀".repeat(8 * 1024 * 1024) + "x"), 0, &mut (0, 0)).is_err());
    let mut value = Value::Null;
    for _ in 0..64 {
        value = json!([value]);
    }
    assert!(bound_content(&value, 0, &mut (0, 0)).is_ok());
    value = json!([value]);
    assert!(bound_content(&value, 0, &mut (0, 0)).is_err());
}
#[test]
fn acknowledgement_boundaries() {
    let mut value = json!({"originalGameId":input()["release"]["originalGameId"],"contentVersion":"1.0.0","incomingHash":"f".repeat(64),
        "existingHashes":(0..10_000).map(|n|format!("{n:064x}")).collect::<Vec<_>>()});
    validate_acknowledgement(&value).unwrap();
    value["existingHashes"]
        .as_array_mut()
        .unwrap()
        .push(json!(format!("{:064x}", 10_000)));
    assert_eq!(
        validate_acknowledgement(&value).unwrap_err(),
        error("format")
    );
}
#[test]
fn request_utf8_size_exact_limit_and_one_more() {
    let limit: usize = include_str!("../../src/lib/storage/install-request-limit.json")
        .trim()
        .parse()
        .unwrap();
    let mut value = input();
    value["padding"] = json!("한\u{0000}");
    let remaining = limit - serde_json::to_vec(&value).unwrap().len();
    value["padding"] = json!("한\u{0000}".to_owned() + &"x".repeat(remaining));
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), limit);
    check_request_size(&value).unwrap();
    assert!(parse_install_json(&json!({"json":value.to_string()})).is_ok());
    let store = Store::new();
    store.request(value.clone()).unwrap();
    value["padding"] = json!(value["padding"].as_str().unwrap().to_owned() + "x");
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), limit + 1);
    assert_eq!(
        parse_install_json(&json!({"json":value.to_string()})).unwrap_err(),
        error("limit")
    );
    let db = crate::storage::open(&store.0).unwrap();
    let before = counts(&db);
    assert_eq!(store.request(value).unwrap_err(), error("limit"));
    assert_eq!(counts(&db), before);
}

#[test]
fn raw_json_limit_uses_original_bytes_when_serialization_grows() {
    let limit: usize = include_str!("../../src/lib/storage/install-request-limit.json")
        .trim()
        .parse()
        .unwrap();
    // This integer exceeds u64 and becomes a longer f64 representation in Value.
    let mut value = input();
    value["number"] = json!("REPLACE_NUMBER");
    value["padding"] = json!("");
    let raw = value
        .to_string()
        .replace("\"REPLACE_NUMBER\"", "18446744073709551616");
    let padding = limit - raw.len();
    let raw = raw.replace(
        "\"padding\":\"\"",
        &format!("\"padding\":\"{}\"", "x".repeat(padding)),
    );
    assert_eq!(raw.len(), limit);
    let parsed = parse_install_json(&json!({"json":raw})).unwrap();
    assert!(serde_json::to_vec(&parsed).unwrap().len() > limit);
    let store = Store::new();
    // A parsed install uses its serialized size, before opening the database.
    assert_eq!(store.request(parsed).unwrap_err(), error("limit"));
    assert!(!store.0.exists());
    assert_eq!(
        store
            .request(json!({"kind":"installJson","json":raw}))
            .unwrap()["installResult"]["kind"],
        "installed"
    );
}

struct Store(std::path::PathBuf);

#[test]
fn edit_lock_first_play_and_replay_share_frontend_script_and_ui_snapshots() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/edit-lock-play.json"
    ))
    .unwrap();
    for case in fixtures.as_array().unwrap() {
        for sync in [false, true] {
            let store = Store::new();
            store.request(case["install"].clone()).unwrap();
            let id = &case["install"]["gameId"];
            let before = store.game(id);
            for command in case["commits"].as_array().unwrap() {
                assert!(command.get("gamePatch").is_none());
                assert!(command["records"].as_array().unwrap().iter().all(|row| {
                    ["snapshots", "progress"].contains(&row["table"].as_str().unwrap())
                }));
                lock_dispatch(&store, command.clone(), sync).unwrap();
            }
            let read = json!({"kind":"read","gameId":id,"includeHistory":true});
            let first = store.request(read.clone()).unwrap();
            let again = store.request(read).unwrap();
            assert_eq!(first, again);
            let rows = first["records"].as_array().unwrap();
            let progress = rows.iter().find(|row| row["table"] == "progress").unwrap();
            assert_eq!(progress["value"]["snapshotId"], case["snapshotId"]);
            let snapshot = rows
                .iter()
                .find(|row| row["table"] == "snapshots" && row["id"] == case["snapshotId"])
                .unwrap();
            assert!(!snapshot["value"]["scripts"].as_object().unwrap().is_empty());
            assert!(
                snapshot["value"]["scripts"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|script| script["compiled"].is_string())
            );
            assert!(snapshot["value"]["ui"]["compiled"]["factories"].is_string());
            assert_eq!(store.game(id), before);
            let state = store
                .request(json!({"kind":"versioning","action":"read","gameId":id}))
                .unwrap();
            assert_eq!(state["versioning"]["modified"], false);
            assert_eq!(
                state["versioning"]["contentHash"],
                case["install"]["release"]["contentHash"]
            );
            assert_eq!(
                store
                    .request(json!({"kind":"readDraft","gameId":id}))
                    .unwrap(),
                json!({"version":0,"draft":null})
            );
            let playing = store.request(json!({"kind":"sync","known":[],"request":{"kind":"read","gameId":id,"sessionId":case["install"]["sessionId"],"play":true}})).unwrap();
            let snapshot = playing["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["table"] == "snapshots" && row["id"] == case["snapshotId"])
                .unwrap();
            assert!(snapshot["parts"]["value"]["value"]["ui"]["artifact"].is_string());
            let db = crate::storage::open(&store.0).unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM snapshots", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
        }
    }
}

fn lock_dispatch(store: &Store, command: Value, sync: bool) -> Result<Value, String> {
    if sync {
        store.request(json!({"kind":"sync","known":[],"request":command}))
    } else {
        store.request(command)
    }
}

#[test]
fn edit_lock_ignores_unrelated_invalid_fields_on_direct_and_sync_paths() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/edit-lock.json"
    ))
    .unwrap();
    for case in fixtures["storedGames"].as_array().unwrap() {
        for sync in [false, true] {
            let store = Store::new();
            let input = input();
            store.request(input.clone()).unwrap();
            let id = &input["gameId"];
            let mut game = store.game(id);
            for (key, value) in case["value"].as_object().unwrap() {
                game[key] = value.clone();
            }
            crate::storage::open(&store.0)
                .unwrap()
                .execute(
                    "UPDATE games SET value=?1 WHERE id=?2",
                    params![game.to_string(), id.as_str().unwrap()],
                )
                .unwrap();
            let stored_game = || {
                let raw: String = crate::storage::open(&store.0)
                    .unwrap()
                    .query_row(
                        "SELECT value FROM games WHERE id=?1",
                        [id.as_str().unwrap()],
                        |row| row.get(0),
                    )
                    .unwrap();
                serde_json::from_str::<Value>(&raw).unwrap()
            };
            for command in [
                json!({"kind":"writeDraft","gameId":id,"version":0,"draft":null}),
                json!({"kind":"versioning","action":"release","gameId":id,"contentVersion":"2.0.0"}),
            ] {
                assert_eq!(
                    lock_dispatch(&store, command, sync).unwrap_err(),
                    "GAME_EDIT_LOCKED"
                );
                assert_eq!(stored_game(), game);
            }
            assert_eq!(
                lock_dispatch(&store, json!({"kind":"unlockGame","gameId":id}), sync).unwrap()["version"],
                1
            );
            game["editLock"] = json!(false);
            assert_eq!(stored_game(), game);
            store
                .request(json!({"kind":"writeDraft","gameId":id,"version":0,"draft":null}))
                .unwrap();
        }
    }
}

#[test]
fn edit_lock_shared_content_writes_and_release_are_guarded_on_direct_and_sync_paths() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/edit-lock.json"
    ))
    .unwrap();
    for sync in [false, true] {
        let store = Store::new();
        let input = input();
        store.request(input.clone()).unwrap();
        let id = &input["gameId"];
        assert_eq!(store.game(id)["editLock"], true);
        for case in fixtures["writes"].as_array().unwrap() {
            for shape in ["record", "patch", "syncPatch"] {
                if shape == "syncPatch" && !sync {
                    continue;
                }
                let before = store.request(json!({"kind":"read","gameId":id})).unwrap();
                let mut game = store.game(id);
                for (key, value) in case["set"].as_object().unwrap() {
                    game[key] = value.clone();
                }
                for key in case["remove"].as_array().unwrap() {
                    game.as_object_mut().unwrap().remove(key.as_str().unwrap());
                }
                let patch = json!({"set":case["set"],"remove":case["remove"]});
                let mut command = json!({"kind":"commit","gameId":id,"version":before["version"],"deleteSessions":[],"records":[]});
                command["records"] = match shape {
                    "patch" => {
                        command["gamePatch"] = patch.clone();
                        json!([])
                    }
                    "syncPatch" => {
                        json!([{"table":"games","id":id,"gameId":id,"sessionId":null,"patch":patch}])
                    }
                    _ => {
                        json!([{"table":"games","id":id,"gameId":id,"sessionId":null,"value":game}])
                    }
                };
                let result = lock_dispatch(&store, command, sync);
                if case["allowed"] == true {
                    result.unwrap();
                } else {
                    assert_eq!(
                        result.unwrap_err(),
                        "GAME_EDIT_LOCKED",
                        "{} {shape}",
                        case["name"]
                    );
                    assert_eq!(
                        store.request(json!({"kind":"read","gameId":id})).unwrap(),
                        before
                    );
                }
                assert_eq!(store.game(id)["editLock"], true);
            }
        }
        let release =
            json!({"kind":"versioning","action":"release","gameId":id,"contentVersion":"2.0.0"});
        assert_eq!(
            lock_dispatch(&store, release, sync).unwrap_err(),
            "GAME_EDIT_LOCKED"
        );
        for version in [0, 99] {
            let draft = json!({"kind":"writeDraft","gameId":id,"version":version,"draft":null});
            assert_eq!(
                lock_dispatch(&store, draft, sync).unwrap_err(),
                "GAME_EDIT_LOCKED"
            );
        }
    }
}

#[test]
fn edit_lock_unlock_preserves_content_provenance_and_revision_guards() {
    let store = Store::new();
    let input = input();
    store.request(input.clone()).unwrap();
    let id = &input["gameId"];
    let before = store.game(id);
    store.request(json!({"kind":"trash","gameId":id})).unwrap();
    store
        .request(json!({"kind":"restore","gameId":id}))
        .unwrap();
    assert_eq!(store.game(id)["editLock"], true);
    let list = store
        .request(json!({"kind":"list","includeTrashed":true}))
        .unwrap();
    assert_eq!(list["games"][0]["editLock"], true);
    let unlocked = lock_dispatch(&store, json!({"kind":"unlockGame","gameId":id}), true).unwrap();
    assert_eq!(unlocked["version"], 1);
    assert_eq!(
        store
            .request(json!({"kind":"unlockGame","gameId":id}))
            .unwrap()["version"],
        1
    );
    let mut expected = before;
    expected["trashedAt"] = Value::Null;
    expected["editLock"] = json!(false);
    assert_eq!(store.game(id), expected);
    let state = store
        .request(json!({"kind":"versioning","action":"read","gameId":id}))
        .unwrap();
    assert_eq!(state["versioning"]["modified"], false);
    store
        .request(json!({"kind":"writeDraft","gameId":id,"version":0,"draft":null}))
        .unwrap();
    let mut edited = store.game(id);
    edited["title"] = json!("Editable");
    edited["editLock"] = json!(true);
    store
        .request(
            json!({"kind":"commit","gameId":id,"version":1,"deleteSessions":[],"records":[
                {"table":"games","id":id,"gameId":id,"sessionId":null,"value":edited}
            ]}),
        )
        .unwrap();
    assert_eq!(store.game(id)["editLock"], false);
    assert_eq!(store.game(id)["installedFrom"], expected["installedFrom"]);
    store
        .request(
            json!({"kind":"versioning","action":"release","gameId":id,"contentVersion":"2.0.0"}),
        )
        .unwrap();
}

#[test]
fn edit_lock_malformed_values_fail_before_writes_on_direct_and_sync_paths() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../src/lib/storage/fixtures/edit-lock.json"
    ))
    .unwrap();
    let store = Store::new();
    let input = input();
    store.request(input.clone()).unwrap();
    let id = &input["gameId"];
    let before = store.request(json!({"kind":"read","gameId":id})).unwrap();
    for case in fixtures["values"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["valid"] == false)
    {
        for sync in [false, true] {
            let mut game = store.game(id);
            game["editLock"] = case["value"].clone();
            let command = json!({"kind":"commit","gameId":id,"version":0,"deleteSessions":[],"records":[
                {"table":"games","id":id,"gameId":id,"sessionId":null,"value":game}
            ]});
            assert_eq!(
                lock_dispatch(&store, command, sync).unwrap_err(),
                "INVALID_EDIT_LOCK"
            );
            assert_eq!(
                store.request(json!({"kind":"read","gameId":id})).unwrap(),
                before
            );
        }
    }
}
impl Store {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("helia-install-{}.sqlite", uuid().unwrap())))
    }
    fn request(&self, value: Value) -> Result<Value, String> {
        crate::storage::execute_request(&self.0, value)
    }
    fn game(&self, id: &Value) -> Value {
        let reply = self.request(json!({"kind":"read","gameId":id})).unwrap();
        reply["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["table"] == "games")
            .unwrap()["value"]
            .clone()
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
#[test]
fn raw_json_rejects_lone_surrogates_invalid_json_and_non_install_without_opening_database() {
    let store = Store::new();
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../src/lib/games/package/fixtures/surrogate-cases.json"
    ))
    .unwrap();
    for case in cases {
        assert_eq!(
            store
                .request(json!({"kind":"installJson","json":case["rawJson"]}))
                .unwrap_err(),
            error("content")
        );
        assert!(!store.0.exists());
    }
    for raw in ["{", "[", "null invalid"] {
        assert_eq!(
            store
                .request(json!({"kind":"installJson","json":raw}))
                .unwrap_err(),
            error("content")
        );
    }
    for kind in [
        "list",
        "create",
        "installJson",
        "installPreview",
        "versioning",
        "sync",
    ] {
        assert_eq!(
            store
                .request(json!({"kind":"installJson","json":json!({"kind":kind}).to_string()}))
                .unwrap_err(),
            error("format")
        );
    }
    let limit: usize = include_str!("../../src/lib/storage/install-request-limit.json")
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        store
            .request(json!({"kind":"installJson","json":" ".repeat(limit+1)}))
            .unwrap_err(),
        error("limit")
    );
    assert!(!store.0.exists());
}
#[test]
fn preserves_provenance_across_normal_commit_patch_release_trash_restore_and_restart() {
    let store = Store::new();
    let input = input();
    store
        .request(json!({"kind":"installJson","json":input.to_string()}))
        .unwrap();
    let id = &input["gameId"];
    store
        .request(json!({"kind":"unlockGame","gameId":id}))
        .unwrap();
    let before = store.game(id);
    let provenance = before["installedFrom"].clone();
    assert!(valid_installed_from(&provenance));
    for (index, mode) in ["change", "delete", "invalid"].iter().enumerate() {
        let mut game = store.game(id);
        match *mode {
            "change" => game["installedFrom"]["versionChanged"] = json!(true),
            "delete" => {
                game.as_object_mut().unwrap().remove("installedFrom");
            }
            _ => game["installedFrom"] = json!("forged"),
        }
        game["title"] = json!(format!("Edited {index}"));
        store
            .request(
                json!({"kind":"commit","gameId":id,"version":index+1,"deleteSessions":[],"records":[
                    {"table":"games","id":id,"gameId":id,"value":game}
                ]}),
            )
            .unwrap();
        assert_eq!(store.game(id)["installedFrom"], provenance);
    }
    for (index, patch) in [
        json!({"set":{"installedFrom":null},"remove":[]}),
        json!({"set":{},"remove":["installedFrom"]}),
    ]
    .iter()
    .enumerate()
    {
        store.request(json!({"kind":"commit","gameId":id,"version":index+4,"records":[],"deleteSessions":[],"gamePatch":patch})).unwrap();
        assert_eq!(store.game(id)["installedFrom"], provenance);
    }
    // The same game row write used by Apply preserves provenance; no migration is run here.
    store.request(json!({"kind":"sync","known":[],"request":{"kind":"commit","gameId":id,"version":6,"deleteSessions":[],"records":[
        {"table":"games","id":id,"gameId":id,"patch":{"set":{"installedFrom":false},"remove":[]}}
    ]}})).unwrap();
    assert_eq!(store.game(id)["installedFrom"], provenance);
    store
        .request(
            json!({"kind":"versioning","action":"release","gameId":id,"contentVersion":"3.0.0"}),
        )
        .unwrap();
    store.request(json!({"kind":"trash","gameId":id})).unwrap();
    store
        .request(json!({"kind":"restore","gameId":id}))
        .unwrap();
    assert_eq!(store.game(id)["installedFrom"], provenance);
    let mut db = crate::storage::open(&store.0).unwrap();
    let mut game = store.game(id);
    let before = content_hash(&content(&db, &game).unwrap()).unwrap();
    game.as_object_mut().unwrap().remove("installedFrom");
    assert_eq!(content_hash(&content(&db, &game).unwrap()).unwrap(), before);
    let result=request(&mut db,json!({"kind":"installPreview","originalGameId":input["release"]["originalGameId"],"contentVersion":"1.0.0"})).unwrap();
    assert_eq!(
        result["installPreview"][0]["versioning"]["contentHash"],
        before
    );
}
#[test]
fn normal_create_and_commit_cannot_forge_provenance() {
    let store = Store::new();
    let input = input();
    let db = crate::storage::open(&store.0).unwrap();
    let (game, _, _) = verify(&db, &input, "2026-11-24T00:00:00.000Z").unwrap();
    drop(db);
    let records = json!([
        {"table":"games","id":input["gameId"],"gameId":input["gameId"],"value":game},
        {"table":"sessions","id":input["sessionId"],"gameId":input["gameId"],"sessionId":input["sessionId"],"value":{
            "schemaVersion":1,"id":input["sessionId"],"gameId":input["gameId"],"title":"Session","createdAt":game["createdAt"],"updatedAt":game["updatedAt"]}}
    ]);
    store
        .request(json!({"kind":"create","gameId":input["gameId"],"records":records}))
        .unwrap();
    assert!(store.game(&input["gameId"]).get("installedFrom").is_none());
    assert!(store.game(&input["gameId"]).get("editLock").is_none());
    let mut records = records;
    records.as_array_mut().unwrap().truncate(1);
    store.request(json!({"kind":"commit","gameId":input["gameId"],"version":0,"records":records,"deleteSessions":[]})).unwrap();
    assert!(store.game(&input["gameId"]).get("installedFrom").is_none());
}
#[test]
fn persisted_provenance_is_strict_and_accepts_future_positive_format_versions() {
    let mut provenance = installed_from(&input(), "2026-11-24T00:00:00.000Z").unwrap();
    provenance["packageFormatVersion"] = json!(2);
    assert!(valid_installed_from(&provenance));
    for (key, value) in [
        ("kind", json!("other")),
        ("packageFormatVersion", json!(0)),
        ("packageFormatVersion", json!(9_007_199_254_740_992u64)),
        ("versionChanged", json!(0)),
        ("installedAt", json!("2026-02-29T00:00:00.000Z")),
        ("extra", json!(true)),
    ] {
        let mut bad = provenance.clone();
        bad[key] = value;
        assert!(!valid_installed_from(&bad), "{key}");
    }
    for (key, value) in [
        ("contentVersion", json!("01.0.0")),
        ("contentHash", json!("A".repeat(64))),
        ("createdAt", json!("0000-01-01T00:00:00.000Z")),
        ("extra", Value::Null),
    ] {
        let mut bad = provenance.clone();
        bad["packageRelease"][key] = value;
        assert!(!valid_installed_from(&bad), "{key}");
    }
}
#[test]
fn preview_matches_version_state_includes_drafts_and_excludes_trash() {
    let store = Store::new();
    let first = input();
    store.request(first.clone()).unwrap();
    let mut second = input();
    second["installContentVersion"] = json!("2.0.0");
    store.request(second.clone()).unwrap();
    let third = input();
    store.request(third.clone()).unwrap();
    store
        .request(json!({"kind":"trash","gameId":third["gameId"]}))
        .unwrap();
    let db = crate::storage::open(&store.0).unwrap();
    db.execute(
        "INSERT INTO editor_drafts(game_id,version,value) VALUES(?1,1,'{}')",
        [first["gameId"].as_str().unwrap()],
    )
    .unwrap();
    let before = counts(&db);
    let preview=store.request(json!({"kind":"installPreview","originalGameId":first["release"]["originalGameId"],"contentVersion":"1.0.0"})).unwrap();
    let rows = preview["installPreview"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0]["gameId"].as_str().unwrap() < rows[1]["gameId"].as_str().unwrap());
    for row in rows {
        let state = store
            .request(json!({"kind":"versioning","action":"read","gameId":row["gameId"]}))
            .unwrap();
        assert_eq!(row["versioning"], state["versioning"]);
        assert_eq!(row["hasDraft"], row["gameId"] == first["gameId"]);
        assert_eq!(
            row["existingHashes"],
            if row["gameId"] == first["gameId"] {
                json!([first["release"]["contentHash"]])
            } else {
                json!([])
            }
        );
    }
    assert_eq!(counts(&db), before);
    for kind in ["install", "installPreview", "installJson"] {
        assert!(
            store
                .request(json!({"kind":"sync","known":[],"request":{"kind":kind}}))
                .is_err()
        );
    }
    assert_eq!(counts(&db), before);
}
#[test]
fn preview_does_not_take_a_write_lock_after_database_initialization() {
    let store = Store::new();
    let first = input();
    store.request(first.clone()).unwrap();
    let mut writer = crate::storage::open(&store.0).unwrap();
    let _lock = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let result=store.request(json!({"kind":"installPreview","originalGameId":first["release"]["originalGameId"],"contentVersion":"1.0.0"})).unwrap();
    assert_eq!(result["installPreview"].as_array().unwrap().len(), 1);
}

#[test]
fn install_verifies_content_before_taking_the_write_lock() {
    let store = Store::new();
    let mut writer = crate::storage::open(&store.0).unwrap();
    let lock = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let mut noncanonical = input();
    noncanonical["release"]["content"]["title"] = json!(" Adventure ");
    let mut bad_hash = input();
    bad_hash["release"]["contentHash"] = json!("0".repeat(64));
    for (value, code) in [(noncanonical, "nonCanonical"), (bad_hash, "integrity")] {
        assert_eq!(store.request(value).unwrap_err(), error(code));
    }
    assert_eq!(counts(&lock), [0, 0, 0, 0]);
}

#[test]
fn installs_packages_carrying_hundreds_of_small_resources() {
    for count in [129usize, 257] {
        let mut db = connection();
        let mut value = input();
        let resources = Value::Object(
            (0..count)
                .map(|index| {
                    (
                        format!("asset-{index}"),
                        json!({
                            "name": format!("images/asset-{index}.png"),
                            "mime": "image/png",
                            "data": "data:image/png;base64,AA=="
                        }),
                    )
                })
                .collect(),
        );
        value["release"]["content"]["resources"] = resources.clone();
        value["release"]["contentHash"] =
            json!(content_hash(&value["release"]["content"]).unwrap());
        let reply = request(&mut db, value.clone()).unwrap();
        assert_eq!(reply["installResult"]["kind"], "installed", "{count}");
        let game_id = reply["installResult"]["gameId"].as_str().unwrap();
        let release_id = reply["installResult"]["versioning"]["currentRelease"]["id"]
            .as_str()
            .unwrap();
        let frozen = get_release(&db, game_id, release_id).unwrap();
        assert_eq!(
            frozen["content"]["resources"].as_object().unwrap().len(),
            count
        );
        assert_eq!(frozen["content"]["resources"], resources);
    }
}

#[test]
fn blob_state_only_affects_rejected_asset_references() {
    let mut db = connection();
    let mut value = input();
    let data = "data:image/png;base64,aGVsbG8=";
    value["release"]["content"]["resources"] = json!({"portrait":{
        "name":"portrait.png","mime":"image/png","data":data
    }});
    value["release"]["contentHash"] = json!(content_hash(&value["release"]["content"]).unwrap());
    request(&mut db, value.clone()).unwrap();
    let timestamp = "2026-11-24T00:00:00.000Z";
    let verified = verify(&db, &value, timestamp).unwrap();
    let mut reference = value.clone();
    let hash = "0".repeat(64);
    reference["release"]["content"]["resources"]["portrait"]["data"] =
        json!(format!("helia-asset:{hash}"));
    assert_eq!(
        verify(&db, &reference, timestamp).unwrap_err(),
        error("content")
    );
    db.execute(
        "INSERT INTO blobs(id,game_id,value) VALUES(?1,?2,?3)",
        params![
            hash,
            value["gameId"].as_str().unwrap(),
            json!({"data":data}).to_string()
        ],
    )
    .unwrap();
    assert_eq!(
        verify(&db, &reference, timestamp).unwrap_err(),
        error("nonCanonical")
    );
    assert_eq!(verify(&db, &value, timestamp).unwrap(), verified);
    db.execute("DELETE FROM blobs", []).unwrap();
    assert_eq!(verify(&db, &value, timestamp).unwrap(), verified);
}

#[test]
fn installation_rechecks_existence_and_conflicts_after_verification() {
    for same_id in [true, false] {
        let mut db = connection();
        let value = input();
        let timestamp = "2026-11-24T00:00:00.000Z";
        let verified = verify(&db, &value, timestamp).unwrap();
        // A different writer commits between input verification and our lock.
        let mut other = if same_id { value.clone() } else { input() };
        other["release"]["content"]["title"] = json!("Another release");
        other["release"]["contentHash"] =
            json!(content_hash(&other["release"]["content"]).unwrap());
        request(&mut db, other.clone()).unwrap();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let result = install(&tx, &value, timestamp, verified);
        if same_id {
            assert_eq!(result.unwrap_err(), error("format"));
        } else {
            let conflict = result.unwrap()["installResult"].clone();
            assert_eq!(conflict["kind"], "conflict");
            assert_eq!(
                conflict["existingHashes"],
                json!([other["release"]["contentHash"]])
            );
        }
        assert_eq!(counts(&tx), [1, 1, 1, 1]);
    }
}
#[test]
fn shared_release_storage_reuses_identity_and_timestamp() {
    let mut db = connection();
    let request_value = input();
    request(&mut db, request_value.clone()).unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let summary = store_release(
        &tx,
        &request_value,
        &request_value["release"]["content"],
        "2026-11-25T00:00:00.000Z",
    )
    .unwrap();
    assert_eq!(summary["createdAt"], request_value["release"]["createdAt"]);
    assert_eq!(counts(&tx), [1, 1, 1, 1]);
}

#[test]
fn conflict_query_bounds_distinct_hashes_at_ten_thousand_and_excludes_incoming() {
    let mut db = connection();
    let value = input();
    request(&mut db, value.clone()).unwrap();
    let game_id = value["gameId"].as_str().unwrap();
    let origin = value["release"]["originalGameId"].as_str().unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let insert = |index| {
        tx.execute("INSERT INTO game_releases(id,game_id,original_game_id,content_version,content_hash,created_at,content) VALUES(?1,?2,?3,'2.0.0',?4,'2026-11-24T00:00:00.000Z','{}')",
            params![format!("test-release-{index}"),game_id,origin,format!("{index:064x}")]).unwrap();
    };
    for index in 0..10_000 {
        insert(index);
    }
    let hashes = conflict_hashes(&tx, origin, "2.0.0", &"f".repeat(64)).unwrap();
    assert_eq!(hashes.len(), 10_000);
    assert!(hashes.windows(2).all(|pair| pair[0] < pair[1]));
    insert(10_000);
    assert_eq!(
        conflict_hashes(&tx, origin, "2.0.0", &"f".repeat(64)).unwrap_err(),
        error("limit")
    );
    assert_eq!(
        conflict_hashes(&tx, origin, "2.0.0", &format!("{:064x}", 10_000))
            .unwrap()
            .len(),
        10_000
    );
}

#[test]
fn malformed_release_objects_are_format_errors_and_never_write() {
    let mut db = connection();
    for invalid in [Value::Null, json!([]), json!("release"), json!(1)] {
        let mut value = input();
        value["release"] = invalid;
        assert_eq!(request(&mut db, value).unwrap_err(), error("format"));
        assert_eq!(counts(&db), [0, 0, 0, 0]);
    }
}

#[test]
fn integer_format_versions_match_javascript_number_semantics() {
    let mut db = connection();
    let mut value = input();
    value["packageFormatVersion"] = json!(1.0);
    assert_eq!(
        request(&mut db, value.clone()).unwrap()["installResult"]["kind"],
        "installed"
    );
    let provenance = installed_from(&value, "2026-11-24T00:00:00.000Z").unwrap();
    assert!(valid_installed_from(&provenance));
    for invalid in [json!(1.5), json!(0.0), json!(9_007_199_254_740_992.0)] {
        let mut value = provenance.clone();
        value["packageFormatVersion"] = invalid;
        assert!(!valid_installed_from(&value));
    }
}
