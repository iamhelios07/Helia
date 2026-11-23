CREATE TABLE IF NOT EXISTS runtime_artifacts (
 game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(game_id,hash)
);
CREATE TABLE IF NOT EXISTS runtime_assets (
 game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, blob_id TEXT NOT NULL,
 PRIMARY KEY(game_id,hash)
);
