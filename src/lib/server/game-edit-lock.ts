import type Database from 'better-sqlite3';

import { isDeepStrictEqual } from 'node:util';

import type { Game } from '#lib/games/model.js';

import { assertEditOperation, parseEditLock, type EditOperation } from '#lib/games/edit-lock.js';
import { CONFLICT, type StorageReply } from '#lib/storage/protocol.js';

function savedEditLock(db: Database.Database, gameId: string) {
	const row = db
		.prepare(
			"SELECT json_extract(value,'$.editLock') AS editLock, json_type(value,'$.editLock') AS lockType, version FROM games WHERE id=?"
		)
		.get(gameId) as { editLock: unknown; lockType: string | null; version: number } | undefined;
	if (!row) {
		throw Error('게임을 찾을 수 없어요.');
	}
	const editLock =
		row.lockType === null
			? undefined
			: parseEditLock(['true', 'false'].includes(row.lockType) ? row.editLock === 1 : row.editLock);
	return { editLock, version: row.version };
}

export function guardGameEdit(db: Database.Database, gameId: string, operation: EditOperation) {
	assertEditOperation(savedEditLock(db, gameId).editLock, operation);
}

/** Compare executable content too: a forged runtime build must not bypass the authoring lock. */
export function guardGameContent(previous: Game | undefined, incoming: Game) {
	if (previous?.editLock !== true) {
		return;
	}
	const fields = [
		'title',
		'genre',
		'description',
		'settings',
		'schema',
		'initialState',
		'scripts',
		'ui',
		'ai',
		'regex',
		'resources',
		'code'
	] as const;
	// Stored locked games are fixed points of parseGame normalization.
	if (fields.some((field) => !isDeepStrictEqual(previous[field], incoming[field]))) {
		assertEditOperation(previous.editLock, 'apply');
	}
}

/** Caller owns the IMMEDIATE transaction. Repeated unlocks are harmless and preserve revisions. */
export function unlockGame(db: Database.Database, gameId: string): StorageReply {
	const row = db.prepare('SELECT value, version FROM games WHERE id=?').get(gameId) as
		{ value: string; version: number } | undefined;
	if (!row) {
		throw Error('게임을 찾을 수 없어요.');
	}
	const game = JSON.parse(row.value) as Record<string, unknown>;
	const editLock = Object.hasOwn(game, 'editLock') ? parseEditLock(game.editLock) : undefined;
	const { version } = row;
	if (editLock !== true) {
		return { version, records: [] };
	}
	const result = db
		.prepare('UPDATE games SET value=?, version=version+1 WHERE id=? AND version<9007199254740991')
		.run(JSON.stringify({ ...game, editLock: false }), gameId);
	if (result.changes !== 1) {
		throw Error(CONFLICT);
	}
	return { version: version + 1, records: [] };
}
