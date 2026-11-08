import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEditorDraft } from '#lib/games/editor.js';
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
