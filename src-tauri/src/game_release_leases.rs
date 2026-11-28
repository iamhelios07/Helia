use rusqlite::{Connection, ErrorCode, OptionalExtension, params};
use std::time::{Duration, Instant};

/// All referenced objects stay pinned, including objects not yet reached by the digest.
pub(super) struct ReadLeases<'a> {
    connection: &'a Connection,
    ids: Vec<String>,
    renewed: Instant,
}

impl<'a> ReadLeases<'a> {
    pub(super) fn new(connection: &'a Connection, renewed: Instant) -> Self {
        Self {
            connection,
            ids: Vec::new(),
            renewed,
        }
    }

    pub(super) fn add(&mut self, game_id: &str, object: &str) -> Result<(), String> {
        let id = super::uuid()?;
        self.connection.execute(
            "INSERT INTO media_leases VALUES(?1,?2,?3,'read',strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes'))",
            params![id, game_id, object],
        ).map_err(super::db_error)?;
        self.ids.push(id);
        Ok(())
    }

    /// Resolve and pin in one transaction before opening the media reader.
    pub(super) fn pin(&mut self, game_id: &str, blob_id: &str) -> Result<String, String> {
        let tx = self
            .connection
            .unchecked_transaction()
            .map_err(super::db_error)?;
        let blob = super::owned_blob(&tx, game_id, blob_id)?;
        if blob["schemaVersion"] != 2 {
            return Err(super::packages::error("missingAsset"));
        }
        let object: String = tx
            .query_row(
                "SELECT id FROM media_objects WHERE game_id=?1 AND sha256=?2 AND state='ready'",
                params![game_id, blob["object"].as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(super::db_error)?
            .ok_or_else(|| super::packages::error("missingAsset"))?;
        self.add(game_id, &object)?;
        tx.commit().map_err(super::db_error)?;
        Ok(object)
    }

    fn update(&self) -> rusqlite::Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        for id in &self.ids {
            let changed = tx.execute(
                "UPDATE media_leases SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes')
                 WHERE id=?1 AND kind='read' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                [id],
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        tx.commit()
    }

    pub(super) fn renew(&mut self, now: Instant) -> Result<(), String> {
        let elapsed = now.duration_since(self.renewed);
        if elapsed < Duration::from_secs(60) {
            return Ok(());
        }
        // Never resume a digest whose protection has already expired.
        if elapsed >= Duration::from_secs(180) {
            return Err(super::packages::error("missingAsset"));
        }
        match self.update() {
            Ok(()) => {
                self.renewed = now;
                Ok(())
            }
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                ) =>
            {
                // Leave the timestamp due so the next chunk retries a transient lock failure.
                Ok(())
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err(super::packages::error("missingAsset"))
            }
            Err(error) => Err(super::db_error(error)),
        }
    }
}

impl Drop for ReadLeases<'_> {
    fn drop(&mut self) {
        for id in &self.ids {
            let _ = self
                .connection
                .execute("DELETE FROM media_leases WHERE id=?1", [id]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renewal_retries_transient_locks_on_the_next_chunk_and_stops_at_expiry() {
        let path = std::env::temp_dir().join(format!(
            "helia-read-leases-{}.sqlite",
            super::super::uuid().unwrap()
        ));
        let db = Connection::open(&path).unwrap();
        db.execute_batch(crate::runtime_content::MEDIA_SCHEMA)
            .unwrap();
        db.busy_timeout(Duration::ZERO).unwrap();
        db.execute_batch("CREATE TABLE renewals(id TEXT); CREATE TRIGGER renewed AFTER UPDATE ON media_leases BEGIN INSERT INTO renewals VALUES(NEW.id); END;").unwrap();
        let start = Instant::now();
        let mut leases = ReadLeases::new(&db, start);
        leases.add("game", "one").unwrap();
        leases.add("game", "two").unwrap();
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        leases.renew(start + Duration::from_secs(60)).unwrap();
        writer.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM renewals", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        leases.renew(start + Duration::from_secs(61)).unwrap();
        assert_eq!(
            db.query_row("SELECT count(DISTINCT id) FROM renewals", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        leases.renew(start + Duration::from_secs(121)).unwrap();
        assert_eq!(
            leases.renew(start + Duration::from_secs(241)).unwrap_err(),
            super::super::packages::error("missingAsset")
        );
        writer.execute_batch("ROLLBACK").unwrap();
        drop(leases);
        drop(writer);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_or_expired_lease_aborts_instead_of_silently_continuing() {
        for missing in [true, false] {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch(crate::runtime_content::MEDIA_SCHEMA)
                .unwrap();
            let start = Instant::now();
            let mut leases = ReadLeases::new(&db, start);
            leases.add("game", "one").unwrap();
            db.execute_batch(if missing {
                "DELETE FROM media_leases"
            } else {
                "UPDATE media_leases SET expires_at='2000-01-01'"
            })
            .unwrap();
            assert_eq!(
                leases.renew(start + Duration::from_secs(60)).unwrap_err(),
                super::super::packages::error("missingAsset")
            );
        }
    }
}
