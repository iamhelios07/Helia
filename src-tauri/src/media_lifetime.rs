//! Only detached/deleting bytes are reclaimed. No search for unreferenced ready blobs.
use super::*;
use std::sync::{OnceLock, mpsc};
#[cfg(feature = "desktop")]
use std::thread;

static QUEUE: OnceLock<mpsc::SyncSender<()>> = OnceLock::new();
pub(super) fn wake() {
    if let Some(queue) = QUEUE.get() {
        let _ = queue.try_send(());
    }
}

pub(super) fn end(db: &Connection, id: &str, state: &str, reason: &str) -> Result<()> {
    db.execute("UPDATE media_objects SET state='deleting' WHERE id=(SELECT object_id FROM media_uploads WHERE id=?1)",[id])?;
    db.execute("UPDATE media_uploads SET state=?2,object_id=NULL,result=NULL,error=?3,expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE id=?1 AND object_id IS NOT NULL",params![id,state,reason])?;
    db.execute("DELETE FROM media_leases WHERE kind='read' AND id=?1", [id])?;
    Ok(())
}
pub(crate) fn purge(db: &Connection, game: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM media_uploads WHERE scope=? AND object_id IS NULL",
        [game],
    )?;
    let unowned: Vec<String> = db.prepare("SELECT o.id FROM media_objects o JOIN media_uploads u ON u.object_id=o.id WHERE u.scope=? AND o.game_id IS NULL")?
        .query_map([game], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    db.execute("UPDATE media_uploads SET state='cancelled',object_id=NULL,result=NULL,error='gameDeleted',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE scope=?",[game])?;
    db.execute(
        "UPDATE media_objects SET state='deleting' WHERE game_id=?",
        [game],
    )?;
    for object in unowned {
        db.execute(
            "UPDATE media_objects SET state='deleting' WHERE id=?",
            [object],
        )?;
    }
    db.execute(
        "DELETE FROM media_leases WHERE game_id=? AND kind='editor'",
        [game],
    )?;
    Ok(())
}
pub(super) fn expire(db: &mut Connection, startup: bool) -> Result<()> {
    loop {
        let tx = immediate(db)?;
        let rows: Vec<(String, bool)> = tx.prepare(
            "SELECT id, object_id IS NOT NULL FROM media_uploads
             WHERE (?1 AND object_id IS NOT NULL) OR expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             LIMIT 100"
        )?.query_map([startup], |row| Ok((row.get(0)?,row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, active) in &rows {
            if *active {
                end(
                    &tx,
                    id,
                    "cancelled",
                    if startup { "restarted" } else { "expired" },
                )?;
            } else {
                tx.execute("DELETE FROM media_uploads WHERE id=?", [id])?;
            }
        }
        tx.commit()?;
        if rows.len() < 100 {
            break;
        }
    }
    db.execute(
        "DELETE FROM media_leases WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
    )?;
    if startup {
        db.execute("UPDATE media_objects SET state='deleting' WHERE state<>'deleting' AND ((game_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM games WHERE id=media_objects.game_id)) OR (state IN ('staging','verified') AND NOT EXISTS(SELECT 1 FROM media_uploads WHERE object_id=media_objects.id)))",[])?;
    }
    Ok(())
}
pub(super) fn step(db: &mut Connection) -> Result<bool> {
    let tx = immediate(db)?;
    let object: Option<String> = tx
        .query_row(
            "SELECT id FROM media_objects o WHERE state='deleting' AND NOT EXISTS (
            SELECT 1 FROM media_leases WHERE kind='read' AND object_id=o.id
            AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ) LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(object) = object else {
        return Ok(false);
    };
    tx.execute("DELETE FROM media_chunks WHERE rowid IN (SELECT rowid FROM media_chunks WHERE object_id=? LIMIT 32)",[&object])?;
    tx.execute("DELETE FROM media_objects WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM media_chunks WHERE object_id=?1)",[&object])?;
    tx.commit()?;
    Ok(true)
}
/// One worker per host, never one per IPC connection. Retry unsuccessful batches on the next tick.
#[cfg(feature = "desktop")]
pub(crate) fn start(path: &Path) -> std::result::Result<(), String> {
    let mut db = super::super::open(path)?;
    expire(&mut db, true).map_err(Failure::message)?;
    let (send, recv) = mpsc::sync_channel(1);
    QUEUE
        .set(send)
        .map_err(|_| "Media worker already started")?;
    thread::spawn(move || {
        let period = Duration::from_secs(60);
        let mut tick = Instant::now() + period;
        loop {
            if Instant::now() >= tick {
                let _ = expire(&mut db, false);
                tick = Instant::now() + period;
            }
            if step(&mut db).unwrap_or(false) {
                // Give ordinary saves a chance to acquire the writer between committed batches.
                thread::sleep(Duration::from_millis(2));
                continue;
            }
            let _ = recv.recv_timeout(tick.saturating_duration_since(Instant::now()));
        }
    });
    Ok(())
}
