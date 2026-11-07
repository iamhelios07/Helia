import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadAuthoringDraft, saveAuthoringDraft } from './editor-draft-storage.js';
import { createEditorDraft } from './editor.js';
import type { Game } from './model.js';
vi.mock('#lib/platform/index.js', () => ({ isDesktopBuild: true }));
const game: Game = {
	schemaVersion: 2,
	id: 'game',
	activeSessionId: 'session',
	title: 'Game',
	genre: '',
	description: '',
	settings: { description: '', firstMessage: '', authorNote: '' },
	scripts: {},
	schema: { type: 'object', properties: {}, additionalProperties: false },
	initialState: {},
	createdAt: '2000-01-01T00:00:00.000Z',
	updatedAt: '2000-01-01T00:00:00.000Z'
};
beforeEach(() =>
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: () => {
			throw Error('Quota');
		},
		removeItem: () => {}
	})
);
afterEach(() => vi.unstubAllGlobals());
it('stores desktop drafts through the main-frame host even when browser storage is full', async () => {
	const draft = createEditorDraft(game);
	draft.documents.state = '{unfinished';
	const host = vi.fn(async (request: { kind: string; version?: number; draft?: unknown }) =>
		request.kind === 'readDraft'
			? { version: 0, draft: null }
			: { version: 1, draft: request.draft }
	);
	const view: Record<string, unknown> = { __HELIA_STORAGE__: host };
	view.top = view;
	vi.stubGlobal('window', view);
	expect(await loadAuthoringDraft(game.id)).toEqual({ version: 0, draft: null });
	expect(await saveAuthoringDraft(game.id, draft, 0)).toEqual({ version: 1, draft });
	expect(host.mock.calls[1][0]).toEqual({ kind: 'writeDraft', gameId: game.id, version: 0, draft });
});
it('rejects a subframe and an unavailable native bridge', async () => {
	vi.stubGlobal('window', { top: {} });
	await expect(loadAuthoringDraft(game.id)).rejects.toThrow('Helia 앱');
	const host = vi.fn();
	vi.stubGlobal('window', { top: {}, __HELIA_STORAGE__: host });
	await expect(loadAuthoringDraft(game.id)).rejects.toThrow('Helia 앱');
	expect(host).not.toHaveBeenCalled();
});
