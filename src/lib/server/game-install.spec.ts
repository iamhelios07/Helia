import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GameReleaseContent } from '#lib/games/versioning.js';
import type { InstallRequest, InstallPreviewEntry } from '#lib/storage/install.js';

import { editorContent, createEditorDraft } from '#lib/games/editor.js';
import { parseInstalledFrom } from '#lib/games/installed-from.js';
import { parseGame } from '#lib/games/model.js';
import { decodeGamePackage, encodeGamePackage } from '#lib/games/package/codec.js';
import minimal from '#lib/games/package/fixtures/minimal-release.json';
import surrogateCases from '#lib/games/package/fixtures/surrogate-cases.json';
import { GamePackageError } from '#lib/games/package/limits.js';
import { verifyReleaseContent } from '#lib/games/package/verify.js';
import { hashGameReleaseContent, gameReleaseContent } from '#lib/games/release-content.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import conflictCases from '#lib/storage/fixtures/install/conflict-cases.json';
import contentCases from '#lib/storage/fixtures/install/content-cases.json';
import releaseCases from '#lib/storage/fixtures/install/release-cases.json';
import scenario from '#lib/storage/fixtures/install/scenario.json';
import { parseInstallRequest } from '#lib/storage/install.js';
import { parseReply, storedRecord } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';
import { StorageContentCache, type SyncReply } from '#lib/storage/sync.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
import { storageAsset, storageSync, storageSyncAsync } from './storage-sync.js';

let store: ReturnType<typeof openStorage>;
let repo: ReturnType<typeof createGameRepository>;
beforeEach(() => {
	store = openStorage(':memory:');
	repo = createGameRepository(
		synchronizedStorage(
			(request) => storageSyncAsync(store, request),
			async (gameId, hash) => storageAsset(store, gameId, hash)!.data
		)
	);
});
afterEach(() => store.close());

const request = (): InstallRequest => ({
	kind: 'install',
	gameId: randomUUID(),
	sessionId: randomUUID(),
	packageFormatVersion: 1,
	release: structuredClone(minimal)
});
const counts = () =>
	['games', 'sessions', 'game_releases', 'game_release_selection'].map((table) =>
		store.connection.prepare(`SELECT count(*) FROM ${table}`).pluck().get()
	);

it('rejects package asset references before looking up blobs, regardless of DB contents', async () => {
	const input = request();
	const id = '0'.repeat(64);
	input.release.content = {
		...minimal.content,
		resources: { portrait: { name: 'portrait.png', mime: 'image/png', data: `helia-asset:${id}` } }
	};
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'missingAsset' });
	store.connection.prepare('INSERT INTO games(id,value) VALUES(?,?)').run(input.gameId, '{}');
	store.connection
		.prepare('INSERT INTO blobs VALUES(?,?,?)')
		.run(id, input.gameId, '{"data":"data:image/png;base64,AA=="}');
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'missingAsset' });
	// Even a broken blob table cannot influence input verification.
	store.connection.exec('DROP TABLE blobs');
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'missingAsset' });
});

interface Fixture {
	request: unknown;
	expect: {
		accepted: boolean;
		normalizedContent?: unknown;
		contentHash?: string;
		conflict?: unknown;
		release?: unknown;
		installedFrom?: unknown;
		errorCode?: string;
	};
}

async function checkFixture(fixture: Fixture) {
	const before = counts();
	const pending = store.requestAsync(fixture.request);
	const expected = fixture.expect;
	if (expected.errorCode) {
		const error = await pending.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(GamePackageError);
		expect(error).toMatchObject({ code: expected.errorCode });
		expect(counts()).toEqual(before);
		return;
	}
	const reply = parseReply(await pending);
	if (expected.conflict) {
		expect(reply.installResult).toEqual(expected.conflict);
		expect(counts()).toEqual(before);
		return;
	}
	expect(expected.accepted).toBe(true);
	expect(reply.installResult?.kind).toBe('installed');
	if (reply.installResult?.kind !== 'installed') {
		throw Error('Expected installation');
	}
	const { gameId, versioning } = reply.installResult;
	expect(versioning.modified).toBe(false);
	expect(versioning.contentHash).toBe(expected.contentHash);
	const release = await repo.getGameRelease(gameId, versioning.currentRelease!.id);
	expect(release.content).toEqual(expected.normalizedContent);
	const game = (await repo.getGameWorkspace(gameId))!.game;
	const replaceNow = (value: unknown) =>
		JSON.parse(JSON.stringify(value).replaceAll('$now', game.createdAt));
	if (expected.release) {
		expect(release).toMatchObject(replaceNow(expected.release));
	}
	if (expected.installedFrom) {
		expect(game.installedFrom).toEqual(replaceNow(expected.installedFrom));
	}
	expect(
		await verifyReleaseContent(
			{ ...release, content: release.content },
			{
				gameId,
				sessionId: game.activeSessionId,
				now: game.createdAt
			}
		)
	).toEqual({ content: release.content, contentHash: release.contentHash });
}

