use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

const FILE_BYTES: usize = 8 * 1024 * 1024;
const SESSION_BYTES: i64 = 128 * 1024 * 1024;
pub(crate) const SCHEMA: &str = include_str!("../../src/lib/storage/session-files.sql");
fn db_error(_: rusqlite::Error) -> String {
    "FILE_UNAVAILABLE".into()
}
fn field<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key].as_str().ok_or_else(|| "FILE_INPUT".into())
}
fn reference(input: &Value) -> Result<&str, String> {
    let value = field(input, "ref")?;
    let id = value.strip_prefix("helia-file:").ok_or("FILE_INPUT")?;
    if id.len() != 36
        || !id.is_ascii()
        || id.bytes().enumerate().any(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c != b'-'
            } else {
                !c.is_ascii_digit() && !(b'a'..=b'f').contains(&c)
            }
        })
        || id.as_bytes()[14] != b'4'
        || !b"89ab".contains(&id.as_bytes()[19])
    {
        return Err("FILE_INPUT".into());
    }
    Ok(value)
}
fn owner(connection: &Connection, game: &str, session: &str) -> Result<(), String> {
    for id in [game, session] {
        if id.is_empty()
            || id.len() > 100
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err("FILE_INPUT".into());
        }
    }
    let count: u32=connection.query_row("SELECT count(*) FROM sessions s JOIN games g ON g.id=s.game_id WHERE s.id=?1 AND s.game_id=?2 AND g.trashed_at IS NULL",params![session,game],|row|row.get(0)).map_err(db_error)?;
    if count != 1 {
        return Err("FILE_NOT_FOUND".into());
    }
    Ok(())
}
fn info(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"ref":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"mime":row.get::<_,String>(2)?,"size":row.get::<_,i64>(3)?,"createdAt":row.get::<_,String>(4)?}),
    )
}
fn stat(
    connection: &Connection,
    game: &str,
    session: &str,
    input: &Value,
) -> Result<Value, String> {
    connection.query_row("SELECT ref,name,mime,size,created_at FROM session_files WHERE game_id=?1 AND session_id=?2 AND ref=?3",params![game,session,reference(input)?],info).optional().map_err(db_error)?.ok_or_else(||"FILE_NOT_FOUND".into())
}
fn list(
    connection: &Connection,
    game: &str,
    session: &str,
    input: &Value,
) -> Result<Value, String> {
    let limit = if input.get("limit").is_some() {
        input["limit"].as_u64().ok_or("FILE_INPUT")?
    } else {
        50
    };
    if !(1..=100).contains(&limit) {
        return Err("FILE_INPUT".into());
    }
    let cursor = if let Some(cursor) = input.get("cursor") {
        reference(&json!({"ref":cursor}))?.to_owned()
    } else {
        String::new()
    };
    let mut statement=connection.prepare("SELECT ref,name,mime,size,created_at FROM session_files WHERE game_id=?1 AND session_id=?2 AND ref>?3 ORDER BY ref LIMIT ?4").map_err(db_error)?;
    let mut files = statement
        .query_map(params![game, session, cursor, (limit + 1) as i64], info)
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let more = files.len() > limit as usize;
    if more {
        files.pop();
    }
    let cursor = if more {
        files.last().unwrap()["ref"].clone()
    } else {
        Value::Null
    };
    Ok(json!({"files":files,"nextCursor":cursor}))
}
fn save(
    connection: &Connection,
    game: &str,
    session: &str,
    input: &Value,
) -> Result<Value, String> {
    let name = field(input, "name")?;
    let mime = field(input, "mime")?;
    let encoded = field(input, "data")?;
    if name.trim().is_empty()
        || name.encode_utf16().count() > 200
        || name.chars().any(|c| c < ' ' || c == '\u{7f}')
        || mime.len() > 127
        || !mime.bytes().all(|c| (32..=126).contains(&c))
        || encoded.len() > FILE_BYTES.div_ceil(3) * 4
    {
        return Err("FILE_INPUT".into());
    }
    let parts: Vec<_> = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .split('/')
        .collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(&c)
                })
        })
    {
        return Err("FILE_INPUT".into());
    }
    let data = STANDARD.decode(encoded).map_err(|_| "FILE_INPUT")?;
    if data.len() > FILE_BYTES || input["size"].as_u64() != Some(data.len() as u64) {
        return Err("FILE_INPUT".into());
    }
    let (count,size):(i64,i64)=connection.query_row("SELECT count(*),coalesce(sum(size),0) FROM session_files WHERE game_id=?1 AND session_id=?2",params![game,session],|row|Ok((row.get(0)?,row.get(1)?))).map_err(db_error)?;
    if count >= 2048 || size + data.len() as i64 > SESSION_BYTES {
        return Err("FILE_QUOTA".into());
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "FILE_UNAVAILABLE")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let reference = format!(
        "helia-file:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let now = time::OffsetDateTime::now_utc();
    let created = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    );
    connection.execute("INSERT INTO session_files(ref,game_id,session_id,name,mime,size,created_at,data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![reference,game,session,name,mime,data.len() as i64,created,data]).map_err(db_error)?;
    Ok(json!({"ref":reference,"name":name,"mime":mime,"size":data.len(),"createdAt":created}))
}
pub(crate) fn request(connection: &mut Connection, input: &Value) -> Result<Value, String> {
    let game = field(input, "gameId")?;
    let session = field(input, "sessionId")?;
    let operation = &input["operation"];
    let kind = field(operation, "kind")?;
    let transaction = connection
        .transaction_with_behavior(if kind == "save" || kind == "remove" {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })
        .map_err(db_error)?;
    owner(&transaction, game, session)?;
    let result = match kind {
        "save" => save(&transaction, game, session, operation)?,
        "list" => list(&transaction, game, session, operation)?,
        "stat" => stat(&transaction, game, session, operation)?,
        "read" => {
            let info = stat(&transaction, game, session, operation)?;
            let data: Vec<u8> = transaction
                .query_row(
                    "SELECT data FROM session_files WHERE game_id=?1 AND session_id=?2 AND ref=?3",
                    params![game, session, reference(operation)?],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            json!({"info":info,"data":STANDARD.encode(data)})
        }
        "remove" => {
            if transaction
                .execute(
                    "DELETE FROM session_files WHERE game_id=?1 AND session_id=?2 AND ref=?3",
                    params![game, session, reference(operation)?],
                )
                .map_err(db_error)?
                != 1
            {
                return Err("FILE_NOT_FOUND".into());
            }
            Value::Null
        }
        _ => return Err("FILE_INPUT".into()),
    };
    transaction.commit().map_err(db_error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owns_immutable_files_until_explicit_deletion_or_session_deletion() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE games(id TEXT PRIMARY KEY,trashed_at TEXT);CREATE TABLE sessions(id TEXT PRIMARY KEY,game_id TEXT,UNIQUE(id,game_id));INSERT INTO games VALUES('game',NULL);INSERT INTO sessions VALUES('one','game'),('two','game');").unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        let run = |connection: &mut Connection, session: &str, operation: Value| {
            request(
                connection,
                &json!({"gameId":"game","sessionId":session,"operation":operation}),
            )
        };
        let file=run(&mut connection,"one",json!({"kind":"save","name":"data.bin","mime":"application/octet-stream","size":3,"data":"AAEC"})).unwrap();
        let reference = file["ref"].as_str().unwrap();
        assert_eq!(
            run(
                &mut connection,
                "two",
                json!({"kind":"read","ref":reference})
            )
            .unwrap_err(),
            "FILE_NOT_FOUND"
        );
        assert_eq!(
            run(
                &mut connection,
                "one",
                json!({"kind":"read","ref":reference})
            )
            .unwrap()["data"],
            "AAEC"
        );
        run(
            &mut connection,
            "one",
            json!({"kind":"remove","ref":reference}),
        )
        .unwrap();
        assert_eq!(
            run(
                &mut connection,
                "one",
                json!({"kind":"stat","ref":reference})
            )
            .unwrap_err(),
            "FILE_NOT_FOUND"
        );
        run(
            &mut connection,
            "one",
            json!({"kind":"save","name":"persist","mime":"text/plain","size":0,"data":""}),
        )
        .unwrap();
        connection
            .execute("DELETE FROM sessions WHERE id='one'", [])
            .unwrap();
        let count: u32 = connection
            .query_row("SELECT count(*) FROM session_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
