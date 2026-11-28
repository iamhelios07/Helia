import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEditorDraft } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { DOCUMENT_OPERATION_LIMITS } from '#lib/games/versioning-validation.js';
import { openStorage } from '#lib/server/sqlite.js';
import { MEDIA_CHUNK_SIZE } from '#lib/storage/media-protocol.js';

import { GET, PUT } from './+server.js';
const state = vi.hoisted(() => ({ storage: null as ReturnType<typeof openStorage> | null }));
vi.mock('#lib/server/sqlite.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/sqlite.js')>();
	return { ...actual, serverStorage: () => state.storage! };
});
let game: Awaited<ReturnType<ReturnType<typeof createGameRepository>['createGame']>>;
beforeEach(async () => {
	state.storage = openStorage(':memory:');
	game = await createGameRepository(async (request) =>
		state.storage!.request(request)
	).createGame();
});
afterEach(() => state.storage?.close());
const event = (body: unknown, origin = 'http://localhost') =>
	({
		params: { id: game.id },
		url: new URL('http://localhost/api/games/' + game.id + '/draft'),
		request: new Request('http://localhost/api/games/' + game.id + '/draft', {
			method: 'PUT',
			headers: { origin, 'content-type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	}) as Parameters<typeof PUT>[0];

it('returns the lock code for draft saves and clears without writing', async () => {
	state
		.storage!.connection.prepare(
			"UPDATE games SET value=json_set(value,'$.editLock',json('true')) WHERE id=?"
		)
		.run(game.id);
	for (const draft of [createEditorDraft(game), null]) {
		const response = await PUT(event({ version: 0, draft }));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: 'GAME_EDIT_LOCKED',
			errorCode: 'GAME_EDIT_LOCKED'
		});
	}
	const response = await GET(event(null));
	expect(await response.json()).toEqual({ version: 0, draft: null });
});
it('stores unfinished authoring JSON on the server with revisions and uncached reads', async () => {
	const draft = createEditorDraft(game);
	draft.documents.state = '{unfinished';
	const response = await PUT(event({ version: 0, draft }));
	expect(response.status).toBe(200);
	expect((await response.json()).version).toBe(1);
	const read = await GET(event(null));
	expect(read.headers.get('cache-control')).toBe('no-store');
	expect((await read.json()).draft.documents.state).toBe('{unfinished');
	expect((await PUT(event({ version: 0, draft: null }))).status).toBe(409);
	const current = await GET(event(null));
	expect((await current.json()).draft.documents.state).toBe('{unfinished');
});
it('rejects malformed, foreign-owner and cross-origin draft mutations without losing saved content', async () => {
	const draft = createEditorDraft(game);
	await PUT(event({ version: 0, draft }));
	expect((await PUT(event({ version: 1, draft: null }, 'https://foreign.example'))).status).toBe(
		403
	);
	expect((await PUT(event('{broken'))).status).toBe(400);
	expect((await PUT(event({ version: 1, draft: { ...draft, gameId: 'other' } }))).status).toBe(400);
	const current = await GET(event(null));
	expect((await current.json()).version).toBe(1);
});

it('rejects a body above the draftSave budget before JSON parsing and keeps the saved revision', async () => {
	await PUT(event({ version: 0, draft: createEditorDraft(game) }));
	const oversized = 'x'.repeat(Number(DOCUMENT_OPERATION_LIMITS.draftSave) + 1);
	const request = {
		params: { id: game.id },
		url: new URL('http://localhost/api/games/' + game.id + '/draft'),
		request: {
			headers: new Headers({ origin: 'http://localhost', 'content-type': 'application/json' }),
			text: async () => oversized
		}
	} as unknown as Parameters<typeof PUT>[0];
	const parse = vi.spyOn(JSON, 'parse');
	let response: Response;
	try {
		response = await PUT(request);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: '저장할 내용이 너무 커요' });
	expect((await (await GET(event(null))).json()).version).toBe(1);
}, 60000);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function uploadDocument(gameId: string, operation: string, text: string) {
	const bytes = new TextEncoder().encode(text);
	const { uploadId } = state.storage!.uploads.begin(gameId, {
		purpose: 'document',
		operation,
		mime: 'application/json',
		size: bytes.length
	});
	for (let i = 0; i < bytes.length; i += MEDIA_CHUNK_SIZE) {
		const part = bytes.subarray(i, i + MEDIA_CHUNK_SIZE);
		await state.storage!.uploads.chunk(gameId, uploadId, i / MEDIA_CHUNK_SIZE, {
			sha256: sha256(part),
			read: async () => part
		});
	}
	await state.storage!.uploads.finish(gameId, uploadId);
	return { ref: `helia-upload:${uploadId}`, uploadId };
}
it('saves a draft from a document upload and consumes the session', async () => {
	const draft = createEditorDraft(game);
	draft.documents.assets = '{unfinished';
	const body = JSON.stringify({ kind: 'writeDraft', gameId: game.id, version: 0, draft });
	const { ref, uploadId } = await uploadDocument(game.id, 'draftSave', body);
	const objectId = state
		.storage!.connection.prepare('SELECT object_id FROM media_uploads WHERE id=?')
		.pluck()
		.get(uploadId) as string;
	const response = await PUT(event({ bodyRef: ref }));
	expect(response.status).toBe(200);
	expect((await response.json()).version).toBe(1);
	const read = await GET(event(null));
	expect((await read.json()).draft.documents.assets).toBe('{unfinished');
	const session = state
		.storage!.connection.prepare('SELECT state,object_id FROM media_uploads WHERE id=?')
		.get(uploadId) as { state: string; object_id: string | null };
	expect(session.state).toBe('consumed');
	expect(session.object_id).toBeNull();
	expect(
		state
			.storage!.connection.prepare('SELECT state FROM media_objects WHERE id=?')
			.pluck()
			.get(objectId)
	).toBe('deleting');
});
it('rejects a document upload whose operation or game differs from the draft request', async () => {
	const draft = createEditorDraft(game);
	const body = JSON.stringify({ kind: 'writeDraft', gameId: game.id, version: 0, draft });
	const wrongOperation = await uploadDocument(game.id, 'commit', body);
	const response = await PUT(event({ bodyRef: wrongOperation.ref }));
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ errorCode: 'scopeMismatch' });
	state.storage!.connection.exec("INSERT OR IGNORE INTO games(id,value) VALUES('other','{}')");
	const wrongGame = await uploadDocument('other', 'draftSave', body);
	const foreign = await PUT(event({ bodyRef: wrongGame.ref }));
	expect(foreign.status).toBe(400);
	expect(await foreign.json()).toMatchObject({ errorCode: 'scopeMismatch' });
	expect((await (await GET(event(null))).json()).version).toBe(0);
});