it.each([...contentCases, ...releaseCases])('shared content/timestamp: $name', checkFixture);
it.each(surrogateCases)('rejects shared raw JSON: $name', async ({ rawJson, errorCode }) => {
	await checkFixture({ request: JSON.parse(rawJson), expect: { accepted: false, errorCode } });
});
it.each(conflictCases)('shared install: $name', async (fixture) => {
	for (const setup of fixture.setup ?? []) {
		await store.requestAsync(setup);
	}
	await checkFixture(fixture);
});
it('shared complete version-change and reconflict scenario', async () => {
	for (const setup of scenario.setup) {
		await store.requestAsync(setup);
	}
	for (const step of scenario.steps) {
		await checkFixture(step);
	}
	const installed = scenario.steps[2].request;
	const rows = store.connection
		.prepare('SELECT content_version FROM game_releases WHERE game_id=?')
		.all(installed.gameId);
	expect(rows).toEqual([{ content_version: '2.0.0' }]);
});

it.each(['games', 'sessions', 'game_releases', 'game_release_selection'])(
	'rolls back all rows after an injected failure writing %s',
	async (table) => {
		store.connection.exec(
			`CREATE TRIGGER fail_install AFTER INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`
		);
		await expect(store.requestAsync(request())).rejects.toThrow('injected');
		expect(counts()).toEqual([0, 0, 0, 0]);
	}
);
it('rolls back when final active-session validation fails', async () => {
	store.connection.exec(`CREATE TRIGGER corrupt_active AFTER INSERT ON game_release_selection BEGIN
		UPDATE games SET value=json_set(value,'$.activeSessionId','missing') WHERE id=NEW.game_id; END`);
	await expect(store.requestAsync(request())).rejects.toThrow();
	expect(counts()).toEqual([0, 0, 0, 0]);
});
it.each([129, 257])(
	'installs packages carrying %i small resources after a package v1 round trip',
	async (count) => {
		const content = {
			...structuredClone(minimal.content),
			resources: Object.fromEntries(
				Array.from({ length: count }, (_, index) => [
					`asset-${index}`,
					{
						name: `images/asset-${index}.png`,
						mime: 'image/png',
						data: 'data:image/png;base64,AA=='
					}
				])
			)
		} as GameReleaseContent;
		const release = {
			originalGameId: minimal.originalGameId,
			contentVersion: '1.0.0',
			createdAt: minimal.createdAt,
			content,
			contentHash: await hashGameReleaseContent(content)
		};
		const decoded = await decodeGamePackage(await encodeGamePackage(structuredClone(release)));
		const input = {
			...request(),
			release: { ...decoded.manifest.release, content: decoded.content }
		};
		const reply = await store.requestAsync(input);
		if (reply.installResult?.kind !== 'installed') {
			throw Error('Expected install');
		}
		const frozen = await repo.getGameRelease(
			reply.installResult.gameId,
			reply.installResult.versioning.currentRelease!.id
		);
		expect(Object.keys(frozen.content.resources ?? {})).toHaveLength(count);
		expect(frozen.content.resources).toEqual(content.resources);
	}
);

