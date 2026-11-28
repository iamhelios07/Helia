import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createEditorDraft, editorContent } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { MediaIdentity } from '#lib/storage/media-identity.js';
import { type StorageRequest } from '#lib/storage/protocol.js';
import { StorageAssets } from '#lib/storage/sync-assets.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { RuntimeContent } from './runtime-content.js';
import { openStorage } from './sqlite.js';
import { storageAsset, storageSync } from './storage-sync.js';

const stores: ReturnType<typeof openStorage>[] = [];
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	stores.splice(0).forEach((store) => store.close());
	directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

it.each([1, 2])(
	'preserves v%s SQLite game, history, snapshot and editor reads',
	async (version) => {
		const directory = mkdtempSync(join(tmpdir(), 'helia-media-consumers-'));
		directories.push(directory);
		const filename = join(directory, 'storage.sqlite');
		const { store, direct, game, data, load, transport, repo } = await fixture(filename);
		const db = store.connection;
		const saved = db.prepare('SELECT id,value FROM blobs WHERE game_id=?').get(game.id) as {
			id: string;
			value: string;
		};
		const legacy = JSON.parse(saved.value);
		const reference = 'helia-asset:' + saved.id;
		const expected = version === 2 ? reference : data;
		if (version === 2) {
			const bytes = Buffer.alloc(200000, 1);
			const identity = new MediaIdentity(game.id, legacy.mime).update(bytes).digest();
			expect(identity.blobId).toBe(saved.id);
			db.prepare('DELETE FROM blobs WHERE id=?').run(saved.id);
			const { uploadId } = store.uploads.begin(game.id, {
				purpose: 'edit',
				mime: legacy.mime,
				size: bytes.length
			});
			await store.uploads.chunk(game.id, uploadId, 0, {
				sha256: identity.raw,
				read: async () => bytes
			});
			expect((await store.uploads.finish(game.id, uploadId)).blobId).toBe(saved.id);
			const current = (await direct.getGameWorkspace(game.id))!.game;
			current.resources!.portrait.data = reference;
			db.prepare('UPDATE games SET value=? WHERE id=?').run(JSON.stringify(current), game.id);
		}
		const draft = createEditorDraft((await direct.getGameWorkspace(game.id))!.game);
		const drafts = editorDraftStorage(db);
		db.prepare('INSERT INTO editor_drafts(game_id,version,value) VALUES(?,1,?)').run(
			game.id,
			JSON.stringify(draft)
		);
		const cached = vi.spyOn(StorageAssets.prototype, 'read');
		for (let read = 0; read < 2; read++) {
			expect((await repo.getGameWorkspace(game.id))!.game.resources!.portrait.data).toBe(expected);
			const all = await transport({ kind: 'read', gameId: game.id, includeHistory: true });
			expect(all.records.find((row) => row.table === 'blobs')!.value).toEqual(
				version === 2
					? JSON.parse(
							(db.prepare('SELECT value FROM blobs WHERE id=?').get(saved.id) as { value: string })
								.value
						)
					: legacy
			);
			const history = await repo.getSessionHistory(game.id, game.activeSessionId);
			expect(history.resources.portrait.data).toBe(reference);
			expect(history.progress.state).toEqual({ count: 0 });
			expect((await repo.getPlayWorkspace(game.id))!.timeline.history.resources.portrait.data).toBe(
				reference
			);
			expect(drafts.read(game.id).draft).toEqual(draft);
			expect(JSON.parse(drafts.read(game.id).draft!.documents.assets).portrait.data).toBe(expected);
		}
		if (version === 2) {
			expect(load).not.toHaveBeenCalled();
			expect(cached).not.toHaveBeenCalled();
			expect(new RuntimeContent(db).readAsset(game.id, saved.id)).toMatchObject({
				schemaVersion: 2,
				id: saved.id,
				mime: 'image/png'
			});
			expect(new RuntimeContent(db).openMedia(game.id, saved.id)!.size).toBe(200000);
		} else {
			expect(load).toHaveBeenCalledOnce();
		}
		const reopened = openStorage(filename);
		stores.push(reopened);
		expect(editorDraftStorage(reopened.connection).read(game.id).draft).toEqual(draft);
	}
);
async function fixture(filename = ':memory:') {
	const store = openStorage(filename);
	stores.push(store);
	const direct = createGameRepository(async (request) => store.request(request));
	const game = await direct.createGame();
	const data = 'data:image/png;base64,' + Buffer.alloc(200000, 1).toString('base64');
	const rules = await direct.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { count: { type: 'integer' } },
			additionalProperties: false
		},
		initialState: { count: 0 },
		scripts: {}
	});
	await direct.applyGameDraft(game.id, {
		baseContent: editorContent(rules),
		content: {
			...editorContent(rules),
			resources: { portrait: { name: 'portrait.png', mime: 'image/png', data } }
		}
	});
	await direct.getSessionHistory(game.id, game.activeSessionId);
	const packets: { request: string; reply: string }[] = [];
	const load = vi.fn(async (id: string, hash: string) => {
		const asset = storageAsset(store, id, hash);
		if (!asset) {
			throw Error('Missing asset');
		}
		return asset.data;
	});
	const send = vi.fn(async (request: unknown) => {
		const reply = storageSync(store, request);
		packets.push({ request: JSON.stringify(request), reply: JSON.stringify(reply) });
		return structuredClone(reply);
	});
	const transport = synchronizedStorage(send, load);
	return {
		store,
		direct,
		game,
		data,
		packets,
		send,
		load,
		transport,
		repo: createGameRepository(transport)
	};
}
it('sends media separately, reuses immutable content and patches only changed game fields', async () => {
	const { game, repo, packets, load, data } = await fixture();
	const initial = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(initial.resources.portrait.data).toMatch(/^helia-asset:[a-f0-9]{64}$/);
	expect(load).not.toHaveBeenCalled();
	const first = packets.at(-1)!;
	expect(first.reply).not.toContain('base64');
	await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(packets.at(-1)!.reply.length).toBeLessThan(first.reply.length);
	const before = packets.length;
	const next = await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: initial.progress.revision,
		parentId: null,
		action: { name: 'change', args: {} },
		nextState: { count: 1 }
	});
	expect(next.progress.state).toEqual({ count: 1 });
	for (const packet of packets.slice(before)) {
		expect(packet.request).not.toContain('base64');
		expect(packet.reply).not.toContain('base64');
		expect(packet.request.length + packet.reply.length).toBeLessThan(12000);
	}
	expect(load).not.toHaveBeenCalled();
	expect((await repo.getGameWorkspace(game.id))?.game.resources?.portrait.data).toBe(data);
	expect(load).toHaveBeenCalledOnce();
});
it('returns metadata-only listings and reads only the selected snapshot while preserving history checkout', async () => {
	const { game, repo, direct, store, packets } = await fixture();
	const first = await repo.getSessionHistory(game.id, game.activeSessionId);
	await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: first.progress.revision,
		parentId: null,
		action: { name: 'change', args: {} },
		nextState: { count: 1 }
	});
	const workspace = (await direct.getGameWorkspace(game.id))!;
	for (let index = 0; index < 4; index++) {
		const snapshot = { ...first.snapshot, id: String(index).repeat(64) };
		store.connection
			.prepare('INSERT INTO snapshots (id,game_id,value) VALUES (?,?,?)')
			.run(snapshot.id, game.id, JSON.stringify(snapshot));
	}
	const list = await repo.listGames();
	expect(list[0]).toMatchObject({ id: game.id, title: workspace.game.title });
	expect(list[0]).not.toHaveProperty('resources');
	expect(list[0]).not.toHaveProperty('scripts');
	const read: StorageRequest = { kind: 'read', gameId: game.id, sessionId: game.activeSessionId };
	const unused = {
		schemaVersion: 1,
		id: '9'.repeat(64),
		gameId: game.id,
		mime: 'image/png',
		data: 'data:image/png;base64,AA=='
	};
	store.connection
		.prepare('INSERT INTO blobs (id,game_id,value) VALUES (?,?,?)')
		.run(unused.id, game.id, JSON.stringify(unused));
	expect(store.request(read).records.filter((row) => row.table === 'blobs')).toHaveLength(1);
	expect(
		store
			.request({ kind: 'read', gameId: game.id, includeHistory: true })
			.records.filter((row) => row.table === 'blobs')
	).toHaveLength(2);
	expect(store.request(read).records.filter((row) => row.table === 'snapshots')).toHaveLength(1);
	expect(
		store
			.request({ kind: 'read', gameId: game.id, includeHistory: true })
			.records.filter((row) => row.table === 'snapshots')
	).toHaveLength(5);
	await repo.selectSessionBranch(game.id, game.activeSessionId, null, 1);
	expect((await repo.getSessionHistory(game.id, game.activeSessionId)).progress.state).toEqual({
		count: 0
	});
	expect(packets.every((packet) => !packet.reply.includes('base64'))).toBe(true);
});
it('coalesces simultaneous readers, isolates game scopes and observes external writes', async () => {
	const { game, repo, direct, send, load, transport, store } = await fixture();
	await Promise.all([
		repo.getSessionHistory(game.id, game.activeSessionId),
		repo.getSessionHistory(game.id, game.activeSessionId)
	]);
	expect(send).toHaveBeenCalledOnce();
	await direct.updateGame(game.id, { title: 'External edit', genre: '', description: '' });
	expect((await repo.getGameWorkspace(game.id))?.game.title).toBe('External edit');
	const other = await direct.createGame();
	const otherReply = await transport({ kind: 'read', gameId: other.id });
	expect(otherReply.records.every((row) => row.gameId === other.id)).toBe(true);
	const hash = load.mock.calls[0][1];
	expect(storageAsset(store, other.id, hash)).toBeNull();
});

