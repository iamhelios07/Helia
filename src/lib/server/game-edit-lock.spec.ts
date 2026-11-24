import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { GAME_EDIT_LOCKED } from '#lib/games/edit-lock.js';
import { createEditorDraft, editorContent } from '#lib/games/editor.js';
import minimal from '#lib/games/package/fixtures/minimal-release.json';
import { createGameRepository } from '#lib/games/repository-core.js';
import { evaluateAction } from '#lib/games/scripting/engine.js';
import fixtures from '#lib/storage/fixtures/edit-lock.json';
import { storedRecord, type StorageRequest } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { guardGameEdit } from './game-edit-lock.js';
import { openStorage } from './sqlite.js';
import { storageSync, storageSyncAsync } from './storage-sync.js';

let store: ReturnType<typeof openStorage>;
let repo: ReturnType<typeof createGameRepository>;
let gameId: string;
beforeEach(async () => {
	store = openStorage(':memory:');
	repo = createGameRepository(
		synchronizedStorage(
			(input) => storageSyncAsync(store, input),
			async () => ''
		)
	);
	gameId = randomUUID();
	await store.requestAsync({
		kind: 'install',
		gameId,
		sessionId: randomUUID(),
		packageFormatVersion: 1,
		release: minimal
	});
});
afterEach(() => store.close());
const workspace = async () => (await repo.getGameWorkspace(gameId))!;
const read = () => store.request({ kind: 'read', gameId });

it.each(
	fixtures.storedGames.flatMap((fixture) => [false, true].map((sync) => ({ ...fixture, sync })))
)(
	'checks only the lock and unlocks without normalizing $name (sync=$sync)',
	async ({ value, sync }) => {
		const game = { ...(await workspace()).game, ...value };
		store.connection
			.prepare('UPDATE games SET value=? WHERE id=?')
			.run(JSON.stringify(game), gameId);
		const stored = () =>
			store.connection.prepare('SELECT value, version FROM games WHERE id=?').get(gameId) as {
				value: string;
				version: number;
			};
		const before = stored();
		for (const operation of ['draft', 'apply', 'release'] as const) {
			expect(() => guardGameEdit(store.connection, gameId, operation)).toThrow(GAME_EDIT_LOCKED);
		}
		expect(() => editorDraftStorage(store.connection).write(gameId, null, 0)).toThrow(
			GAME_EDIT_LOCKED
		);
		expect(() =>
			dispatch({ kind: 'versioning', action: 'release', gameId, contentVersion: '2.0.0' }, sync)
		).toThrow(GAME_EDIT_LOCKED);
		expect(stored()).toEqual(before);
		expect(dispatch({ kind: 'unlockGame', gameId }, sync).version).toBe(before.version + 1);
		const row = store.connection.prepare('SELECT value FROM games WHERE id=?').get(gameId) as {
			value: string;
		};
		expect(JSON.parse(row.value)).toEqual({ ...game, editLock: false });
		expect(editorDraftStorage(store.connection).write(gameId, null, 0).version).toBe(1);
	}
);

it.each(fixtures.values)(
	'validates the stored lock independently: $name',
	async ({ value, valid }) => {
		const game = { ...(await workspace()).game, editLock: value };
		store.connection
			.prepare('UPDATE games SET value=? WHERE id=?')
			.run(JSON.stringify(game), gameId);
		for (const operation of ['draft', 'apply', 'release'] as const) {
			if (valid && value === false) {
				expect(() => guardGameEdit(store.connection, gameId, operation)).not.toThrow();
			} else {
				expect(() => guardGameEdit(store.connection, gameId, operation)).toThrow(
					valid ? GAME_EDIT_LOCKED : 'INVALID_EDIT_LOCK'
				);
			}
		}
		if (!valid) {
			expect(() => store.request({ kind: 'unlockGame', gameId })).toThrow('INVALID_EDIT_LOCK');
		}
	}
);

function dispatch(input: unknown, sync: boolean) {
	return sync
		? storageSync(store, { kind: 'sync', known: [], request: input })
		: store.request(input);
}

const writeCases = fixtures.writes.flatMap((fixture) =>
	['record', 'patch', 'syncPatch'].flatMap((shape) =>
		(shape === 'syncPatch' ? [true] : [true, false]).map((sync) => ({ ...fixture, shape, sync }))
	)
);

it.each(writeCases)('guards $name via $shape (sync=$sync)', async (fixture) => {
	const previous = read();
	const value = { ...(await workspace()).game, ...fixture.set } as Record<string, unknown>;
	for (const key of fixture.remove) {
		delete value[key];
	}
	const patch = { set: fixture.set, remove: fixture.remove };
	const row =
		fixture.shape === 'syncPatch'
			? { table: 'games', id: gameId, gameId, sessionId: null, patch }
			: storedRecord('games', value);
	const command = {
		kind: 'commit',
		gameId,
		version: previous.version,
		deleteSessions: [],
		records: fixture.shape === 'patch' ? [] : [row],
		...(fixture.shape === 'patch' ? { gamePatch: patch } : {})
	};
	if (fixture.allowed) {
		dispatch(command, fixture.sync);
		expect((await workspace()).game.editLock).toBe(true);
	} else {
		expect(() => dispatch(command, fixture.sync)).toThrow(GAME_EDIT_LOCKED);
		expect(read()).toEqual(previous);
	}
});

