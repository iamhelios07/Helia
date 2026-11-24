//! Installation editing policy. This metadata grants no creator/runtime capabilities.
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) const LOCKED: &str = "GAME_EDIT_LOCKED";
const INVALID: &str = "INVALID_EDIT_LOCK";

pub(super) fn valid(value: &Value) -> bool {
    value.is_boolean()
}

pub(super) fn allows(lock: Option<&Value>, operation: &str) -> bool {
    lock != Some(&Value::Bool(true)) || !["draft", "apply", "release"].contains(&operation)
}

pub(super) fn validate(game: &Value) -> Result<(), String> {
    if game.get("editLock").is_some_and(|value| !valid(value)) {
        return Err(INVALID.into());
    }
    Ok(())
}

fn saved(connection: &Connection, id: &str) -> Result<(Value, i64), String> {
    let (raw, version): (String, i64) = connection
        .query_row("SELECT value,version FROM games WHERE id=?1", [id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .map_err(super::db_error)?
        .ok_or("게임을 찾을 수 없어요.")?;
    let game = serde_json::from_str(&raw).map_err(|_| "저장된 게임 정보가 올바르지 않아요.")?;
    validate(&game)?;
    Ok((game, version))
}

pub(super) fn guard(connection: &Connection, id: &str, operation: &str) -> Result<(), String> {
    let (value, kind, _version): (rusqlite::types::Value, Option<String>, i64) = connection
        .query_row("SELECT json_extract(value,'$.editLock'),json_type(value,'$.editLock'),version FROM games WHERE id=?1", [id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .map_err(super::db_error)?
        .ok_or("게임을 찾을 수 없어요.")?;
    let lock = match (kind.as_deref(), value) {
        (None, _) => None,
        (Some("true" | "false"), rusqlite::types::Value::Integer(value)) => {
            Some(Value::Bool(value == 1))
        }
        _ => return Err(INVALID.into()),
    };
    if !allows(lock.as_ref(), operation) {
        return Err(LOCKED.into());
    }
    Ok(())
}

/// Normal writes preserve the prior value, including its absence on creator-owned games.
pub(super) fn preserve(connection: &Connection, id: &str, game: &mut Value) -> Result<(), String> {
    validate(game)?;
    let raw: Option<String> = connection
        .query_row("SELECT value FROM games WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(super::db_error)?;
    let previous: Value = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|_| "저장된 게임 정보가 올바르지 않아요.")?
        .unwrap_or(Value::Null);
    validate(&previous)?;
    // Stored locked games are fixed points of parseGame normalization.
    if previous["editLock"] == true {
        for key in [
            "title",
            "genre",
            "description",
            "settings",
            "schema",
            "initialState",
            "scripts",
            "ui",
            "ai",
            "regex",
            "resources",
            "code",
        ] {
            if previous.get(key) != game.get(key) {
                return Err(LOCKED.into());
            }
        }
    }
    if let Some(lock) = previous.get("editLock") {
        game["editLock"] = lock.clone();
    } else {
        game.as_object_mut().ok_or(INVALID)?.remove("editLock");
    }
    Ok(())
}

pub(super) fn unlock(connection: &Connection, id: &str) -> Result<Value, String> {
    let (mut game, mut version) = saved(connection, id)?;
    if game["editLock"] == true {
        game["editLock"] = json!(false);
        if connection.execute(
            "UPDATE games SET value=?1,version=version+1 WHERE id=?2 AND version<9007199254740991",
            params![game.to_string(), id],
        ).map_err(super::db_error)? != 1 {
            return Err(super::CONFLICT.into());
        }
        version += 1;
    }
    Ok(json!({"version":version,"records":[]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_lock_validation_is_independent_of_other_fields() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../src/lib/storage/fixtures/edit-lock.json"
        ))
        .unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE games(id TEXT PRIMARY KEY,value TEXT,version INTEGER);")
            .unwrap();
        for case in fixture["values"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT OR REPLACE INTO games VALUES('game',?1,7)",
                    [json!({"editLock":case["value"]}).to_string()],
                )
                .unwrap();
            for operation in ["draft", "apply", "release"] {
                let result = guard(&connection, "game", operation);
                if case["value"] == false {
                    result.unwrap();
                } else {
                    assert_eq!(
                        result.unwrap_err(),
                        if case["valid"] == true {
                            LOCKED
                        } else {
                            INVALID
                        }
                    );
                }
            }
            if case["valid"] == false {
                assert_eq!(unlock(&connection, "game").unwrap_err(), INVALID);
            }
        }
        for case in fixture["storedGames"].as_array().unwrap() {
            connection
                .execute(
                    "INSERT OR REPLACE INTO games VALUES('game',?1,7)",
                    [case["value"].to_string()],
                )
                .unwrap();
            for operation in ["draft", "apply", "release"] {
                assert_eq!(guard(&connection, "game", operation).unwrap_err(), LOCKED);
            }
            assert_eq!(unlock(&connection, "game").unwrap()["version"], 8);
            let (game, version) = saved(&connection, "game").unwrap();
            let mut expected = case["value"].clone();
            expected["editLock"] = json!(false);
            assert_eq!(game, expected);
            assert_eq!(version, 8);
            guard(&connection, "game", "draft").unwrap();
        }
    }

    #[test]
    fn corrupt_json_uses_storage_errors() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE games(id TEXT,value TEXT,version INTEGER); INSERT INTO games VALUES('game','{',0);").unwrap();
        assert_eq!(
            guard(&connection, "game", "draft").unwrap_err(),
            "게임 데이터를 저장하거나 읽을 수 없어요."
        );
        assert_eq!(
            unlock(&connection, "game").unwrap_err(),
            "저장된 게임 정보가 올바르지 않아요."
        );
    }

    #[test]
    fn shared_values_and_operation_policy() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../src/lib/storage/fixtures/edit-lock.json"
        ))
        .unwrap();
        for case in fixture["values"].as_array().unwrap() {
            assert_eq!(
                valid(&case["value"]),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            let result = validate(&json!({"editLock":case["value"]}));
            if case["valid"] == false {
                assert_eq!(result.unwrap_err(), INVALID);
            }
        }
        validate(&json!({})).unwrap();
        for case in fixture["operations"].as_array().unwrap() {
            let operation = case["operation"].as_str().unwrap();
            assert_eq!(
                allows(Some(&json!(true)), operation),
                case["allowedWhenLocked"].as_bool().unwrap()
            );
            assert!(allows(Some(&json!(false)), operation));
            assert!(allows(None, operation));
        }
    }
}