it('keeps cached state consistent through conflicts, branch deletion and opening-message resequencing', async () => {
	const { game, repo, direct, packets } = await fixture();
	await repo.appendUserMessage(game.id, game.activeSessionId, 'First message');
	const timeline = await repo.getSessionTimeline(game.id, game.activeSessionId);
	const oldRead = await direct.getSessionHistory(game.id, game.activeSessionId);
	await repo.appendUserMessage(game.id, game.activeSessionId, 'Second message');
	await expect(
		repo.commitSessionTransaction(game.id, game.activeSessionId, {
			expectedRevision: oldRead.progress.revision,
			parentId: oldRead.progress.headId,
			action: { name: 'stale', args: {} },
			nextState: { count: 5 }
		})
	).rejects.toThrow();
	const workspace = (await direct.getGameWorkspace(game.id))!;
	await direct.updateGameSettings(game.id, {
		title: workspace.game.title,
		...workspace.game.settings,
		firstMessage: 'An opening'
	});
	const opened = await repo.getSessionTimeline(game.id, game.activeSessionId);
	expect(opened.messages.map((message) => message.content)).toEqual([
		'An opening',
		'First message',
		'Second message'
	]);
	const pruned = await repo.deleteSessionEvent(
		game.id,
		game.activeSessionId,
		timeline.events[0].id,
		opened.history.progress.revision
	);
	expect(pruned.messages.map((message) => message.content)).toEqual(['An opening']);
	expect((await repo.getSessionTimeline(game.id, game.activeSessionId)).messages).toEqual(
		pruned.messages
	);
	expect(packets.every((packet) => !packet.request.includes(';base64,'))).toBe(true);
});

