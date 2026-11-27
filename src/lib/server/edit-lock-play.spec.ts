import { expect, it, vi } from 'vitest';

import type { StorageRequest } from '#lib/storage/protocol.js';

import * as codeProject from '#lib/games/code-project.js';
import { createEditorDraft } from '#lib/games/editor.js';
import { parseGame, type Game } from '#lib/games/model.js';
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
		const compile = vi.spyOn(codeProject, 'compileAuthoringGame');
		try {
			const input = fixture.install;
			await store.requestAsync(input);
			const commits: StorageRequest[] = [];
			const transport = synchronizedStorage(
				async (request) => storageSync(store, request),
				async (gameId, hash) => storageAsset(store, gameId, hash)!.data
			);
			const tracked = async (request: StorageRequest) => {
				if (request.kind === 'commit') {
					commits.push(structuredClone(request));
				}
				return transport(request);
			};
			const repo = createGameRepository(tracked);
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
			expect(compile).toHaveBeenCalledTimes(1);
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
			expect(compile).toHaveBeenCalledTimes(1);
			const writesBeforeRestart = commits.length;
			const restarted = createGameRepository(tracked);
			const reopened = (await restarted.getPlayWorkspace(input.gameId))!;
			expect(reopened.timeline.history.snapshot.id).toBe(fixture.snapshotId);
			expect(compile).toHaveBeenCalledTimes(2);
			expect(commits).toHaveLength(writesBeforeRestart);
		} finally {
			store.close();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	}
);

it('compiles old locked build keys once while preserving installed source', async () => {
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
		const drafts = editorDraftStorage(store.connection);
		const draft = createEditorDraft(cached);
		draft.documents.state = '{unfinished';
		store.connection
			.prepare('INSERT INTO editor_drafts (game_id,version,value) VALUES (?,?,?)')
			.run(gameId, 7, JSON.stringify(draft));
		const versioning = await createGameRepository(async (request) =>
			store.request(request)
		).getGameVersioning(gameId);
		const repo = createGameRepository(async (request) => parseReply(store.request(request)));
		for (let opened = 1; opened <= 2; opened++) {
			const play = (await repo.getPlayWorkspace(gameId))!;
			expect(play.game.editLock).toBe(true);
			expect(logic).toHaveBeenCalledTimes(1);
			expect(logic.mock.calls[0][0].scripts.main.compiled).toBeUndefined();
			expect(ui).toHaveBeenCalledTimes(1);
			expect(play.game.scripts.main.compiledFor).toBe(
				contentHash([cached.scripts.main.source, cached.schema])
			);
			expect(play.game.ui?.compiled?.sourceHash).toBe(
				contentHash([cached.ui!.entry, cached.ui!.modules])
			);
			expect((await repo.getGameWorkspace(gameId))!.game).toEqual(cached);
			expect(drafts.read(gameId)).toEqual({ version: 7, draft });
			expect(await repo.getGameVersioning(gameId)).toEqual(versioning);
		}
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});

