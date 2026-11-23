CREATE TABLE IF NOT EXISTS game_releases (
 id TEXT PRIMARY KEY,
 game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 original_game_id TEXT NOT NULL,
 content_version TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 content TEXT NOT NULL CHECK(json_valid(content)),
 UNIQUE(game_id, id),
 UNIQUE(game_id, content_version, content_hash)
);
CREATE INDEX IF NOT EXISTS game_releases_identity ON game_releases(original_game_id, content_version);
CREATE INDEX IF NOT EXISTS game_releases_owner ON game_releases(game_id);
CREATE TABLE IF NOT EXISTS game_release_selection (
 game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
 release_id TEXT NOT NULL,
 FOREIGN KEY(game_id, release_id) REFERENCES game_releases(game_id, id)
);
CREATE TRIGGER IF NOT EXISTS game_releases_immutable
BEFORE UPDATE ON game_releases BEGIN
 SELECT RAISE(ABORT, 'Game releases are immutable');
END;
