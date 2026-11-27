import { afterEach, beforeEach, expect, it } from 'vitest';

import { openStorage } from '#lib/server/sqlite.js';
import { storageAsset, storageSync } from '#lib/server/storage-sync.js';
import { parseReply, storedRecord } from '#lib/storage/protocol.js';

import { editorContent } from './editor.js';
import { createGameRepository } from './repository-core.js';
import legacy from './state/fixtures/legacy-content.json';
import { contentHash } from './state/model.js';

let storage: ReturnType<typeof openStorage>;
let repository: ReturnType<typeof createGameRepository>;
const sessionId = 'session';
const gameId = legacy.snapshot.gameId;
const { settings, initialState, schema, scripts } = legacy.snapshot;

beforeEach(() => {
	storage = openStorage(':memory:');
	repository = createGameRepository(async (request) => parseReply(storage.request(request)));
	const now = legacy.snapshot.createdAt;
	storage.request({
		kind: 'create',
		gameId,
		records: [
			storedRecord('games', {
				schemaVersion: 2,
				id: gameId,
				activeSessionId: sessionId,
				title: 'Legacy game',
				genre: '',
				description: '',
				createdAt: now,
				updatedAt: now,
				settings,
				initialState,
				schema,
				scripts,
				resources: legacy.resources
			}),
			storedRecord('sessions', {
				schemaVersion: 1,
				id: sessionId,
				gameId,
				title: 'Legacy session',
				createdAt: now,
				updatedAt: now
			})
		]
	});
	storage.request({
		kind: 'commit',
		gameId,
		version: 0,
		deleteSessions: [],
		records: [
			storedRecord('snapshots', legacy.snapshot),
			storedRecord('blobs', legacy.blob),
			storedRecord('snapshot_resources', legacy.reference),
			storedRecord('progress', {
				schemaVersion: 2,
				sessionId,
				gameId,
				snapshotId: legacy.snapshot.id,
				headId: null,
				revision: 0,
				state: initialState
			})
		]
	});
});
afterEach(() => storage.close());

it('preserves old IDs while new sessions deduplicate SHA snapshots and blobs', async () => {
	const old = await repository.getSessionHistory(gameId, sessionId);
	expect(old.snapshot.id).toBe(legacy.snapshot.id);
	expect(old.resources).toEqual(legacy.resources);
	const newBlobId = contentHash([gameId, legacy.blob.data]);
	const expectedId = contentHash({
		settings,
		initialState,
		schema,
		scripts,
		resources: {
			portrait: { name: legacy.reference.name, mime: legacy.blob.mime, blobId: newBlobId }
		}
	});
	expect(newBlobId).toBe(legacy.sha256Ids.blob);
	expect(expectedId).toBe(legacy.sha256Ids.snapshot);
	const second = await repository.createSession(gameId);
	const fresh = await repository.getSessionHistory(gameId, second.id);
	expect(fresh.snapshot.id).toBe(expectedId);
	expect(fresh.snapshot.id).not.toBe(old.snapshot.id);
	expect(fresh.resources).toEqual(old.resources);
	const third = await repository.createSession(gameId);
	expect((await repository.getSessionHistory(gameId, third.id)).snapshot.id).toBe(expectedId);
	expect((await repository.getSessionHistory(gameId, sessionId)).snapshot.id).toBe(old.snapshot.id);
	for (const table of ['snapshots', 'blobs', 'snapshot_resources']) {
		const count = storage.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get();
		expect(count).toEqual({ count: 2 });
	}
});

it('replays old checkpoints and branches, then Applies new content atomically', async () => {
	await repository.appendUserMessage(gameId, sessionId, 'First');
	const first = await repository.getSessionHistory(gameId, sessionId);
	const view = storage.request({ kind: 'read', gameId, sessionId });
	storage.request({
		kind: 'commit',
		gameId,
		version: view.version,
		deleteSessions: [],
		records: [
			storedRecord('checkpoints', {
				schemaVersion: 1,
				id: first.progress.headId,
				transactionId: first.progress.headId,
				snapshotId: legacy.snapshot.id,
				gameId,
				sessionId,
				state: first.progress.state
			})
		]
	});
	await repository.appendUserMessage(gameId, sessionId, 'Archived');
	const archived = await repository.getSessionHistory(gameId, sessionId);
	await repository.selectSessionBranch(
		gameId,
		sessionId,
		first.progress.headId,
		archived.progress.revision
	);
	await repository.appendUserMessage(gameId, sessionId, 'Current');
	const before = await repository.getSessionTimeline(gameId, sessionId);
	expect(before.history.checkpoints[0].snapshotId).toBe(legacy.snapshot.id);
	// Populate the media index without rewriting the old portable blob identity.
	storageSync(storage, {
		kind: 'sync',
		known: [],
		request: { kind: 'read', gameId, sessionId, play: true }
	});
	expect(storageAsset(storage, gameId, legacy.blob.id)?.data).toBe(legacy.blob.data);
	const baseContent = editorContent((await repository.getGameWorkspace(gameId))!.game);
	await repository.applyGameDraft(gameId, {
		baseContent,
		content: { ...baseContent, resources: {} }
	});
	const after = await repository.getSessionTimeline(gameId, sessionId);
	expect(after.history.snapshot.id).not.toBe(legacy.snapshot.id);
	expect(after.events).toEqual(before.events);
	expect(after.messages).toEqual(before.messages);
	expect(after.history.resources).toEqual({});
	expect(
		after.history.checkpoints.every((row) => row.snapshotId === after.history.snapshot.id)
	).toBe(true);
	await repository.selectSessionBranch(
		gameId,
		sessionId,
		archived.progress.headId,
		after.history.progress.revision
	);
	expect((await repository.getSessionTimeline(gameId, sessionId)).messages.at(-1)?.content).toBe(
		'Archived'
	);
	expect(
		storage.connection.prepare('SELECT id FROM snapshots WHERE id=?').get(legacy.snapshot.id)
	).toEqual({ id: legacy.snapshot.id });
});
