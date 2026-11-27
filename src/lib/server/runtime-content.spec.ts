import { afterEach, expect, it, vi } from 'vitest';

import { editorContent } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { buildRuntime } from '#lib/games/runtime-build.js';
import { evaluateAction } from '#lib/games/scripting/engine.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { RuntimeContent, runtimeBlobId, runtimeHash } from './runtime-content.js';
import { openStorage } from './sqlite.js';
import { storageAsset, storageSync } from './storage-sync.js';

const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
async function fixture() {
	const store = openStorage(':memory:');
	stores.push(store);
	const direct = createGameRepository(async (request) => store.request(request));
	const created = await direct.createGame();
	const game = await direct.updateGameRules(created.id, {
		schema: {
			type: 'object',
			properties: { count: { type: 'integer' } },
			additionalProperties: false
		},
		initialState: { count: 0 },
		scripts: {
			main: {
				language: 'typescript',
				source: "helia.defineAction({name:'tick',run({state}){state.count+=1;return state;}});"
			}
		},
		ui: {
			version: 1,
			entry: 'main.tsx',
			modules: {
				'main.tsx': {
					language: 'tsx',
					source:
						"import {registerPanel} from '@helia/ui';export default function(){registerPanel({id:'game',title:'Game',component:()=> <p>Ready</p>});}"
				}
			}
		}
	});
	const load = vi.fn(async (id: string, hash: string) => storageAsset(store, id, hash)!.data);
	const packets: string[] = [];
	const transport = synchronizedStorage(async (request) => {
		const reply = storageSync(store, request);
		packets.push(JSON.stringify(reply));
		return structuredClone(reply);
	}, load);
	const repo = createGameRepository(transport, {
		runAction: async (input) => {
			const scripts = Object.fromEntries(
				Object.entries(input.scripts).map(([id, script]) => {
					const built = script.artifact
						? (new RuntimeContent(store.connection).readArtifact(game.id, script.artifact) as {
								source: string;
							})
						: undefined;
					return [
						id,
						built ? { language: 'typescript', source: '', compiled: built.source } : script
					];
				})
			);
			return evaluateAction({ ...input, scripts });
		}
	});
	return { store, direct, game, load, packets, repo };
}

it('bootstraps prepared play without authoring modules or image hydration, preserving portable snapshots', async () => {
	const { store, game, direct, repo, packets, load } = await fixture();
	await direct.applyGameDraft(game.id, {
		baseContent: editorContent(game),
		content: {
			...editorContent(game),
			resources: {
				icon: { name: 'icon.png', mime: 'image/png', data: 'data:image/png;base64,AA==' }
			}
		}
	});
	await repo.getPlayWorkspace(game.id);
	packets.length = 0;
	load.mockClear();
	const play = (await repo.getPlayWorkspace(game.id))!;
	expect(packets).toHaveLength(1);
	expect(play.game.code).toBeUndefined();
	expect(play.game.ui?.modules).toEqual({});
	expect(play.timeline.history.snapshot.scripts.main.source).toBe('');
	expect(play.timeline.events).toEqual([]);
	expect(load).not.toHaveBeenCalled();
	const artifact = new RuntimeContent(store.connection).readArtifact(
		game.id,
		play.timeline.history.snapshot.scripts.main.artifact!
	) as { source: string };
	expect(
		(
			await evaluateAction({
				schema: game.schema,
				state: { count: 0 },
				scripts: { main: { language: 'typescript', source: '', compiled: artifact.source } },
				action: { name: 'tick', args: {} }
			})
		).state
	).toEqual({ count: 1 });
	await repo.appendUserMessage(game.id, game.activeSessionId, 'Hello');
	const saved = (await direct.getGameWorkspace(game.id))!.game;
	expect(saved.scripts.main.source).toBe(game.scripts.main.source);
	expect(saved.resources?.icon.data).toBe('data:image/png;base64,AA==');
	const snapshot = await direct.getSessionHistory(game.id, game.activeSessionId);
	expect(snapshot.snapshot.scripts.main.artifact).toBeUndefined();
	expect(snapshot.snapshot.scripts.main.compiled).toBeDefined();
	expect(snapshot.snapshot.ui?.modules['main.tsx']).toBeDefined();
});

it('invalidates changed builds and keeps prior applied content when a UI build fails', async () => {
	const { game, direct } = await fixture();
	const changed = await buildRuntime({
		...game,
		scripts: { main: { ...game.scripts.main, source: 'const changed:number=2;' } }
	});
	expect(changed.scripts.main.compiled).not.toBe(game.scripts.main.compiled);
	expect(changed.scripts.main.compiledFor).not.toBe(game.scripts.main.compiledFor);
	await expect(
		direct.applyGameDraft(game.id, {
			baseContent: editorContent(game),
			content: {
				...editorContent(game),
				ui: {
					version: 1,
					entry: 'bad.tsx',
					modules: { 'bad.tsx': { language: 'tsx', source: "import 'https://example.com/bad';" } }
				}
			}
		})
	).rejects.toThrow();
	expect((await direct.getGameWorkspace(game.id))!.game).toEqual(game);
});

