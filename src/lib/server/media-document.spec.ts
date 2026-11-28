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
