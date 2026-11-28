//! Manual cleanup only. The lifetime worker reclaims the queued bytes separately.
use super::{db_error, media_uploads, open};
use crate::runtime_content::valid_hash;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

const INVALID: &str = "저장 공간을 정리할 수 없어요.";
type Result<T> = std::result::Result<T, String>;

fn object(value: &Value) -> Result<&serde_json::Map<String, Value>> {
    value.as_object().ok_or_else(|| INVALID.into())
}

fn fingerprint(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| valid_hash(s))
        .ok_or_else(|| INVALID.into())
}

fn resource_roots(resources: &Value, roots: &mut HashSet<String>) -> Result<()> {
    for entry in object(resources)?.values() {
        let data = object(entry)?
            .get("data")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        if let Some(id) = data.strip_prefix("helia-asset:").filter(|s| valid_hash(s)) {
            roots.insert(id.to_owned());
        } else if !data.starts_with("data:") {
            return Err(INVALID.into());
        }
    }
    Ok(())
}

fn content_roots(value: &Value, roots: &mut HashSet<String>) -> Result<()> {
    if let Some(resources) = object(value)?.get("resources") {
        resource_roots(resources, roots)?;
    }
    Ok(())
}

fn parse(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| INVALID.into())
}

fn draft_roots(draft: &Value, roots: &mut HashSet<String>) -> Result<()> {
    content_roots(&draft["baseContent"], roots)?;
    let assets = draft["documents"]["assets"].as_str().ok_or(INVALID)?;
    resource_roots(&parse(assets)?, roots)
}

/// Keep this path-specific extraction aligned with the Node host, including the nested asset JSON.
fn collect_roots(db: &Connection, game: &str, now: &str, value: &str) -> Result<HashSet<String>> {
    let mut roots = HashSet::new();
    content_roots(&parse(value)?, &mut roots)?;
    for (sql, args, extract) in [
        (
            "SELECT value FROM editor_drafts WHERE game_id=? AND value IS NOT NULL",
            vec![game],
            draft_roots as fn(&Value, &mut HashSet<String>) -> Result<()>,
        ),
        (
            "SELECT content FROM game_releases WHERE game_id=?",
            vec![game],
            content_roots,
        ),
        (
            "SELECT value FROM snapshot_resources WHERE game_id=?",
            vec![game],
            blob_root,
        ),
        (
            "SELECT result FROM media_uploads WHERE scope=? AND state='completed' AND expires_at>?",
            vec![game, now],
            blob_root,
        ),
    ] {
        let mut statement = db.prepare(sql).map_err(db_error)?;
        let mut rows = statement
            .query(rusqlite::params_from_iter(args))
            .map_err(db_error)?;
        while let Some(row) = rows.next().map_err(db_error)? {
            let text: String = row.get(0).map_err(db_error)?;
            extract(&parse(&text)?, &mut roots)?;
        }
    }
    Ok(roots)
}

fn blob_root(value: &Value, roots: &mut HashSet<String>) -> Result<()> {
    roots.insert(fingerprint(&value["blobId"])?.to_owned());
    Ok(())
}

#[derive(Default)]
struct SweptBlobs {
    kept: HashSet<String>,
    removed: HashSet<String>,
    count: u64,
}

