import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEditorDraft } from '#lib/games/editor.js';
import { SAVE_REQUEST_BYTES } from '#lib/games/package/limits.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { openStorage } from '#lib/server/sqlite.js';

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

it('rejects an oversized body before JSON parsing and keeps the saved revision', async () => {
	await PUT(event({ version: 0, draft: createEditorDraft(game) }));
	const request = event('x'.repeat(Number(SAVE_REQUEST_BYTES) + 1));
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
});

it('still checks exact UTF-8 bytes after the cheap text length guard', async () => {
	const request = { version: 0, draft: null, padding: '한'.repeat(8 * 1024 * 1024) };
	expect(JSON.stringify(request).length).toBeLessThan(Number(SAVE_REQUEST_BYTES));
	const response = await PUT(event(request));
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: '저장할 내용이 너무 커요' });
	expect((await (await GET(event(null))).json()).version).toBe(0);
});