it.each([false, true])('guards release (sync=%s)', async (sync) => {
	expect(() =>
		dispatch({ kind: 'versioning', action: 'release', gameId, contentVersion: '2.0.0' }, sync)
	).toThrow(GAME_EDIT_LOCKED);
	expect((await repo.getGameVersioning(gameId)).currentRelease?.contentHash).toBe(
		minimal.contentHash
	);
});

it.each(fixtures.values.filter((fixture) => !fixture.valid))(
	'rejects malformed host lock: $name',
	async ({ value }) => {
		const before = read();
		const game = { ...(await workspace()).game, editLock: value };
		expect(() =>
			dispatch(
				{
					kind: 'commit',
					gameId,
					version: before.version,
					records: [storedRecord('games', game)],
					deleteSessions: []
				},
				false
			)
		).toThrow('INVALID_EDIT_LOCK');
		expect(read()).toEqual(before);
	}
);

it('rejects draft saves and clears, including stale revisions, without writing', async () => {
	const drafts = editorDraftStorage(store.connection);
	const draft = createEditorDraft((await workspace()).game);
	for (const value of [draft, null]) {
		expect(() => drafts.write(gameId, value, 0)).toThrow(GAME_EDIT_LOCKED);
		expect(() => drafts.write(gameId, value, 99)).toThrow(GAME_EDIT_LOCKED);
	}
	expect(drafts.read(gameId)).toEqual({ version: 0, draft: null });
});

it('preserves play, Trash and restore; unlock permits draft, Apply and release and cannot be undone by writes', async () => {
	const installed = await workspace();
	expect(installed.game.editLock).toBe(true);
	expect((await repo.listGames())[0].editLock).toBe(true);
	const second = await repo.createSession(gameId);
	await repo.selectSession(gameId, second.id);
	await repo.appendUserMessage(gameId, second.id, 'hello');
	await repo.trashGame(gameId);
	await repo.restoreGame(gameId);
	expect((await workspace()).game.editLock).toBe(true);
	const beforeUnlock = read();
	await repo.unlockGame(gameId);
	expect(read().version).toBe(beforeUnlock.version + 1);
	const unlockedVersion = read().version;
	await repo.unlockGame(gameId);
	expect(read().version).toBe(unlockedVersion);
	const game = (await workspace()).game;
	expect(game).toEqual({
		...(beforeUnlock.records.find((row) => row.table === 'games')!.value as object),
		editLock: false
	});
	expect((await repo.getGameVersioning(gameId)).modified).toBe(false);
	const draft = createEditorDraft(game);
	expect(editorDraftStorage(store.connection).write(gameId, draft, 0).version).toBe(1);
	await repo.applyGameDraft(gameId, {
		baseContent: editorContent(game),
		content: { ...editorContent(game), title: 'Editable' }
	});
	expect((await repo.createGameRelease(gameId, '2.0.0')).kind).toBe('released');
	store.request({
		kind: 'commit',
		gameId,
		version: read().version,
		records: [],
		deleteSessions: [],
		gamePatch: { set: { editLock: true }, remove: [] }
	});
	expect((await workspace()).game.editLock).toBe(false);
	expect((await workspace()).game.installedFrom).toEqual(installed.game.installedFrom);
});

it('creator games have no lock and cannot acquire it through create or commit', async () => {
	const game = await repo.createGame();
	expect(game.editLock).toBeUndefined();
	const command: StorageRequest = {
		kind: 'commit',
		gameId: game.id,
		version: 0,
		records: [],
		deleteSessions: [],
		gamePatch: { set: { editLock: true }, remove: [] }
	};
	store.request(command);
	expect((await repo.getGameWorkspace(game.id))!.game.editLock).toBeUndefined();
	await repo.unlockGame(game.id);
	expect((await repo.getGameWorkspace(game.id))!.game.editLock).toBeUndefined();
});

it('unlock leaves sandbox host access and secret availability unchanged', async () => {
	const evaluate = async () => {
		const game = (await workspace()).game;
		return evaluateAction({
			schema: game.schema,
			state: game.initialState,
			scripts: {
				main: {
					language: 'javascript',
					source: `helia.defineAction({name:'probe', async run({state}) {
				if (typeof process !== 'undefined' || typeof window !== 'undefined' || typeof __HELIA_STORAGE__ !== 'undefined' || typeof __TAURI_INTERNALS__ !== 'undefined') throw Error('host exposed');
				let denied = false;
				try { await helia.secrets.ref('private'); } catch { denied = true; }
				if (!denied) throw Error('secret exposed');
				return state;
			}});`
				}
			},
			action: { name: 'probe', args: {} }
		});
	};
	const before = await evaluate();
	await repo.unlockGame(gameId);
	expect(await evaluate()).toEqual(before);
});
