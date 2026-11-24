import { afterEach, expect, it } from 'vitest';

import { openStorage } from '#lib/server/sqlite.js';
import { storageAsset, storageSync } from '#lib/server/storage-sync.js';
import { parseReply, storedRecord } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import type { GameResources } from './resources.js';

import { editorContent } from './editor.js';
import { createGameRepository } from './repository-core.js';
import { contentHash, parseSnapshotResource } from './state/model.js';

const connections: ReturnType<typeof openStorage>[] = [];
function setup() {
	const storage = openStorage(':memory:');
	connections.push(storage);
	const repository = createGameRepository(async (request) => parseReply(storage.request(request)));
	return { storage, repository };
}
afterEach(() => {
	for (const storage of connections.splice(0)) {
		storage.close();
	}
});

const portrait = {
	name: 'images/portrait.png',
	mime: 'image/png',
	data: 'data:image/png;base64,aGVsbG8='
};
async function applyResources(
	repository: ReturnType<typeof createGameRepository>,
	gameId: string,
	resources: GameResources
) {
	const workspace = (await repository.getGameWorkspace(gameId))!;
	const baseContent = editorContent(workspace.game);
	return repository.applyGameDraft(gameId, {
		baseContent,
		content: { ...baseContent, resources }
	});
}

it.each<{ change: string; resources: GameResources }>([
	{
		change: 'replacement',
		resources: { portrait: { ...portrait, data: 'data:image/png;base64,d29ybGQ=' } }
	},
	{ change: 'addition', resources: { portrait, music: { ...portrait, name: 'music.png' } } },
	{ change: 'deletion', resources: {} },
	{ change: 'path rename', resources: { portrait: { ...portrait, name: 'images/renamed.png' } } },
	{ change: 'asset ID change', resources: { hero: portrait } },
	{
		change: 'MIME change',
		resources: {
			portrait: { ...portrait, mime: 'image/jpeg', data: 'data:image/jpeg;base64,aGVsbG8=' }
		}
	}
])(
	'resolves $change in existing and new sessions after a resource-only Apply',
	async ({ resources }) => {
		const { repository } = setup();
		const game = await repository.createGame();
		await applyResources(repository, game.id, { portrait });
		const before = await repository.getSessionHistory(game.id, game.activeSessionId);
		expect(before.resources).toEqual({ portrait });
		await applyResources(repository, game.id, resources);
		const existing = await repository.getSessionHistory(game.id, game.activeSessionId);
		const session = await repository.createSession(game.id);
		await repository.getSessionHistory(game.id, session.id);
		const created = await repository.getSessionHistory(game.id, session.id);
		expect.soft(existing.resources).toEqual(resources);
		expect.soft(created.resources).toEqual(resources);
		expect(existing.snapshot.id).not.toBe(before.snapshot.id);
		expect(created.snapshot.id).toBe(existing.snapshot.id);
	}
);

it('keeps identical resource content accessible independently in different games', async () => {
	const { repository } = setup();
	const first = await repository.createGame();
	await applyResources(repository, first.id, { portrait });
	const firstHistory = await repository.getSessionHistory(first.id, first.activeSessionId);
	const second = await repository.createGame();
	await applyResources(repository, second.id, { portrait });
	const secondHistory = await repository.getSessionHistory(second.id, second.activeSessionId);
	expect.soft(secondHistory.resources).toEqual({ portrait });
	expect((await repository.getSessionHistory(first.id, first.activeSessionId)).resources).toEqual({
		portrait
	});
	expect(firstHistory.snapshot.gameId).toBe(first.id);
	expect(secondHistory.snapshot.gameId).toBe(second.id);
});

it('shares one blob between assets that embed identical bytes in the same game', async () => {
	const { storage, repository } = setup();
	const game = await repository.createGame();
	const resources: GameResources = {
		portrait,
		'portrait-copy': { ...portrait, name: 'images/portrait-copy.png' }
	};
	await applyResources(repository, game.id, resources);
	const history = await repository.getSessionHistory(game.id, game.activeSessionId);
	const view = storage.request({
		kind: 'read',
		gameId: game.id,
		sessionId: game.activeSessionId,
		includeHistory: true
	});
	const blobs = view.records
		.filter((row) => row.table === 'blobs')
		.map((row) => row.value as { data: string });
	const references = view.records
		.filter((row) => row.table === 'snapshot_resources')
		.map((row) => row.value as { id: string; assetId: string; blobId: string });
	expect(blobs.filter((blob) => blob.data === portrait.data)).toHaveLength(1);
	expect(references.map((row) => row.assetId).sort()).toEqual(['portrait', 'portrait-copy']);
	expect(new Set(references.map((row) => row.blobId)).size).toBe(1);
	expect(new Set(references.map((row) => row.id)).size).toBe(2);
	expect(Object.keys(history.resources).sort()).toEqual(['portrait', 'portrait-copy']);
	expect(history.resources.portrait.data).toBe(portrait.data);
	expect(history.resources['portrait-copy'].data).toBe(portrait.data);
});

it('reuses resource snapshots independently of insertion order', async () => {
	const { repository } = setup();
	const game = await repository.createGame();
	const resources = { portrait, music: { ...portrait, name: 'music.png' } };
	await applyResources(repository, game.id, resources);
	const before = await repository.getSessionHistory(game.id, game.activeSessionId);
	await applyResources(repository, game.id, {
		music: resources.music,
		portrait
	});
	const after = await repository.getSessionHistory(game.id, game.activeSessionId);
	expect(after.snapshot.id).toBe(before.snapshot.id);
	expect(after.resources).toEqual(resources);
});

