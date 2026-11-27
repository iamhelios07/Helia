import { expect, it, vi } from 'vitest';

import type { StorageRequest } from '#lib/storage/protocol.js';

import { parseGame } from '#lib/games/model.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { runtimeReady } from '#lib/games/runtime-ready.js';
import { evaluateAction } from '#lib/games/scripting/engine.js';
import * as scriptBuild from '#lib/games/scripting/script-build.js';
import { contentHash, parseGameSnapshot } from '#lib/games/state/model.js';
import * as uiBuild from '#lib/games/ui/runtime/build.js';
import playFixtures from '#lib/storage/fixtures/edit-lock-play.json';
import { parseReply } from '#lib/storage/protocol.js';
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

it('recompiles old locked build keys on every play open while preserving installed source', async () => {
	const fixture = playFixtures[0];
	const store = openStorage(':memory:');
	const logic = vi.spyOn(scriptBuild, 'compileScripts');
	const ui = vi.spyOn(uiBuild, 'buildGameUI');
	try {
		await store.requestAsync(fixture.install);
		const gameId = fixture.install.gameId;
		const installed = parseGame(store.request({ kind: 'read', gameId }).records[0].value);
		const prepared = parseGameSnapshot(
			fixture.commits[1].records.find((row) => row.table === 'snapshots')!.value
		);
		const cached = parseGame({
			...installed,
			scripts: {
				main: {
					...prepared.scripts.main,
					// Fixed FNV keys captured before the SHA-256 transition.
					compiledFor: '7d44ce70d1d64e247f56baeb733a4607c88b57ecb14bb65fd0cbe2af9e20142d'
				}
			},
			ui: {
				...prepared.ui!,
				compiled: {
					...prepared.ui!.compiled,
					sourceHash: '1f258c8d9e158b5310485ba5b0775c4f29f4e2b1b9742de7626a295ba64dca45'
				}
			}
		});
		// Seed an old persisted cache, bypassing the lock's ordinary write guard.
		store.connection
			.prepare('UPDATE games SET value=? WHERE id=?')
			.run(JSON.stringify(cached), gameId);
		const repo = createGameRepository(async (request) => parseReply(store.request(request)));
		for (let opened = 1; opened <= 2; opened++) {
			const play = (await repo.getPlayWorkspace(gameId))!;
			expect(play.game.editLock).toBe(true);
			expect(logic).toHaveBeenCalledTimes(opened);
			expect(logic.mock.calls[opened - 1][0].scripts.main.compiled).toBeUndefined();
			expect(ui).toHaveBeenCalledTimes(opened);
			expect(play.game.scripts.main.compiledFor).toBe(
				contentHash([cached.scripts.main.source, cached.schema])
			);
			expect(play.game.ui?.compiled?.sourceHash).toBe(
				contentHash([cached.ui!.entry, cached.ui!.modules])
			);
			expect((await repo.getGameWorkspace(gameId))!.game).toEqual(cached);
		}
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});
