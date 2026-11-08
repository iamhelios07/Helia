import { afterEach, expect, it } from 'vitest';

import { createEditorDraft } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});
it('durably stores invalid source separately and rejects stale draft writers and tombstone deletes', async () => {
	const storage = openStorage(':memory:');
	stores.push(storage);
	const repo = createGameRepository(async (request) => storage.request(request));
	const game = await repo.createGame();
	const drafts = editorDraftStorage(storage.connection);
	const draft = createEditorDraft(game);
	draft.documents.state = '{unfinished';
	expect(drafts.read(game.id)).toEqual({ version: 0, draft: null });
	expect(drafts.write(game.id, draft, 0)).toEqual({ version: 1, draft });
	expect(editorDraftStorage(storage.connection).read(game.id)).toEqual({ version: 1, draft });
	expect((await repo.getGameWorkspace(game.id))?.game).toEqual(game);
	expect(() => drafts.write(game.id, null, 0)).toThrow('EDITOR_DRAFT_CONFLICT');
	expect(drafts.read(game.id).draft?.documents.state).toBe('{unfinished');
	expect(() => drafts.write('missing', draft, 0)).toThrow();
	expect(drafts.write(game.id, null, 1)).toEqual({ version: 2, draft: null });
	expect(() => drafts.write(game.id, draft, 1)).toThrow('EDITOR_DRAFT_CONFLICT');
});
it('rejects a foreign game draft without replacing the saved draft', async () => {
	const storage = openStorage(':memory:');
	stores.push(storage);
	const repo = createGameRepository(async (request) => storage.request(request));
	const game = await repo.createGame();
	const other = await repo.createGame();
	const drafts = editorDraftStorage(storage.connection);
	const draft = createEditorDraft(game);
	drafts.write(game.id, draft, 0);
	expect(() => drafts.write(game.id, createEditorDraft(other), 1)).toThrow();
	expect(drafts.read(game.id)).toEqual({ version: 1, draft });
});