it('rejects a reused session id without leaving a second game', async () => {
	const first = request();
	await store.requestAsync(first);
	await expect(store.requestAsync({ ...request(), sessionId: first.sessionId })).rejects.toThrow();
	expect(counts()).toEqual([1, 1, 1, 1]);
});
it('rejects the synchronous install entry point', () => {
	expect(() => store.request(request())).toThrow('requestAsync');
	expect(counts()).toEqual([0, 0, 0, 0]);
});
it('uses the private verified clone after the caller mutates its request during await', async () => {
	const input = request();
	const pending = store.requestAsync(input);
	input.release.content = { malicious: true };
	input.gameId = randomUUID();
	const result = (await pending).installResult!;
	expect(result.kind).toBe('installed');
	if (result.kind === 'installed') {
		expect(result.gameId).not.toBe(input.gameId);
		expect((await repo.getGameWorkspace(result.gameId))!.game.title).toBe(minimal.content.title);
	}
});
it('rechecks DB state changed during asynchronous verification', async () => {
	const input = request();
	const pending = store.requestAsync(input);
	const now = new Date().toISOString();
	store.request({
		kind: 'create',
		gameId: input.gameId,
		records: [
			storedRecord('games', {
				...minimal.content,
				schemaVersion: 2,
				id: input.gameId,
				activeSessionId: input.sessionId,
				createdAt: now,
				updatedAt: now
			}),
			storedRecord('sessions', {
				schemaVersion: 1,
				id: input.sessionId,
				gameId: input.gameId,
				title: 'Session',
				createdAt: now,
				updatedAt: now
			})
		]
	});
	await expect(pending).rejects.toThrow();
	expect(counts()).toEqual([1, 1, 0, 0]);
});

it('preserves provenance through edit, Apply, release, Trash and restore, without changing the digest', async () => {
	const result = await repo.install({ release: minimal, packageFormatVersion: 1 });
	if (result.kind !== 'installed') {
		throw Error('Expected install');
	}
	const gameId = result.gameId;
	await repo.unlockGame(gameId);
	let game = (await repo.getGameWorkspace(gameId))!.game;
	const provenance = game.installedFrom!;
	expect(provenance.installedAt).toBe(game.createdAt);
	expect(
		await hashGameReleaseContent(gameReleaseContent({ ...game, installedFrom: undefined }))
	).toBe(result.versioning.contentHash);
	game = await repo.updateGame(gameId, { title: 'Renamed', genre: '', description: '' });
	await repo.applyGameDraft(gameId, {
		baseContent: editorContent(game),
		content: editorContent(game)
	});
	await repo.createGameRelease(gameId, '3.0.0');
	await repo.trashGame(gameId);
	await repo.restoreGame(gameId);
	expect((await repo.getGameWorkspace(gameId))!.game.installedFrom).toEqual(provenance);
});

it.each(['omit', 'change', 'remove'] as const)(
	'normal record and patch writes preserve provenance: %s',
	async (change) => {
		const input = request();
		await store.requestAsync(input);
		const before = (await repo.getGameWorkspace(input.gameId))!.game;
		const { installedFrom, ...without } = before;
		const altered =
			change === 'change'
				? { ...before, installedFrom: { ...installedFrom!, versionChanged: true } }
				: without;
		const reply = store.request({ kind: 'read', gameId: input.gameId });
		store.request({
			kind: 'commit',
			gameId: input.gameId,
			version: reply.version,
			records: [storedRecord('games', altered)],
			deleteSessions: []
		});
		store.request({
			kind: 'commit',
			gameId: input.gameId,
			version: reply.version + 1,
			records: [],
			deleteSessions: [],
			gamePatch: {
				set:
					change === 'change' ? { installedFrom: { ...installedFrom!, versionChanged: true } } : {},
				remove: change === 'change' ? [] : ['installedFrom']
			}
		});
		expect((await repo.getGameWorkspace(input.gameId))!.game.installedFrom).toEqual(installedFrom);
	}
);

it('normal creates and commits cannot add package provenance', async () => {
	const source = request();
	await store.requestAsync(source);
	const imported = (await repo.getGameWorkspace(source.gameId))!.game;
	const own = await repo.createGame();
	store.request({
		kind: 'commit',
		gameId: own.id,
		version: 0,
		records: [],
		deleteSessions: [],
		gamePatch: { set: { installedFrom: imported.installedFrom }, remove: [] }
	});
	expect((await repo.getGameWorkspace(own.id))!.game.installedFrom).toBeUndefined();
	const copy = { ...imported, id: randomUUID(), activeSessionId: randomUUID() };
	store.request({
		kind: 'create',
		gameId: copy.id,
		records: [
			storedRecord('games', copy),
			storedRecord('sessions', {
				schemaVersion: 1,
				id: copy.activeSessionId,
				gameId: copy.id,
				title: 'Session',
				createdAt: copy.createdAt,
				updatedAt: copy.updatedAt
			})
		]
	});
	expect((await repo.getGameWorkspace(copy.id))!.game.installedFrom).toBeUndefined();
	expect((await repo.getGameWorkspace(copy.id))!.game.editLock).toBeUndefined();
});

