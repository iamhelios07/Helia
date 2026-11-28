import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { createEditorDraft, readEditorDraft } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import {
	RESOURCE_LIST_BYTES,
	resourceListBytes,
	type GameResources
} from '#lib/games/resources.js';
import { record } from '#lib/games/state/model.js';
import { DOCUMENT_OPERATION_LIMITS } from '#lib/games/versioning-validation.js';
import { MEDIA_CHUNK_SIZE } from '#lib/storage/media-protocol.js';
import { storedRecord } from '#lib/storage/protocol.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
import { storageSyncAsync } from './storage-sync.js';

const stores: ReturnType<typeof openStorage>[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) {
		if (store.connection.open) {
			store.close();
		}
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'media-document-'));
	dirs.push(dir);
	const store = openStorage(join(dir, 'db.sqlite'));
	stores.push(store);
	return store;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function uploadDocument(
	store: ReturnType<typeof openStorage>,
	gameId: string,
	operation: string,
	text: string
) {
	const bytes = new TextEncoder().encode(text);
	const { uploadId } = store.uploads.begin(gameId, {
		purpose: 'document',
		operation,
		mime: 'application/json',
		size: bytes.length
	});
	for (let i = 0; i < bytes.length; i += MEDIA_CHUNK_SIZE) {
		const part = bytes.subarray(i, i + MEDIA_CHUNK_SIZE);
		await store.uploads.chunk(gameId, uploadId, i / MEDIA_CHUNK_SIZE, {
			sha256: sha256(part),
			read: async () => part
		});
	}
	const result = await store.uploads.finish(gameId, uploadId);
	return { ref: `helia-upload:${uploadId}`, uploadId, result };
}
/** A storage-format resource map whose canonical JSON is exactly R = 16 MiB. */
function maxResources(): GameResources {
	const resource = {
		name: 'p'.repeat(80) + '000000',
		mime: 'image/png',
		data: 'data:image/png;base64,AA=='
	};
	const entryBytes = resourceListBytes({ r000000: resource }) - 1n;
	const count = Number((RESOURCE_LIST_BYTES - 1n) / entryBytes);
	const resources: GameResources = Object.fromEntries(
		Array.from({ length: count }, (_, index) => {
			const suffix = String(index).padStart(6, '0');
			return ['r' + suffix, { ...resource, name: 'p'.repeat(80) + suffix }];
		})
	);
	let remaining = Number(RESOURCE_LIST_BYTES - (1n + BigInt(count) * entryBytes));
	for (const id of Object.keys(resources).slice(-2)) {
		const added = Math.min(remaining, 200 - resources[id].name.length);
		resources[id].name += 'x'.repeat(added);
		remaining -= added;
	}
	expect(remaining).toBe(0);
	expect(resourceListBytes(resources)).toBe(RESOURCE_LIST_BYTES);
	return resources;
}
async function createGame(store: ReturnType<typeof openStorage>) {
	return createGameRepository(async (request) => store.request(request)).createGame();
}
/** Mirrors the draft route: read the document, validate, then write and consume atomically. */
function saveDraftFromDocument(store: ReturnType<typeof openStorage>, gameId: string, ref: string) {
	const doc = store.uploads.document(gameId, ref, 'draftSave');
	const input = JSON.parse(doc.text) as { version: number; draft: unknown };
	const draft =
		input.draft === null
			? null
			: readEditorDraft(JSON.stringify(input.draft), gameId, { write: true });
	return store.connection
		.transaction(() => {
			const saved = editorDraftStorage(store.connection).write(gameId, draft, input.version);
			store.uploads.consumeDocument(doc.claim);
			return saved;
		})
		.immediate();
}
it('confirms a document upload without a blob and bounds every operation budget', async () => {
	const store = fixture();
	const game = await createGame(store);
	for (const operation of ['draftSave', 'commit', 'releaseCreate'] as const) {
		const limit = Number(DOCUMENT_OPERATION_LIMITS[operation]);
		expect(() =>
			store.uploads.begin(game.id, {
				purpose: 'document',
				operation,
				mime: 'application/json',
				size: limit
			})
		).not.toThrow();
		expect(() =>
			store.uploads.begin(game.id, {
				purpose: 'document',
				operation,
				mime: 'application/json',
				size: limit + 1
			})
		).toThrow(expect.objectContaining({ code: 'mediaSize' }));
	}
	expect(() =>
		store.uploads.begin(game.id, {
			purpose: 'document',
			operation: 'draftSave',
			mime: 'image/png',
			size: 1
		})
	).toThrow(expect.objectContaining({ code: 'mediaType' }));
	expect(() =>
		store.uploads.begin(game.id, { purpose: 'document', mime: 'application/json', size: 1 })
	).toThrow(expect.objectContaining({ code: 'scopeMismatch' }));
	const text = JSON.stringify({ kind: 'writeDraft', gameId: game.id, version: 0, draft: null });
	const { uploadId, result } = await uploadDocument(store, game.id, 'draftSave', text);
	expect(result).toMatchObject({
		kind: 'upload',
		ref: `helia-upload:${uploadId}`,
		mime: 'application/json',
		size: new TextEncoder().encode(text).length,
		sha256: sha256(new TextEncoder().encode(text))
	});
	expect(result).not.toHaveProperty('blobId');
	expect(store.connection.prepare('SELECT count(*) FROM blobs').pluck().get()).toBe(0);
	expect(
		store.connection.prepare('SELECT state FROM media_uploads WHERE id=?').pluck().get(uploadId)
	).toBe('verified');
	// Finish is idempotent while the verified result is retained.
	expect(await store.uploads.finish(game.id, uploadId)).toEqual(result);
});
it('saves a 16 MiB resource game draft, Apply and release with split bodies', async () => {
	const store = fixture();
	const game = await createGame(store);
	const resources = maxResources();
	const updated = { ...game, resources };
	// Apply (commit) carries ~R bytes, above the 8 MiB inline threshold.
	const commit = {
		kind: 'commit',
		gameId: game.id,
		version: 0,
		deleteSessions: [],
		records: [storedRecord('games', updated)]
	};
	const body = JSON.stringify(commit);
	expect(new TextEncoder().encode(body).length).toBeGreaterThan(8 * 1024 * 1024);
	const { ref, uploadId } = await uploadDocument(store, game.id, 'commit', body);
	const reply = await storageSyncAsync(store, {
		kind: 'sync',
		known: [],
		request: { kind: 'commit', gameId: game.id, bodyRef: ref }
	});
	expect(reply.version).toBe(1);
	expect(
		store.connection.prepare('SELECT state FROM media_uploads WHERE id=?').pluck().get(uploadId)
	).toBe('consumed');
	const saved = JSON.parse(
		store.connection.prepare('SELECT value FROM games WHERE id=?').pluck().get(game.id) as string
	);
	expect(resourceListBytes(saved.resources)).toBe(RESOURCE_LIST_BYTES);
	// Draft save carries the resource map twice (~2.3R), also split.
	const draft = createEditorDraft(updated);
	const draftBody = JSON.stringify({
		kind: 'writeDraft',
		gameId: game.id,
		version: 0,
		draft
	});
	expect(new TextEncoder().encode(draftBody).length).toBeGreaterThan(8 * 1024 * 1024);
	const draftUpload = await uploadDocument(store, game.id, 'draftSave', draftBody);
	const savedDraft = saveDraftFromDocument(store, game.id, draftUpload.ref);
	expect(savedDraft.version).toBe(1);
	expect(editorDraftStorage(store.connection).read(game.id).draft?.documents.assets).toBe(
		draft.documents.assets
	);
	// Release creation is assembled from the database; its small request stays inline.
	const released = await storageSyncAsync(store, {
		kind: 'versioning',
		gameId: game.id,
		action: 'release',
		contentVersion: '1.0.0'
	});
	if (!('releaseResult' in released)) {
		throw Error('expected a release result');
	}
	expect(released.releaseResult?.kind).toBe('released');
}, 120000);
it('saves a small-R large-remainder draft (~22.5 MiB) and preserves unfinished JSON', async () => {
	const store = fixture();
	const game = await createGame(store);
	const draft = createEditorDraft(game);
	draft.documents.state = '한'.repeat(7_864_320);
	draft.documents.assets = '{unfinished';
	const body = JSON.stringify({ kind: 'writeDraft', gameId: game.id, version: 0, draft });
	const bytes = new TextEncoder().encode(body).length;
	expect(bytes).toBeGreaterThan(22 * 1024 * 1024);
	expect(bytes).toBeLessThan(23 * 1024 * 1024);
	const { ref } = await uploadDocument(store, game.id, 'draftSave', body);
	const saved = saveDraftFromDocument(store, game.id, ref);
	expect(saved.version).toBe(1);
	const read = editorDraftStorage(store.connection).read(game.id).draft!;
	expect(read.documents.state).toBe(draft.documents.state);
	expect(read.documents.assets).toBe('{unfinished');
}, 120000);
it('rejects a commit bodyRef whose operation or game differs and keeps the session', async () => {
	const store = fixture();
	const game = await createGame(store);
	const commit = {
		kind: 'commit',
		gameId: game.id,
		version: 0,
		deleteSessions: [],
		records: [storedRecord('games', game)]
	};
	const body = JSON.stringify(commit);
	const wrongOperation = await uploadDocument(store, game.id, 'draftSave', body);
	await expect(
		storageSyncAsync(store, {
			kind: 'sync',
			known: [],
			request: { kind: 'commit', gameId: game.id, bodyRef: wrongOperation.ref }
		})
	).rejects.toMatchObject({ code: 'scopeMismatch' });
	expect(
		store.connection
			.prepare('SELECT state FROM media_uploads WHERE id=?')
			.pluck()
			.get(wrongOperation.uploadId)
	).toBe('verified');
	store.connection.exec("INSERT INTO games(id,value) VALUES('other','{}')");
	const wrongGame = await uploadDocument(
		store,
		'other',
		'commit',
		JSON.stringify({ kind: 'commit', gameId: 'other', version: 0, deleteSessions: [], records: [] })
	);
	await expect(
		storageSyncAsync(store, {
			kind: 'sync',
			known: [],
			request: { kind: 'commit', gameId: game.id, bodyRef: wrongGame.ref }
		})
	).rejects.toMatchObject({ code: 'scopeMismatch' });
	expect(
		store.connection.prepare('SELECT version FROM games WHERE id=?').pluck().get(game.id)
	).toBe(0);
});
it('keeps a small commit on the inline path without a document session', async () => {
	const store = fixture();
	const game = await createGame(store);
	const reply = await storageSyncAsync(store, {
		kind: 'sync',
		known: [],
		request: {
			kind: 'commit',
			gameId: game.id,
			version: 0,
			deleteSessions: [],
			records: [storedRecord('games', { ...game, title: 'Changed' })]
		}
	});
	expect(reply.version).toBe(1);
	expect(store.connection.prepare('SELECT count(*) FROM media_uploads').pluck().get()).toBe(0);
});