fn sweep_blobs(db: &Connection, game: &str, roots: &HashSet<String>) -> Result<SweptBlobs> {
    let mut select = db.prepare("SELECT id, json_extract(value,'$.object') FROM blobs WHERE game_id=? AND json_extract(value,'$.schemaVersion')=2").map_err(db_error)?;
    // Collect ids before mutating the source table.
    let rows = select
        .query_map([game], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let mut delete_aliases = db
        .prepare("DELETE FROM runtime_assets WHERE game_id=? AND blob_id=?")
        .map_err(db_error)?;
    let mut delete_blob = db
        .prepare("DELETE FROM blobs WHERE game_id=? AND id=?")
        .map_err(db_error)?;
    let mut swept = SweptBlobs::default();
    for (id, sha) in rows {
        if !valid_hash(&sha) {
            return Err(INVALID.into());
        }
        if roots.contains(&id) {
            swept.kept.insert(sha);
            continue;
        }
        delete_aliases
            .execute(params![game, id])
            .map_err(db_error)?;
        if delete_blob.execute(params![game, id]).map_err(db_error)? != 1 {
            return Err(INVALID.into());
        }
        swept.removed.insert(sha);
        swept.count += 1;
    }
    Ok(swept)
}

#[derive(Default)]
struct Reclaimed {
    files: u64,
    blobs: u64,
    objects: u64,
    bytes: u128,
}

fn queue_objects(db: &Connection, game: &str, now: &str, blobs: SweptBlobs) -> Result<Reclaimed> {
    let mut select = db.prepare("SELECT id, sha256, size FROM media_objects WHERE game_id=? AND state='ready'
        AND id NOT IN (SELECT object_id FROM media_leases WHERE object_id IS NOT NULL AND kind='read' AND expires_at>?)").map_err(db_error)?;
    let ready = select
        .query_map(params![game, now], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let mut mark = db
        .prepare("UPDATE media_objects SET state='deleting' WHERE id=?")
        .map_err(db_error)?;
    let mut reclaimed = Reclaimed {
        files: blobs.count,
        blobs: blobs.count,
        ..Reclaimed::default()
    };
    for (id, sha, size) in ready {
        if blobs.kept.contains(&sha) {
            continue;
        }
        if mark.execute([id]).map_err(db_error)? != 1 {
            return Err(INVALID.into());
        }
        reclaimed.objects += 1;
        // A physical object already counted through a removed blob isn't another file.
        reclaimed.files += u64::from(!blobs.removed.contains(&sha));
        reclaimed.bytes += u128::try_from(size).map_err(|_| INVALID)?;
    }
    Ok(reclaimed)
}

fn clean_game(db: &mut Connection, game: &str) -> Result<Option<Reclaimed>> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let now: String = tx
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .map_err(db_error)?;
    let editing: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM media_leases WHERE game_id=? AND kind='editor' AND expires_at>?)", params![game, now], |r| r.get(0)).map_err(db_error)?;
    if editing {
        return Ok(None);
    }
    let value: Option<String> = tx
        .query_row("SELECT value FROM games WHERE id=?", [game], |r| r.get(0))
        .optional()
        .map_err(db_error)?;
    let mut reclaimed = Reclaimed::default();
    if let Some(value) = value {
        let roots = collect_roots(&tx, game, &now, &value)?;
        let blobs = sweep_blobs(&tx, game, &roots)?;
        reclaimed = queue_objects(&tx, game, &now, blobs)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(Some(reclaimed))
}

fn clean_storage(db: &mut Connection) -> Result<Value> {
    let games = db
        .prepare("SELECT id FROM games ORDER BY id")
        .map_err(db_error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let mut total = Reclaimed::default();
    let mut editing = 0;
    let mut unreadable = 0;
    for game in games {
        match clean_game(db, &game) {
            Ok(Some(result)) => {
                total.files += result.files;
                total.blobs += result.blobs;
                total.objects += result.objects;
                total.bytes += result.bytes;
            }
            Ok(None) => editing += 1,
            Err(_) => unreadable += 1,
        }
    }
    media_uploads::wake();
    Ok(
        json!({"cleanedFiles": total.files, "removedBlobs": total.blobs, "queuedObjects": total.objects,
        "reclaimableBytes": total.bytes.to_string(), "skippedEditing": editing, "skippedUnreadable": unreadable}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum LeaseAction {
    Renew,
    Release,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    CleanStorage {},
    EditorLease {
        game_id: String,
        lease_id: String,
        action: LeaseAction,
    },
}

fn update_editor_lease(
    db: &Connection,
    game: &str,
    lease: &str,
    action: LeaseAction,
) -> Result<()> {
    if game.trim().is_empty()
        || lease.len() != 32
        || !lease
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(INVALID.into());
    }
    let id = format!("editor:{lease}");
    match action {
        LeaseAction::Release => {
            db.execute(
                "DELETE FROM media_leases WHERE id=? AND game_id=? AND kind='editor'",
                params![id, game],
            )
            .map_err(db_error)?;
        }
        LeaseAction::Renew => {
            let changes = db.execute("INSERT INTO media_leases(id,game_id,object_id,kind,expires_at)
                SELECT ?1,id,NULL,'editor',strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') FROM games WHERE id=?2
                ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at
                WHERE media_leases.game_id=excluded.game_id AND media_leases.kind='editor' AND media_leases.object_id IS NULL", params![id, game]).map_err(db_error)?;
            if changes != 1 {
                return Err("편집 중인 게임을 보호할 수 없어요.".into());
            }
        }
    }
    Ok(())
}

pub(super) fn request(path: &Path, input: Value) -> Result<Value> {
    let request = serde_json::from_value(input).map_err(|_| INVALID)?;
    let mut db = open(path)?;
    let mut reply = json!({"version":0,"records":[]});
    match request {
        Request::CleanStorage {} => reply["storageCleanup"] = clean_storage(&mut db)?,
        Request::EditorLease {
            game_id,
            lease_id,
            action,
        } => update_editor_lease(&db, &game_id, &lease_id, action)?,
    }
    Ok(reply)
}
