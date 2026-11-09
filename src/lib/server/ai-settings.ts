import type Database from 'better-sqlite3';

import { parseAISettings, type AISettings } from '#lib/app/settings/model.js';

export const AI_SETTINGS_CONFLICT = 'AI_SETTINGS_CONFLICT';

export interface SavedAISettings {
	settings: AISettings | null;
	revision: number;
}

/** One server-wide document, separate from the encrypted credential store. */
export function aiSettingsStorage(connection: Database.Database) {
	connection.exec(
		'CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision > 0), value TEXT NOT NULL)'
	);
	function read(): SavedAISettings {
		const row = connection.prepare('SELECT revision,value FROM ai_settings WHERE id=1').get() as
			{ revision: number; value: string } | undefined;
		if (!row) {
			return { settings: null, revision: 0 };
		}
		if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
			throw new Error('저장된 AI 설정을 읽을 수 없어요.');
		}
		return { settings: parseAISettings(JSON.parse(row.value)), revision: row.revision };
	}
	function initialize(value: unknown): SavedAISettings {
		const settings = parseAISettings(value);
		return connection
			.transaction(() => {
				connection
					.prepare(
						'INSERT INTO ai_settings (id,revision,value) VALUES (1,1,?) ON CONFLICT(id) DO NOTHING'
					)
					.run(JSON.stringify(settings));
				return read();
			})
			.immediate();
	}
	function write(value: unknown, revision: number): SavedAISettings {
		const settings = parseAISettings(value);
		if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
			throw new Error(AI_SETTINGS_CONFLICT);
		}
		return connection
			.transaction(() => {
				const result = connection
					.prepare('UPDATE ai_settings SET value=?, revision=revision+1 WHERE id=1 AND revision=?')
					.run(JSON.stringify(settings), revision);
				if (result.changes !== 1) {
					throw new Error(AI_SETTINGS_CONFLICT);
				}
				return read();
			})
			.immediate();
	}
	return { read, initialize, write };
}