it('rejects v2 blob rows owned by another game and records no alias', async () => {
	const { store, direct, game, transport } = await fixture();
	const other = await direct.createGame();
	const blob = {
		schemaVersion: 2,
		id: 'a'.repeat(64),
		gameId: other.id,
		mime: 'image/png',
		object: 'b'.repeat(64),
		size: 1
	};
	store.connection
		.prepare('INSERT INTO blobs (id,game_id,value) VALUES (?,?,?)')
		.run(blob.id, game.id, JSON.stringify(blob));
	const reference = store.connection
		.prepare('SELECT id,value FROM snapshot_resources WHERE game_id=?')
		.get(game.id) as { id: string; value: string };
	store.connection
		.prepare('UPDATE snapshot_resources SET value=? WHERE id=?')
		.run(JSON.stringify({ ...JSON.parse(reference.value), blobId: blob.id }), reference.id);
	expect(
		store
			.request({ kind: 'read', gameId: game.id, includeHistory: true })
			.records.some((row) => row.table === 'blobs' && row.id === blob.id)
	).toBe(true);
	// Both the editor read (every blob row) and the play read (referenced blobs) reject the row.
	for (const play of [false, true]) {
		await expect(
			transport({ kind: 'read', gameId: game.id, includeHistory: true, play })
		).rejects.toThrow();
	}
	expect(
		store.connection
			.prepare('SELECT count(*) AS count FROM runtime_assets WHERE blob_id=?')
			.get(blob.id)
	).toEqual({ count: 0 });
});