it('creates an 8–20 MiB game inline before an upload scope exists', async () => {
	const store = fixture();
	const description = '한'.repeat(4 * 1024 * 1024);
	const repository = createGameRepository(async (request) => {
		if (request.kind !== 'create') {
			return store.request(request);
		}
		const command = {
			...request,
			records: request.records.map((row) =>
				row.table === 'games'
					? {
							...row,
							value: {
								...record(row.value),
								settings: { ...record(record(row.value).settings), description }
							}
						}
					: row
			)
		};
		const bytes = new TextEncoder().encode(JSON.stringify(command)).length;
		expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(bytes).toBeLessThan(20 * 1024 * 1024);
		return store.request(command);
	});
	const game = await repository.createGame();
	const saved = JSON.parse(
		store.connection.prepare('SELECT value FROM games WHERE id=?').pluck().get(game.id) as string
	);
	expect(saved.settings.description === description).toBe(true);
	expect(store.connection.prepare('SELECT count(*) FROM media_uploads').pluck().get()).toBe(0);
});

// Same host inputs as storage.rs::document_exact_boundary_host_inputs.
it.each([
	['commit', 8 * 1024 * 1024],
	['commit', 8 * 1024 * 1024 + 1],
	['draftSave', 8 * 1024 * 1024],
	['draftSave', 8 * 1024 * 1024 + 1]
] as const)(
	'accepts %s at exactly %i UTF-8 bytes on its client-selected path',
	async (operation, size) => {
		const store = fixture();
		const game = await createGame(store);
		const updated = { ...game, settings: { ...game.settings, description: '한\0' } };
		const draft = createEditorDraft(game);
		draft.documents.state = '한\0';
		const body =
			operation === 'commit'
				? {
						kind: 'commit',
						gameId: game.id,
						version: 0,
						records: [
							{ table: 'games', id: game.id, gameId: game.id, sessionId: null, value: updated }
						],
						deleteSessions: []
					}
				: { kind: 'writeDraft', gameId: game.id, version: 0, draft };
		const padding = 'x'.repeat(size - new TextEncoder().encode(JSON.stringify(body)).length);
		if (operation === 'commit') {
			updated.settings.description += padding;
		} else {
			draft.documents.state += padding;
		}
		const text = JSON.stringify(body);
		expect(new TextEncoder().encode(text).length).toBe(size);
		const split = size > 8 * 1024 * 1024;
		let version: number;
		if (split) {
			const uploaded = await uploadDocument(store, game.id, operation, text);
			version =
				operation === 'commit'
					? (await storageSyncAsync(store, commitStub(game.id, uploaded.ref))).version
					: saveDraftFromDocument(store, game.id, uploaded.ref).version;
		} else {
			version =
				operation === 'commit'
					? (await storageSyncAsync(store, { kind: 'sync', known: [], request: body })).version
					: editorDraftStorage(store.connection).write(game.id, draft, 0).version;
		}
		expect(version).toBe(1);
		expect(store.connection.prepare('SELECT count(*) FROM media_uploads').pluck().get()).toBe(
			Number(split)
		);
	}
);

