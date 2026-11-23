import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Game } from '#lib/games/model.js';
import type { StorageTransport } from '#lib/storage/protocol.js';

import { parseGame } from '#lib/games/model.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { parseReply, parseRequest, storedRecord } from '#lib/storage/protocol.js';

import { openStorage } from './sqlite.js';

let storage: ReturnType<typeof openStorage>;
let repository: ReturnType<typeof createGameRepository>;
const transport: StorageTransport = async (request) =>
	parseReply(storage.request(JSON.parse(JSON.stringify(request))));
beforeEach(() => {
	storage = openStorage(':memory:');
	repository = createGameRepository(transport);
});
afterEach(() => storage.close());

/** A second installation is created through the validated wire contract, retaining its origin. */
async function installCopy(source: Game, title = 'Another installation') {
	const workspace = await repository.getGameWorkspace(source.id);
	const session = workspace?.sessions.find((item) => item.id === source.activeSessionId);
	if (!session || !source.originalGameId) {
		throw Error('Missing source installation fixture');
	}
	const gameId = randomUUID();
	const sessionId = randomUUID();
	const copy = parseGame({ ...source, id: gameId, title, activeSessionId: sessionId });
	await transport(
		parseRequest({
			kind: 'create',
			gameId,
			records: [
				storedRecord('games', copy),
				storedRecord('sessions', { ...session, id: sessionId, gameId })
			]
		})
	);
	return copy;
}

const countReleases = () =>
	storage.connection.prepare('SELECT COUNT(*) FROM game_releases').pluck().get();

it('conflicts across active installations with the same original identity and version but different content', async () => {
	const original = await repository.createGame();
	const first = await repository.createGameRelease(original.id, '1.0.0');
	expect(first.kind).toBe('released');
	const copy = await installCopy(original);
	expect(copy.id).not.toBe(original.id);
	expect(copy.activeSessionId).not.toBe(original.activeSessionId);
	expect(copy.originalGameId).toBe(original.originalGameId);
	const before = await repository.getGameVersioning(copy.id);
	const result = await repository.createGameRelease(copy.id, '1.0.0', {
		expectedContentHash: before.contentHash
	});
	expect(result).toEqual({
		kind: 'conflict',
		contentVersion: '1.0.0',
		existingHashes: [(await repository.getGameVersioning(original.id)).contentHash],
		incomingHash: before.contentHash
	});
	expect(await repository.getGameVersioning(copy.id)).toEqual(before);
	expect(countReleases()).toBe(1);
});

it('does not conflict across unrelated original identities', async () => {
	const first = await repository.createGame();
	const unrelated = await repository.createGame({
		title: 'Unrelated content',
		genre: '',
		description: ''
	});
	expect(first.originalGameId).not.toBe(unrelated.originalGameId);
	expect((await repository.createGameRelease(first.id, '1.0.0')).kind).toBe('released');
	expect((await repository.createGameRelease(unrelated.id, '1.0.0')).kind).toBe('released');
	expect(countReleases()).toBe(2);
});

it('keeps new installation ownership independent when the old same-origin installation is trashed or restored', async () => {
	const original = await repository.createGame();
	await repository.createGameRelease(original.id, '1.0.0');
	const oldRelease = (await repository.getGameVersioning(original.id)).currentRelease!;
	await repository.trashGame(original.id);
	const copy = await installCopy(original);
	expect((await repository.createGameRelease(copy.id, '1.0.0')).kind).toBe('released');
	const ownState = await repository.getGameVersioning(copy.id);
	expect(ownState.currentRelease?.id).not.toBe(oldRelease.id);
	expect(ownState.releases).toHaveLength(1);
	expect((await repository.listGames()).map((item) => item.id)).toContain(copy.id);
	expect((await repository.listGames()).map((item) => item.id)).not.toContain(original.id);
	await expect(repository.getGameRelease(copy.id, oldRelease.id)).rejects.toThrow();
	await repository.restoreGame(original.id);
	expect(await repository.getGameVersioning(copy.id)).toEqual(ownState);
	const release = await repository.getGameRelease(copy.id, ownState.currentRelease!.id);
	expect(release.content.title).toBe(copy.title);
	expect((await repository.getGameWorkspace(copy.id))?.game.originalGameId).toBe(
		original.originalGameId
	);
});