it('scopes immutable artifact and media lookups to the owning game and reuses existing blobs', async () => {
	const { store, game, direct } = await fixture();
	const other = await direct.createGame();
	const runtime = new RuntimeContent(store.connection);
	const data = 'data:image/png;base64,AA==';
	const hash = runtime.asset(game.id, 'image/png', data);
	expect(runtime.asset(game.id, 'image/png', data)).toBe(hash);
	expect(runtime.readAsset(other.id, hash)).toBeNull();
	const artifact = runtime.artifact(game.id, 'logic', { version: 1, source: 'const x=1;' });
	expect(runtime.artifact(game.id, 'logic', { version: 1, source: 'const x=1;' })).toBe(artifact);
	expect(runtime.readArtifact(other.id, artifact)).toBeNull();
	expect(
		store.connection.prepare('SELECT count(*) AS n FROM blobs WHERE game_id=?').get(game.id)
	).toEqual({ n: 1 });
});

const PNG = 'data:image/png;base64,AA==';
// Shared with src-tauri/src/runtime_content.rs; both hosts must produce these exact values.
const MEDIA_HASH = '9d5195c090c835cc7998e488ac91f7820df9893d128fde89778cf1c7839dd9db';
const BLOB_ID_GAME_A = 'ded57360c9689691f2457f7730c39195339340d171dd9240f33d92af2d0776f5';

it('derives game-owned blob IDs from a shared vector while keeping the media hash game-independent', () => {
	expect(runtimeHash(PNG)).toBe(MEDIA_HASH);
	expect(runtimeBlobId('game-a', PNG)).toBe(BLOB_ID_GAME_A);
	expect(runtimeBlobId('game-b', PNG)).not.toBe(BLOB_ID_GAME_A);
});

it('gives two games using the same media their own blob rows that survive each other', async () => {
	const { store, game, direct } = await fixture();
	const other = await direct.createGame();
	const runtime = new RuntimeContent(store.connection);
	expect(runtime.asset(game.id, 'image/png', PNG)).toBe(runtimeBlobId(game.id, PNG));
	expect(runtime.asset(other.id, 'image/png', PNG)).toBe(runtimeBlobId(other.id, PNG));
	const owned = (id: string) =>
		store.connection.prepare('SELECT count(*) AS n FROM blobs WHERE game_id=?').get(id);
	expect(owned(game.id)).toEqual({ n: 1 });
	expect(owned(other.id)).toEqual({ n: 1 });
	expect(runtime.readAsset(game.id, MEDIA_HASH)?.data).toBe(PNG);
	expect(runtime.readAsset(other.id, MEDIA_HASH)?.data).toBe(PNG);
	await direct.trashGame(game.id);
	await direct.purgeGame(game.id);
	expect(runtime.readAsset(game.id, MEDIA_HASH)).toBeNull();
	expect(runtime.readAsset(other.id, MEDIA_HASH)?.data).toBe(PNG);
});

it('keeps reading media indexed under a legacy global blob ID', async () => {
	const { store, game, direct } = await fixture();
	const other = await direct.createGame();
	const runtime = new RuntimeContent(store.connection);
	const legacy = MEDIA_HASH;
	const row = (gameId: string) =>
		JSON.stringify({ schemaVersion: 1, id: legacy, gameId, mime: 'image/png', data: PNG });
	store.connection
		.prepare('INSERT INTO blobs (id,game_id,value) VALUES (?,?,?)')
		.run(legacy, game.id, row(game.id));
	for (const id of [game.id, other.id]) {
		store.connection
			.prepare('INSERT INTO runtime_assets (game_id,hash,blob_id) VALUES (?,?,?)')
			.run(id, MEDIA_HASH, legacy);
	}
	expect(runtime.asset(game.id, 'image/png', PNG)).toBe(legacy);
	expect(runtime.readAsset(game.id, MEDIA_HASH)?.data).toBe(PNG);
	// The legacy row belongs to the first game, so the second keeps the old null result.
	expect(runtime.readAsset(other.id, MEDIA_HASH)).toBeNull();
});

it('prepares a legacy game once without losing either branch or its messages', async () => {
	const { store, game, direct, repo } = await fixture();
	await repo.appendUserMessage(game.id, game.activeSessionId, 'First');
	const first = await repo.getSessionHistory(game.id, game.activeSessionId);
	await repo.appendUserMessage(game.id, game.activeSessionId, 'Archived');
	const second = await repo.getSessionHistory(game.id, game.activeSessionId);
	await repo.selectSessionBranch(
		game.id,
		game.activeSessionId,
		first.progress.headId,
		second.progress.revision
	);
	await repo.appendUserMessage(game.id, game.activeSessionId, 'Current');
	const before = await repo.getSessionTimeline(game.id, game.activeSessionId);
	const source = (await direct.getGameWorkspace(game.id))!.game;
	for (const script of Object.values(source.scripts)) {
		delete script.compiled;
		delete script.compiledFor;
	}
	delete source.ui!.compiled;
	store.connection
		.prepare('UPDATE games SET value=? WHERE id=?')
		.run(JSON.stringify(source), game.id);
	const play = (await repo.getPlayWorkspace(game.id))!;
	expect(play.timeline.history.progress.state).toEqual(before.history.progress.state);
	expect(play.timeline.history.progress.headId).toBe(before.history.progress.headId);
	expect(play.timeline.messages).toEqual(before.messages);
	const after = await repo.getSessionTimeline(game.id, game.activeSessionId);
	expect(after.events.map((event) => event.id)).toEqual(before.events.map((event) => event.id));
	expect(after.events.flatMap((event) => event.message?.content ?? [])).toContain('Archived');
	expect((await direct.getGameWorkspace(game.id))!.game.scripts.main.source).toBe(
		game.scripts.main.source
	);
});