it('reads legacy IDs unchanged and migrates resource-only Apply without losing branches or messages', async () => {
	const { storage, repository } = setup();
	const game = await repository.createGame();
	await applyResources(repository, game.id, { portrait });
	const original = await repository.getSessionHistory(game.id, game.activeSessionId);
	const { settings, initialState, schema, scripts } = original.snapshot;
	const legacyId = contentHash({ settings, initialState, schema, scripts });
	const blobId = contentHash(portrait.data);
	const view = storage.request({ kind: 'read', gameId: game.id });
	storage.request({
		kind: 'commit',
		gameId: game.id,
		version: view.version,
		deleteSessions: [],
		records: [
			storedRecord('snapshots', { ...original.snapshot, id: legacyId }),
			storedRecord('blobs', { schemaVersion: 1, id: blobId, gameId: game.id, ...portrait }),
			storedRecord('snapshot_resources', {
				schemaVersion: 1,
				id: contentHash([legacyId, 'portrait', blobId]),
				snapshotId: legacyId,
				gameId: game.id,
				blobId,
				assetId: 'portrait',
				name: portrait.name
			}),
			storedRecord('progress', { ...original.progress, snapshotId: legacyId })
		]
	});
	const legacy = await repository.getSessionHistory(game.id, game.activeSessionId);
	expect(legacy.snapshot.id).toBe(legacyId);
	expect(legacy.resources).toEqual({ portrait });
	await repository.appendUserMessage(game.id, game.activeSessionId, 'First');
	const first = await repository.getSessionHistory(game.id, game.activeSessionId);
	await repository.appendUserMessage(game.id, game.activeSessionId, 'Archived');
	const archived = await repository.getSessionHistory(game.id, game.activeSessionId);
	await repository.selectSessionBranch(
		game.id,
		game.activeSessionId,
		first.progress.headId,
		archived.progress.revision
	);
	await repository.appendUserMessage(game.id, game.activeSessionId, 'Current');
	const before = await repository.getSessionTimeline(game.id, game.activeSessionId);
	await applyResources(repository, game.id, {});
	const after = await repository.getSessionTimeline(game.id, game.activeSessionId);
	expect(after.history.resources).toEqual({});
	expect(after.history.snapshot.id).not.toBe(legacyId);
	expect(after.events).toEqual(before.events);
	expect(after.messages).toEqual(before.messages);
	expect(after.history.progress).toMatchObject({
		...before.history.progress,
		snapshotId: after.history.snapshot.id,
		revision: before.history.progress.revision + 1
	});
});

it.each(['replacement', 'addition', 'deletion'])(
	'resolves actual media bytes through synchronized play after resource %s',
	async (change) => {
		const { storage, repository } = setup();
		const game = await repository.createGame();
		await applyResources(repository, game.id, { portrait });
		const play = createGameRepository(
			synchronizedStorage(
				async (request) => storageSync(storage, request),
				async (gameId, hash) => storageAsset(storage, gameId, hash)!.data
			)
		);
		await play.getPlayWorkspace(game.id);
		const resources: GameResources =
			change === 'deletion'
				? {}
				: {
						portrait:
							change === 'replacement'
								? { ...portrait, data: 'data:image/png;base64,d29ybGQ=' }
								: portrait,
						...(change === 'addition' ? { music: { ...portrait, name: 'music.png' } } : {})
					};
		await applyResources(repository, game.id, resources);
		const session = await repository.createSession(game.id);
		for (const sessionId of [game.activeSessionId, session.id]) {
			const history = await play.getSessionHistory(game.id, sessionId);
			const authoring = await repository.getSessionHistory(game.id, sessionId);
			expect(history.snapshot.id).toBe(authoring.snapshot.id);
			const resolved = Object.fromEntries(
				Object.entries(history.resources).map(([id, asset]) => {
					const media = storageAsset(storage, game.id, asset.data.slice(12))!;
					return [id, { name: asset.name, mime: media.mime, data: media.data }];
				})
			);
			expect(resolved).toEqual(resources);
		}
	}
);

it('keeps resource paths distinct when preparing legacy runtime snapshots', async () => {
	const { storage, repository } = setup();
	const game = await repository.createGame();
	await applyResources(repository, game.id, { portrait });
	const ids: string[] = [];
	for (const name of ['first.png', 'second.png']) {
		const session = await repository.createSession(game.id);
		const history = await repository.getSessionHistory(game.id, session.id);
		const view = storage.request({ kind: 'read', gameId: game.id, sessionId: session.id });
		const reference = parseSnapshotResource(
			view.records.find((row) => row.table === 'snapshot_resources')!.value
		);
		const snapshotId = 'legacy-' + name;
		storage.request({
			kind: 'commit',
			gameId: game.id,
			version: view.version,
			deleteSessions: [],
			records: [
				storedRecord('snapshots', {
					...history.snapshot,
					id: snapshotId,
					scripts: { main: { language: 'javascript', source: 'const legacy = true;' } }
				}),
				storedRecord('snapshot_resources', {
					...reference,
					id: snapshotId + '-portrait',
					snapshotId,
					name
				}),
				storedRecord('progress', { ...history.progress, snapshotId })
			]
		});
		const play = (await repository.getPlayWorkspace(game.id))!;
		expect(play.timeline.history.resources).toEqual({ portrait: { ...portrait, name } });
		ids.push(play.timeline.history.snapshot.id);
	}
	expect(new Set(ids).size).toBe(2);
});
