-- Objects deliberately have no game foreign key: byte reclamation is incremental.
CREATE TABLE IF NOT EXISTS media_objects (
 id TEXT PRIMARY KEY,
 game_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('staging','verified','ready','deleting')),
 size INTEGER NOT NULL CHECK(size > 0),
 chunk_size INTEGER NOT NULL CHECK(chunk_size > 0),
 sha256 TEXT,
 crc32 INTEGER,
 created_at TEXT NOT NULL,
 CHECK(state <> 'ready' OR (game_id IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS media_objects_ready
 ON media_objects(game_id, sha256) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS media_objects_state ON media_objects(state);
CREATE INDEX IF NOT EXISTS media_objects_game ON media_objects(game_id, state);

-- No cascade: chunks and active uploads must be removed before the object.
CREATE TABLE IF NOT EXISTS media_chunks (
 object_id TEXT NOT NULL REFERENCES media_objects(id),
 idx INTEGER NOT NULL CHECK(idx >= 0),
 sha256 TEXT NOT NULL,
 data BLOB NOT NULL,
 PRIMARY KEY(object_id, idx)
);

CREATE TABLE IF NOT EXISTS media_uploads (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('edit','install','package-content','document')),
 mime TEXT NOT NULL,
 label TEXT,
 operation TEXT CHECK(operation IN ('draftSave','commit','releaseCreate')),
 size INTEGER NOT NULL,
 chunk_size INTEGER NOT NULL,
 chunk_count INTEGER NOT NULL,
 object_id TEXT REFERENCES media_objects(id),
 state TEXT NOT NULL CHECK(state IN
  ('receiving','finishing','completed','verified','consumed','failed','cancelled')),
 generation INTEGER NOT NULL DEFAULT 0,
 declared_sha256 TEXT,
 result TEXT,
 error TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 CHECK((state IN ('receiving','finishing','verified')) = (object_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS media_uploads_scope ON media_uploads(scope, state);
CREATE INDEX IF NOT EXISTS media_uploads_expiry ON media_uploads(expires_at);

CREATE TABLE IF NOT EXISTS media_leases (
 id TEXT PRIMARY KEY,
 game_id TEXT NOT NULL,
 object_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('editor','read')),
 expires_at TEXT NOT NULL
);