it('rejects malformed v2 blob rows without recording an alias', async () => {
	const { store, game, transport } = await fixture();
	// Ensure the runtime tables exist so the alias assertion is meaningful.
	new RuntimeContent(store.connection);
	const blob = {
		schemaVersion: 2,
		id: 'c'.repeat(64),
		gameId: game.id,
		mime: 'image/png',
		object: 'd'.repeat(64),
		size: 1
	};
	const insert = store.connection.prepare(
		'INSERT OR REPLACE INTO blobs (id,game_id,value) VALUES (?,?,?)'
	);
	for (const [key, value] of [
		['size', 0],
		['size', 1.5],
		['object', 'A'.repeat(64)],
		['mime', 'text/html']
	] as const) {
		insert.run(blob.id, game.id, JSON.stringify({ ...blob, [key]: value }));
		await expect(
			transport({ kind: 'read', gameId: game.id, includeHistory: true })
		).rejects.toThrow();
	}
	expect(
		store.connection
			.prepare('SELECT count(*) AS count FROM runtime_assets WHERE blob_id=?')
			.get(blob.id)
	).toEqual({ count: 0 });
});

it('refuses to open a v2 blob through another game ID', async () => {
	const { store, direct, game } = await fixture();
	const db = store.connection;
	const saved = db.prepare('SELECT id,value FROM blobs WHERE game_id=?').get(game.id) as {
		id: string;
		value: string;
	};
	const legacy = JSON.parse(saved.value) as { mime: string; data: string };
	const bytes = Buffer.from(legacy.data.slice(legacy.data.indexOf(',') + 1), 'base64');
	const identity = new MediaIdentity(game.id, legacy.mime).update(bytes).digest();
	expect(identity.blobId).toBe(saved.id);
	db.prepare('UPDATE blobs SET value=? WHERE id=?').run(
		JSON.stringify({
			schemaVersion: 2,
			id: saved.id,
			gameId: game.id,
			mime: legacy.mime,
			object: identity.raw,
			size: bytes.length
		}),
		saved.id
	);
	db.prepare(
		"INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?,?,'ready',?,1048576,?,?,'now')"
	).run('object', game.id, bytes.length, identity.raw, identity.crc);
	db.prepare('INSERT INTO media_chunks VALUES(?,0,?,?)').run('object', identity.raw, bytes);
	const other = await direct.createGame();
	const runtime = new RuntimeContent(db);
	expect(runtime.openMedia(game.id, saved.id)!.size).toBe(bytes.length);
	expect(runtime.openMedia(other.id, saved.id)).toBeNull();
	// Even a forged alias in the other game cannot cross the owner boundary.
	db.prepare('INSERT INTO runtime_assets (game_id,hash,blob_id) VALUES (?,?,?)').run(
		other.id,
		saved.id,
		saved.id
	);
	expect(runtime.isV2Media(other.id, saved.id)).toBe(false);
	expect(runtime.openMedia(other.id, saved.id)).toBeNull();
	expect(storageAsset(store, other.id, saved.id)).toBeNull();
});

it('preserves helia-asset references that point at v1 blobs', async () => {
	const { store, direct, game, transport } = await fixture();
	const saved = store.connection
		.prepare('SELECT id,value FROM blobs WHERE game_id=?')
		.get(game.id) as { id: string; value: string };
	const reference = 'helia-asset:' + saved.id;
	const current = (await direct.getGameWorkspace(game.id))!.game;
	current.resources!.portrait.data = reference;
	store.connection
		.prepare('UPDATE games SET value=? WHERE id=?')
		.run(JSON.stringify(current), game.id);
	const load = vi.spyOn(StorageAssets.prototype, 'read');
	const read = async (play: boolean) =>
		(await transport({ kind: 'read', gameId: game.id, includeHistory: true, play })).records.find(
			(row) => row.table === 'games'
		)!.value as { resources: Record<string, { data: string }> };
	// The reference is stored verbatim; the play path must not fetch it as media.
	expect((await read(true)).resources.portrait.data).toBe(reference);
	expect(load).not.toHaveBeenCalled();
	expect((await read(false)).resources.portrait.data).toBe(reference);
});

it('never hydrates user state that happens to resemble an internal media descriptor', async () => {
	const { store, game, repo, direct } = await fixture();
	await repo.getGameWorkspace(game.id);
	const raw = storageSync(store, {
		kind: 'sync',
		request: { kind: 'read', gameId: game.id },
		known: []
	});
	if (!('parts' in raw.records[0])) {
		throw Error('Expected synchronization reply');
	}
	const manifest = raw.records[0].parts.resources.value as {
		portrait: { name: string; mime: string; data: { asset: string } };
	};
	await direct.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: {
				portrait: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string' },
						mime: { type: 'string' },
						data: {
							type: 'object',
							additionalProperties: false,
							properties: { asset: { type: 'string' } }
						}
					}
				}
			},
			additionalProperties: false
		},
		initialState: manifest,
		scripts: {}
	});
	expect((await repo.getGameWorkspace(game.id))?.game.initialState).toEqual(manifest);
});