it('rebuilds changed installed source and replaces a ready snapshot with the same script IDs', async () => {
	const store = openStorage(':memory:');
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame');
	try {
		const { install } = playFixtures[0];
		await store.requestAsync(install);
		const repo = createGameRepository(
			synchronizedStorage(
				async (request) => storageSync(store, request),
				async (gameId, hash) => storageAsset(store, gameId, hash)!.data
			)
		);
		const first = (await repo.getPlayWorkspace(install.gameId))!;
		const installed = (await repo.getGameWorkspace(install.gameId))!.game;
		const changed = parseGame({
			...installed,
			scripts: {
				main: {
					...installed.scripts.main,
					source: installed.scripts.main.source + '\nconst upgraded: number = 2;'
				}
			}
		});
		// Simulate a replaced installation without changing its route or script IDs.
		store.connection
			.prepare('UPDATE games SET value=? WHERE id=?')
			.run(JSON.stringify(changed), install.gameId);
		const second = (await repo.getPlayWorkspace(install.gameId))!;
		expect(compile).toHaveBeenCalledTimes(2);
		expect(second.game.scripts.main.compiled).toContain('upgraded');
		expect(second.timeline.history.snapshot.id).not.toBe(first.timeline.history.snapshot.id);
		const stored = store.request({
			kind: 'read',
			gameId: install.gameId,
			sessionId: install.sessionId
		});
		const snapshot = parseGameSnapshot(
			stored.records.find((row) => row.table === 'snapshots')!.value
		);
		expect(snapshot.scripts.main).toEqual(second.game.scripts.main);
		const again = (await repo.getPlayWorkspace(install.gameId))!;
		expect(again.timeline.history.snapshot.id).toBe(second.timeline.history.snapshot.id);
		expect(compile).toHaveBeenCalledTimes(2);
		expect((await repo.getGameWorkspace(install.gameId))!.game).toEqual(changed);
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});

it('replaces a ready snapshot when a new repository uses an upgraded compiler', async () => {
	const store = openStorage(':memory:');
	const compileAuthoringGame = codeProject.compileAuthoringGame;
	try {
		const { install } = playFixtures[0];
		await store.requestAsync(install);
		const transport = async (request: StorageRequest) => store.request(request);
		const first = (await createGameRepository(transport).getPlayWorkspace(install.gameId))!;
		const before = (await createGameRepository(transport).getGameWorkspace(install.gameId))!;
		const compile = vi
			.spyOn(codeProject, 'compileAuthoringGame')
			.mockImplementation(async (game) => {
				const compiled = await compileAuthoringGame(game);
				compiled.scripts.main.compiled += '\n// Compiler upgrade';
				return compiled;
			});
		const restarted = createGameRepository(transport);
		const upgraded = (await restarted.getPlayWorkspace(install.gameId))!;
		expect(upgraded.timeline.history.snapshot.id).not.toBe(first.timeline.history.snapshot.id);
		expect(upgraded.timeline.history.snapshot.scripts.main.compiled).toContain('Compiler upgrade');
		const again = (await restarted.getPlayWorkspace(install.gameId))!;
		expect(again.timeline.history.snapshot.id).toBe(upgraded.timeline.history.snapshot.id);
		expect(compile).toHaveBeenCalledTimes(1);
		expect((await restarted.getGameWorkspace(install.gameId))!.game).toEqual(before.game);
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});

const variants: { name: string; fixture: number; change: (game: Game) => Game }[] = [
	{ name: 'authoring code project', fixture: 1, change: (game) => game },
	{
		name: 'UI styles and layout',
		fixture: 0,
		change: (game) => ({
			...game,
			ui: {
				...game.ui!,
				styles: 'span { color: red; }',
				layout: { kind: 'panel', id: 'status' },
				chatDock: 'right',
				chatRatio: 0.4
			}
		})
	},
	{
		name: 'legacy JavaScript script',
		fixture: 0,
		change: (game) => ({
			...game,
			scripts: { main: { ...game.scripts.main, language: 'javascript' } }
		})
	}
];

it.each(variants)('opens locked $name twice without another build or write', async (variant) => {
	const store = openStorage(':memory:');
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame');
	try {
		const { install } = playFixtures[variant.fixture];
		await store.requestAsync(install);
		const installed = parseGame(
			store.request({ kind: 'read', gameId: install.gameId }).records[0].value
		);
		// Preserve raw legacy language values as they would exist in an older installation.
		store.connection
			.prepare('UPDATE games SET value=? WHERE id=?')
			.run(JSON.stringify(variant.change(installed)), install.gameId);
		const transport = vi.fn(
			synchronizedStorage(
				async (request) => storageSync(store, request),
				async (gameId, hash) => storageAsset(store, gameId, hash)!.data
			)
		);
		const repo = createGameRepository(transport);
		const first = (await repo.getPlayWorkspace(install.gameId))!;
		expect(compile).toHaveBeenCalledTimes(1);
		expect(runtimeReady(first.timeline.history.snapshot)).toBe(true);
		compile.mockClear();
		transport.mockClear();
		const second = (await repo.getPlayWorkspace(install.gameId))!;
		expect(second.timeline.history.snapshot.id).toBe(first.timeline.history.snapshot.id);
		expect(compile).not.toHaveBeenCalled();
		expect(transport.mock.calls.filter(([request]) => request.kind !== 'read')).toHaveLength(0);
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});

it('normalizes compiler UI output the same way as the persisted snapshot', async () => {
	const store = openStorage(':memory:');
	const compileAuthoringGame = codeProject.compileAuthoringGame;
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame').mockImplementation(async (game) => {
		const compiled = await compileAuthoringGame(game);
		return { ...compiled, ui: { ...compiled.ui!, discardedLegacyField: 'normalized on storage' } };
	});
	try {
		const { install } = playFixtures[0];
		await store.requestAsync(install);
		const transport = vi.fn(async (request: StorageRequest) => store.request(request));
		const repo = createGameRepository(transport);
		const first = (await repo.getPlayWorkspace(install.gameId))!;
		expect(first.timeline.history.snapshot.ui).not.toHaveProperty('discardedLegacyField');
		transport.mockClear();
		const second = (await repo.getPlayWorkspace(install.gameId))!;
		expect(second.timeline.history.snapshot.id).toBe(first.timeline.history.snapshot.id);
		expect(compile).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls.filter(([request]) => request.kind !== 'read')).toHaveLength(0);
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});

it('stops after one runtime preparation if the stored build still differs', async () => {
	const store = openStorage(':memory:');
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame');
	let preparations = 0;
	try {
		const { install } = playFixtures[0];
		await store.requestAsync(install);
		const repo = createGameRepository(async (request) => {
			if (request.kind !== 'commit') {
				return store.request(request);
			}
			const records = request.records.map((row) => {
				if (row.table !== 'snapshots') {
					return row;
				}
				const snapshot = parseGameSnapshot(row.value);
				if (!snapshot.scripts.main.compiled) {
					return row;
				}
				preparations++;
				if (preparations > 1) {
					throw Error('Repeated runtime preparation');
				}
				snapshot.scripts.main.compiled += '\n// Persisted build differs';
				return { ...row, value: snapshot };
			});
			return store.request({ ...request, records });
		});
		await expect(repo.getPlayWorkspace(install.gameId)).rejects.toThrow(
			'잠긴 게임의 실행 스냅숏이 준비된 빌드와 일치하지 않아요.'
		);
		expect(preparations).toBe(1);
		expect(compile).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
		vi.restoreAllMocks();
	}
});
