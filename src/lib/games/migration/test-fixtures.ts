import { storedRecord } from '#lib/storage/protocol.js';
import { StorageUnit } from '#lib/storage/unit.js';

import type { Game } from '../model.js';
import type { BaselineSelection, MigrationSource } from '../state/baseline.js';
import type { ObjectSchema } from '../state/schema.js';

import { NO_BASELINES } from '../state/baseline.js';
import { canonical } from '../state/model.js';

export const GOLD_SCHEMA: ObjectSchema = {
	type: 'object',
	properties: { gold: { type: 'integer' } },
	required: ['gold'],
	additionalProperties: false
};
export const COINS_SCHEMA: ObjectSchema = {
	type: 'object',
	properties: { coins: { type: 'integer' } },
	required: ['coins'],
	additionalProperties: false
};
export const binding = { contentHash: 'content', targetReleaseId: 'release', fromVersion: '1.0.0' };
export function migrationGame(
	body = 'return {...migrated,coins:previous.gold};',
	prefix = ''
): Game {
	const source = `${prefix}helia.defineMigration({name:'rename',from:'<2.0.0',run({previous,migrated,previousSchema,from}){${body}}});`;
	return {
		schemaVersion: 2,
		id: 'game',
		activeSessionId: 'a',
		title: 'Test',
		genre: '',
		description: '',
		createdAt: '2026-11-24T00:00:00Z',
		updatedAt: '2026-11-24T00:00:00Z',
		settings: { description: '', firstMessage: '', authorNote: '' },
		schema: structuredClone(COINS_SCHEMA),
		initialState: { coins: 0 },
		scripts: { rules: { language: 'typescript', source, compiled: source } }
	};
}
export function migrationSource(
	values = [12, 30, 15],
	baselines: BaselineSelection = NO_BASELINES,
	ids = ['a']
): MigrationSource {
	const game = migrationGame();
	const unit = new StorageUnit({
		version: 1,
		records: [
			storedRecord('snapshots', {
				...game,
				schemaVersion: 1,
				id: 'old',
				gameId: game.id,
				schema: GOLD_SCHEMA,
				initialState: { gold: 10 },
				scripts: {}
			})
		]
	});
	for (const id of ids) {
		unit.put('sessions', {
			schemaVersion: 1,
			id,
			gameId: game.id,
			title: id,
			createdAt: game.createdAt,
			updatedAt: game.updatedAt
		});
		values.forEach((gold, index) =>
			unit.put('transactions', {
				schemaVersion: 2,
				id: `${id}-${index}`,
				gameId: game.id,
				sessionId: id,
				parentId: null,
				createdAt: game.createdAt,
				createdRevision: index + 1,
				action: { name: 'test', args: {} },
				changes: [
					{
						path: ['gold'],
						before: { exists: true, value: 10 },
						after: { exists: true, value: gold }
					}
				]
			})
		);
		unit.put('progress', {
			schemaVersion: 2,
			gameId: game.id,
			sessionId: id,
			snapshotId: 'old',
			headId: values.length ? `${id}-${values.length - 1}` : null,
			revision: values.length,
			state: { gold: values.at(-1) ?? 10 }
		});
	}
	return { unit, baselines };
}
export function invocation(game = migrationGame(), previous = { gold: 42 }) {
	return {
		name: 'rename',
		scriptId: 'rules',
		from: '1.0.0',
		previous: canonical(previous),
		previousSchema: canonical(GOLD_SCHEMA),
		migrated: canonical(game.initialState)
	};
}