function documentState(store: ReturnType<typeof openStorage>, uploadId: string) {
	return store.connection
		.prepare('SELECT state FROM media_uploads WHERE id=?')
		.pluck()
		.get(uploadId);
}
function commitStub(gameId: string, bodyRef: string) {
	return { kind: 'sync', known: [], request: { kind: 'commit', gameId, bodyRef } };
}

it('consumes a bodyRef once and rejects consumed and expired sessions with uploadState', async () => {
	const store = fixture();
	const game = await createGame(store);
	const body = JSON.stringify({
		kind: 'commit',
		gameId: game.id,
		version: 0,
		records: [],
		deleteSessions: []
	});
	const consumed = await uploadDocument(store, game.id, 'commit', body);
	const command = commitStub(game.id, consumed.ref);
	expect((await storageSyncAsync(store, command)).version).toBe(1);
	await expect(storageSyncAsync(store, command)).rejects.toMatchObject({ code: 'uploadState' });
	expect(documentState(store, consumed.uploadId)).toBe('consumed');
	const expired = await uploadDocument(store, game.id, 'commit', body);
	store.connection
		.prepare('UPDATE media_uploads SET expires_at=? WHERE id=?')
		.run('2000-01-01T00:00:00.000Z', expired.uploadId);
	await expect(storageSyncAsync(store, commitStub(game.id, expired.ref))).rejects.toMatchObject({
		code: 'uploadState'
	});
	expect(store.uploads.status(game.id, expired.uploadId).state).toBe('cancelled');
});

