import { expect, it, vi } from 'vitest';

import type { StorageRequest } from '#lib/storage/protocol.js';

import { createGameRepository } from '#lib/games/repository-core.js';
import { runtimeReady } from '#lib/games/runtime-ready.js';
import { evaluateAction } from '#lib/games/scripting/engine.js';
import playFixtures from '#lib/storage/fixtures/edit-lock-play.json';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
import { storageSync, storageAsset } from './storage-sync.js';

/** Rust replays these exact frontend commits, including derived scripts and UI. */
it.each(playFixtures)(
	'prepares locked $name in memory and reuses its runtime snapshot',
	async (fixture) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-24T00:00:00.000Z'));
		const store = openStorage(':memory:');
		try {
			const input = fixture.install;
			await store.requestAsync(input);
			const commits: StorageRequest[] = [];
			const transport = synchronizedStorage(
				async (request) => storageSync(store, request),
				async (gameId, hash) => storageAsset(store, gameId, hash)!.data
			);
			const repo = createGameRepository(async (request) => {
				if (request.kind === 'commit') {
					commits.push(structuredClone(request));
				}
				return transport(request);
			});
			const before = store.request({ kind: 'read', gameId: input.gameId });
			const first = (await repo.getPlayWorkspace(input.gameId))!;
			expect(runtimeReady(first.game)).toBe(true);
			expect(runtimeReady(first.timeline.history.snapshot)).toBe(true);
			expect(first.game.ui?.compiled).toBeDefined();
			expect(
				await evaluateAction({
					scripts: first.game.scripts,
					schema: first.game.schema,
					state: first.game.initialState,
					action: { name: 'probe', args: {} }
				})
			).toEqual({ state: {} });
			expect(JSON.parse(JSON.stringify(commits))).toEqual(fixture.commits);
			expect(first.timeline.history.snapshot.id).toBe(fixture.snapshotId);
			const again = (await repo.getPlayWorkspace(input.gameId))!;
			expect(again.timeline.history.snapshot.id).toBe(first.timeline.history.snapshot.id);
			expect(commits).toHaveLength(fixture.commits.length);
			expect((await repo.getGameWorkspace(input.gameId))!.game).toEqual(before.records[0].value);
			expect((await repo.getGameVersioning(input.gameId)).contentHash).toBe(
				input.release.contentHash
			);
			expect(editorDraftStorage(store.connection).read(input.gameId)).toEqual({
				version: 0,
				draft: null
			});
			await repo.createSession(input.gameId);
			const other = (await repo.getPlayWorkspace(input.gameId))!;
			expect(other.timeline.history.snapshot.id).toBe(fixture.snapshotId);
			expect(store.connection.prepare('SELECT count(*) FROM snapshots').pluck().get()).toBe(2);
		} finally {
			store.close();
			vi.useRealTimers();
		}
	}
);