it.each(['record', 'patch'] as const)(
	'rejects original identity reassignment through a normal %s commit',
	async (kind) => {
		const original = await repository.createGame();
		await repository.createGameRelease(original.id, '1.0.0');
		const before = await transport({ kind: 'read', gameId: original.id });
		const reassigned = randomUUID();
		const records =
			kind === 'record' ? [storedRecord('games', { ...original, originalGameId: reassigned })] : [];
		const gamePatch =
			kind === 'patch' ? { set: { originalGameId: reassigned }, remove: [] } : undefined;
		expect(() =>
			storage.request({
				kind: 'commit',
				gameId: original.id,
				version: before.version,
				records,
				deleteSessions: [],
				...(gamePatch ? { gamePatch } : {})
			})
		).toThrow();
		expect(await transport({ kind: 'read', gameId: original.id })).toEqual(before);
		expect(countReleases()).toBe(1);
	}
);

it('preserves the assigned origin when an older client omits it from a normal commit', async () => {
	const original = await repository.createGame();
	const before = await transport({ kind: 'read', gameId: original.id });
	storage.request({
		kind: 'commit',
		gameId: original.id,
		version: before.version,
		records: [],
		deleteSessions: [],
		gamePatch: { set: { title: 'Older client edit' }, remove: ['originalGameId'] }
	});
	const saved = (await repository.getGameWorkspace(original.id))!.game;
	expect(saved.title).toBe('Older client edit');
	expect(saved.originalGameId).toBe(original.originalGameId);
});

describe('SQLite release write guarantees', () => {
	it('rejects mutation of an already stored frozen release', async () => {
		const game = await repository.createGame();
		await repository.createGameRelease(game.id, '1.0.0');
		const before = await repository.getGameVersioning(game.id);
		expect(() =>
			storage.connection
				.prepare('UPDATE game_releases SET content_version=?, content=? WHERE game_id=?')
				.run('9.0.0', '{}', game.id)
		).toThrow(/immutable/i);
		expect(await repository.getGameVersioning(game.id)).toEqual(before);
		expect(countReleases()).toBe(1);
	});

	it.each([
		{ contentVersion: '01.0.0' },
		{ contentVersion: '1.0.0-alpha.01' },
		{ contentVersion: '1.0.0\n' },
		{ ignoreConflict: true },
		{ ignoreConflict: 'yes' },
		{ expectedContentHash: 'not-a-hash' },
		{ expectedContentHash: 'a'.repeat(63) },
		{ action: 'publish' }
	])('rejects malformed release requests atomically: %j', async (change) => {
		const game = await repository.createGame();
		const before = await repository.getGameVersioning(game.id);
		expect(() =>
			storage.request({
				kind: 'versioning',
				action: 'release',
				gameId: game.id,
				contentVersion: '1.0.0',
				...change
			})
		).toThrow();
		expect(countReleases()).toBe(0);
		expect(await repository.getGameVersioning(game.id)).toEqual(before);
	});

	it('preserves authoritative session revisions, branches and history when releasing', async () => {
		const game = await repository.createGame();
		const history = await repository.getSessionHistory(game.id, game.activeSessionId);
		await repository.commitSessionTransaction(game.id, game.activeSessionId, {
			expectedRevision: history.progress.revision,
			parentId: history.progress.headId,
			action: { name: 'look', args: {} },
			nextState: history.progress.state,
			message: { role: 'assistant', content: 'A room appears.' },
			description: 'Look around'
		});
		const beforeTimeline = await repository.getSessionTimeline(game.id, game.activeSessionId);
		const beforeRecords = await transport({
			kind: 'read',
			gameId: game.id,
			sessionId: game.activeSessionId,
			includeHistory: true
		});
		const state = await repository.getGameVersioning(game.id);
		expect(
			(
				await repository.createGameRelease(game.id, '1.0.0', {
					expectedContentHash: state.contentHash
				})
			).kind
		).toBe('released');
		expect(await repository.getSessionTimeline(game.id, game.activeSessionId)).toEqual(
			beforeTimeline
		);
		expect(
			await transport({
				kind: 'read',
				gameId: game.id,
				sessionId: game.activeSessionId,
				includeHistory: true
			})
		).toEqual(beforeRecords);
		expect((await repository.getGameWorkspace(game.id))?.game.activeSessionId).toBe(
			game.activeSessionId
		);
	});
});