it('rejects a body JSON gameId that differs from its upload scope and stub', async () => {
	const store = fixture();
	const game = await createGame(store);
	const body = JSON.stringify({
		kind: 'commit',
		gameId: 'other',
		version: 0,
		records: [],
		deleteSessions: []
	});
	const uploaded = await uploadDocument(store, game.id, 'commit', body);
	await expect(storageSyncAsync(store, commitStub(game.id, uploaded.ref))).rejects.toMatchObject({
		code: 'scopeMismatch'
	});
	expect(documentState(store, uploaded.uploadId)).toBe('verified');
});

it.each(['versioning', 'install', 'installPreview', 'read'])(
	'rejects %s bodyRefs with scopeMismatch both directly and inside sync',
	async (kind) => {
		const store = fixture();
		const game = await createGame(store);
		const command = {
			kind,
			action: 'release',
			gameId: game.id,
			contentVersion: '1.0.0'
		};
		const uploaded = await uploadDocument(store, game.id, 'releaseCreate', JSON.stringify(command));
		for (const bodyRef of [uploaded.ref, null]) {
			const stub = { ...command, bodyRef };
			for (const input of [stub, { kind: 'sync', known: [], request: stub }]) {
				await expect(storageSyncAsync(store, input)).rejects.toMatchObject({
					code: 'scopeMismatch'
				});
			}
		}
		expect(documentState(store, uploaded.uploadId)).toBe('verified');
		expect(store.connection.prepare('SELECT count(*) FROM game_releases').pluck().get()).toBe(0);
	}
);

