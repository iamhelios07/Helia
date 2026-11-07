import type Database from 'better-sqlite3';
import { readEditorDraft, type EditorDraft } from '#lib/games/editor.js';

export interface SavedEditorDraft {
	version: number;
	draft: EditorDraft | null;
}
/** Separate from installed content; the game foreign key gives drafts the same deletion lifetime. */
export function editorDraftStorage(connection: Database.Database) {
	connection.exec(
		'CREATE TABLE IF NOT EXISTS editor_drafts (game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, version INTEGER NOT NULL, value TEXT)'
	);
	function read(gameId: string): SavedEditorDraft {
		if (!connection.prepare('SELECT id FROM games WHERE id=?').get(gameId))
			throw Error('게임을 찾을 수 없어요.');
		const row = connection
			.prepare('SELECT version,value FROM editor_drafts WHERE game_id=?')
			.get(gameId) as { version: number; value: string | null } | undefined;
		return {
			version: row?.version ?? 0,
			draft: row?.value ? readEditorDraft(row.value, gameId) : null
		};
	}
	function write(gameId: string, draft: EditorDraft | null, version: number): SavedEditorDraft {
		return connection.transaction(() => {
			const previous = read(gameId);
			if (
				!Number.isSafeInteger(version) ||
				version >= Number.MAX_SAFE_INTEGER ||
				version !== previous.version
			)
				throw Error('EDITOR_DRAFT_CONFLICT');
			const text = draft === null ? null : JSON.stringify(draft);
			if (text !== null) readEditorDraft(text, gameId);
			connection
				.prepare(
					'INSERT INTO editor_drafts (game_id,version,value) VALUES (?,?,?) ON CONFLICT(game_id) DO UPDATE SET version=excluded.version,value=excluded.value'
				)
				.run(gameId, version + 1, text);
			return { version: version + 1, draft };
		})();
	}
	return { read, write };
}
