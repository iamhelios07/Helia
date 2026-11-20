CREATE TABLE IF NOT EXISTS session_files (
  ref TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  created_at TEXT NOT NULL,
  data BLOB NOT NULL,
  FOREIGN KEY(session_id, game_id) REFERENCES sessions(id, game_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_files_owner ON session_files(game_id, session_id, ref);