// Keep this input table paired with storage.rs::document_failed_write_retries_same_body_ref.
it.each([
	['commit', 'conflict'],
	['commit', 'lock'],
	['draftSave', 'conflict'],
	['draftSave', 'lock']
] as const)(
	'keeps %s verified after %s and retries the same bodyRef',
	async (operation, failure) => {
		const store = fixture();
		const game = await createGame(store);
		const version = failure === 'conflict' ? 1 : 0;
		const body =
			operation === 'commit'
				? { kind: 'commit', gameId: game.id, version, records: [], deleteSessions: [] }
				: { kind: 'writeDraft', gameId: game.id, version, draft: null };
		const uploaded = await uploadDocument(store, game.id, operation, JSON.stringify(body));
		const run = () =>
			operation === 'commit'
				? storageSyncAsync(store, commitStub(game.id, uploaded.ref))
				: Promise.resolve().then(() => saveDraftFromDocument(store, game.id, uploaded.ref));
		if (failure === 'lock') {
			store.connection
				.prepare("UPDATE games SET value=json_set(value,'$.editLock',json('true')) WHERE id=?")
				.run(game.id);
			await expect(run()).rejects.toMatchObject({ code: 'gameNotWritable' });
			store.connection
				.prepare("UPDATE games SET value=json_remove(value,'$.editLock') WHERE id=?")
				.run(game.id);
		} else {
			await expect(run()).rejects.toThrow(
				operation === 'commit' ? 'STORAGE_CONFLICT' : 'EDITOR_DRAFT_CONFLICT'
			);
			if (operation === 'commit') {
				store.request({
					kind: 'commit',
					gameId: game.id,
					version: 0,
					records: [],
					deleteSessions: []
				});
			} else {
				editorDraftStorage(store.connection).write(game.id, null, 0);
			}
		}
		expect(documentState(store, uploaded.uploadId)).toBe('verified');
		expect((await run()).version).toBe(version + 1);
		expect(documentState(store, uploaded.uploadId)).toBe('consumed');
	}
);

it('keeps the document Finish deadline fixed during upload activity and reclaims expired bytes', async () => {
	const store = fixture();
	const game = await createGame(store);
	const before = Date.now();
	const uploaded = await uploadDocument(store, game.id, 'draftSave', '{}');
	const status = store.uploads.status(game.id, uploaded.uploadId);
	expect(Date.parse(status.expiresAt)).toBeGreaterThanOrEqual(before + 10 * 60000);
	expect(Date.parse(status.expiresAt)).toBeLessThanOrEqual(Date.now() + 10 * 60000);
	const fixed = new Date(Date.now() + 60000).toISOString();
	store.connection
		.prepare('UPDATE media_uploads SET expires_at=? WHERE id=?')
		.run(fixed, uploaded.uploadId);
	const objectId = store.connection
		.prepare('SELECT object_id FROM media_uploads WHERE id=?')
		.pluck()
		.get(uploaded.uploadId);
	const bytes = new Uint8Array([1]);
	const other = store.uploads.begin(game.id, { purpose: 'edit', mime: 'image/png', size: 1 });
	await store.uploads.chunk(game.id, other.uploadId, 0, {
		sha256: sha256(bytes),
		read: async () => bytes
	});
	await store.uploads.finish(game.id, other.uploadId);
	await store.uploads.finish(game.id, uploaded.uploadId);
	expect(store.uploads.status(game.id, uploaded.uploadId).expiresAt).toBe(fixed);
	store.connection
		.prepare('UPDATE media_uploads SET expires_at=? WHERE id=?')
		.run('2000-01-01T00:00:00.000Z', uploaded.uploadId);
	store.mediaLifetime.expire();
	expect(documentState(store, uploaded.uploadId)).toBe('cancelled');
	while (store.mediaLifetime.step()) {
		/* bounded cleanup */
	}
	expect(
		store.connection.prepare('SELECT id FROM media_objects WHERE id=?').get(objectId)
	).toBeUndefined();
});
