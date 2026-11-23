import { afterEach, expect, it, vi } from 'vitest';

import { editorContent } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { type StorageRequest } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { openStorage } from './sqlite.js';
import { storageAsset, storageSync } from './storage-sync.js';

const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
async function fixture() {
	const store = openStorage(':memory:');
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