it('previews selected release, modifications and drafts, excluding Trash', async () => {
	const input = request();
	await store.requestAsync(input);
	const preview = () => repo.installPreview(minimal.originalGameId, minimal.contentVersion);
	expect(await preview()).toMatchObject([
		{
			gameId: input.gameId,
			hasDraft: false,
			existingHashes: [minimal.contentHash],
			versioning: { modified: false, currentRelease: { contentVersion: minimal.contentVersion } }
		}
	]);
	await repo.unlockGame(input.gameId);
	const game = await repo.updateGame(input.gameId, {
		title: 'Changed',
		genre: '',
		description: ''
	});
	editorDraftStorage(store.connection).write(game.id, createEditorDraft(game), 0);
	expect(await preview()).toMatchObject([
		{ title: 'Changed', hasDraft: true, versioning: { modified: true } }
	]);
	await repo.trashGame(game.id);
	expect(await preview()).toEqual([]);
	await repo.restoreGame(game.id);
	expect(await preview()).toHaveLength(1);
});

it('previews under a concurrent writer lock using a deferred read transaction', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'helia-install-preview-'));
	const filename = join(directory, 'game.sqlite');
	const reader = openStorage(filename);
	const writer = openStorage(filename);
	try {
		const input = request();
		await reader.requestAsync(input);
		reader.connection.pragma('busy_timeout = 10');
		writer.connection.exec('BEGIN IMMEDIATE');
		const reply = reader.request({
			kind: 'installPreview',
			originalGameId: minimal.originalGameId,
			contentVersion: minimal.contentVersion
		});
		expect(reply.installPreview).toMatchObject([{ gameId: input.gameId }]);
	} finally {
		if (writer.connection.inTransaction) {
			writer.connection.exec('ROLLBACK');
		}
		writer.close();
		reader.close();
		rmSync(filename);
		rmdirSync(directory);
	}
});

it('loads all preview release histories once with the same states as individual versioning reads', async () => {
	const first = request();
	const second = request();
	await store.requestAsync(first);
	await store.requestAsync(second);
	await repo.unlockGame(first.gameId);
	await repo.createGameRelease(first.gameId, '2.0.0');
	await repo.updateGame(first.gameId, { title: 'Changed', genre: '', description: '' });
	const changed = await repo.getGameVersioning(first.gameId);
	await repo.createGameRelease(first.gameId, '1.0.0', {
		ignoreConflict: true,
		expectedContentHash: changed.contentHash
	});
	const states = await Promise.all(
		[first, second].map((input) => repo.getGameVersioning(input.gameId))
	);
	const prepare = vi.spyOn(store.connection, 'prepare');
	let preview: InstallPreviewEntry[];
	try {
		preview = await repo.installPreview(minimal.originalGameId, '1.0.0');
		expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM game_releases'))).toHaveLength(
			1
		);
	} finally {
		prepare.mockRestore();
	}
	for (const [index, input] of [first, second].entries()) {
		expect(preview.find((entry) => entry.gameId === input.gameId)?.versioning).toEqual(
			states[index]
		);
	}
	expect(preview.find((entry) => entry.gameId === first.gameId)?.existingHashes).toEqual(
		[minimal.contentHash, changed.contentHash].sort()
	);
});

it.each([null, {}, { kind: 'other' }, { kind: 'package', packageFormatVersion: 0 }])(
	'strictly rejects invalid provenance %j',
	(value) => {
		expect(() => parseInstalledFrom(value)).toThrow();
		expect(() =>
			parseGame({
				...minimal.content,
				schemaVersion: 2,
				id: 'g',
				activeSessionId: 's',
				createdAt: minimal.createdAt,
				updatedAt: minimal.createdAt,
				installedFrom: value
			})
		).toThrow();
	}
);

it('bounds raw complexity before normalization at the host boundary', async () => {
	const input = request();
	input.release.content = { ...minimal.content, unknown: Array(100000).fill(null) };
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'content' });
	let nested: unknown = null;
	for (let i = 0; i < 65; i++) {
		nested = [nested];
	}
	input.release.content = nested;
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'content' });
	input.release.content = 'x'.repeat(16 * 1024 * 1024 + 1);
	await expect(store.requestAsync(input)).rejects.toMatchObject({ code: 'content' });
	expect(counts()).toEqual([0, 0, 0, 0]);
});

it('rejects malformed preview and installation identifiers', async () => {
	await expect(
		store.requestAsync({
			kind: 'installPreview',
			originalGameId: minimal.originalGameId.toUpperCase(),
			contentVersion: '1.0.0'
		})
	).rejects.toThrow();
	await expect(
		store.requestAsync({
			kind: 'installPreview',
			originalGameId: minimal.originalGameId,
			contentVersion: '01.0.0'
		})
	).rejects.toThrow();
	expect(() => parseInstallRequest({ ...request(), gameId: 'not-uuid' })).toThrow();
	expect(() => parseInstallRequest({ ...request(), sessionId: 'not-uuid' })).toThrow();
});

it('rejects package operations inside sync envelopes at both entry points', async () => {
	for (const command of [
		request(),
		{
			kind: 'installPreview',
			originalGameId: minimal.originalGameId,
			contentVersion: minimal.contentVersion
		}
	]) {
		const envelope = { kind: 'sync', request: command, known: [] };
		expect(() => storageSync(store, envelope)).toThrow('sent directly');
		await expect(storageSyncAsync(store, envelope)).rejects.toThrow('sent directly');
	}
	expect(counts()).toEqual([0, 0, 0, 0]);
});

it('sends install and preview directly through the synchronized client', async () => {
	const send = vi.fn((input: unknown) => storageSyncAsync(store, input));
	const transport = synchronizedStorage(send, async () => '');
	const input = request();
	expect((await transport(input)).installResult?.kind).toBe('installed');
	expect(send).toHaveBeenLastCalledWith(input);
	const preview = {
		kind: 'installPreview' as const,
		originalGameId: minimal.originalGameId,
		contentVersion: minimal.contentVersion
	};
	expect((await transport(preview)).installPreview).toHaveLength(1);
	expect(send).toHaveBeenLastCalledWith(preview);
});

it('exports only sync response fields on the server and in the cache decoder', async () => {
	const installed = await store.requestAsync(request());
	const extra = { installResult: installed.installResult, installPreview: [] };
	const reply = { version: 0, records: [], games: [] };
	const spy = vi.spyOn(store, 'request').mockReturnValue({ ...reply, ...extra });
	try {
		expect(storageSync(store, { kind: 'sync', request: { kind: 'list' }, known: [] })).toEqual(
			reply
		);
		expect(
			await new StorageContentCache().decode(
				{ ...reply, ...extra } as SyncReply,
				async () => '',
				new Map()
			)
		).toEqual(reply);
	} finally {
		spy.mockRestore();
	}
});

it('reports per-installation preview hashes and uses their union only for conflicts', async () => {
	const first = request();
	await store.requestAsync(first);
	const other = request();
	other.installContentVersion = '2.0.0';
	await store.requestAsync(other);
	const preview = await repo.installPreview(minimal.originalGameId, '1.0.0');
	expect(preview.find((row) => row.gameId === first.gameId)!.existingHashes).toEqual([
		minimal.contentHash
	]);
	expect(preview.find((row) => row.gameId === other.gameId)!.existingHashes).toEqual([]);
});

it('rolls back on the final authoritative stored-content hash check', async () => {
	store.connection.exec(`CREATE TRIGGER corrupt_content AFTER INSERT ON game_release_selection BEGIN
		UPDATE games SET value=json_set(value,'$.title','corrupted') WHERE id=NEW.game_id; END`);
	await expect(store.requestAsync(request())).rejects.toMatchObject({ code: 'integrity' });
	expect(counts()).toEqual([0, 0, 0, 0]);
});

it('queries conflicts after verification even when a release arrived during await', async () => {
	const original = request();
	await store.requestAsync(original);
	await repo.unlockGame(original.gameId);
	const input = request();
	const content = gameReleaseContent((await repo.getGameWorkspace(original.gameId))!.game);
	content.title = 'Different';
	input.release.content = content;
	input.release.contentHash = await hashGameReleaseContent(content);
	input.installContentVersion = '2.0.0';
	const pending = store.requestAsync(input);
	await repo.createGameRelease(original.gameId, '2.0.0');
	const result = (await pending).installResult;
	expect(result).toMatchObject({ kind: 'conflict', existingHashes: [minimal.contentHash] });
	expect(counts()).toEqual([1, 1, 2, 1]);
});
