import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Game } from './model.js';

import { loadAuthoringDraft, saveAuthoringDraft } from './editor-draft-storage.js';
import { createEditorDraft } from './editor.js';
const platform = vi.hoisted(() => ({ desktop: true }));
const uploadDocumentBody = vi.hoisted(() => vi.fn());
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return platform.desktop;
	}
}));
vi.mock('#lib/storage/media-transfer.js', () => ({ uploadDocumentBody }));
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
afterEach(() => {
	platform.desktop = true;
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
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

it.each([false, true])(
	'splits an oversized unfinished draft into a document upload and preserves it (desktop=%s)',
	async (desktop) => {
		platform.desktop = desktop;
		uploadDocumentBody.mockResolvedValue('helia-upload:doc');
		const host = vi.fn().mockResolvedValue({ version: 1, draft: null });
		const fetch = vi.fn().mockResolvedValue(Response.json({ version: 1, draft: null }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		const draft = createEditorDraft(game);
		draft.documents.state = '한'.repeat(4 * 1024 * 1024);
		draft.documents.info = '한'.repeat(4 * 1024 * 1024);
		expect(await saveAuthoringDraft(game.id, draft, 0)).toEqual({ version: 1, draft: null });
		expect(draft.documents.state.length).toBe(4 * 1024 * 1024);
		expect(uploadDocumentBody).toHaveBeenCalledWith(game.id, 'draftSave', expect.any(String));
		const stub = { kind: 'writeDraft', gameId: game.id, bodyRef: 'helia-upload:doc' };
		if (desktop) {
			expect(host).toHaveBeenCalledWith(stub);
			expect(fetch).not.toHaveBeenCalled();
		} else {
			expect(fetch).toHaveBeenCalledWith(
				'/api/games/' + game.id + '/draft',
				expect.objectContaining({ method: 'PUT', body: JSON.stringify(stub) })
			);
			expect(host).not.toHaveBeenCalled();
		}
	}
);
it.each([false, true])(
	'keeps a small draft on the inline path without a document upload (desktop=%s)',
	async (desktop) => {
		platform.desktop = desktop;
		const host = vi.fn().mockResolvedValue({ version: 1, draft: null });
		const fetch = vi.fn().mockResolvedValue(Response.json({ version: 1, draft: null }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		const draft = createEditorDraft(game);
		draft.documents.state = '{unfinished';
		await saveAuthoringDraft(game.id, draft, 0);
		expect(uploadDocumentBody).not.toHaveBeenCalled();
		const sent = desktop ? host.mock.calls[0][0] : JSON.parse(fetch.mock.calls[0][1].body);
		expect(sent.draft.documents.state).toBe('{unfinished');
		expect(sent.bodyRef).toBeUndefined();
	}
);
it.each([false, true])(
	'uses the exact UTF-8 8 MiB draft boundary (desktop=%s)',
	async (desktop) => {
		platform.desktop = desktop;
		uploadDocumentBody.mockResolvedValue('helia-upload:doc');
		const host = vi.fn().mockResolvedValue({ version: 1, draft: null });
		const fetch = vi
			.fn()
			.mockImplementation(async () => Response.json({ version: 1, draft: null }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		for (const size of [8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
			const draft = createEditorDraft(game);
			draft.documents.state = '한\0';
			const body = () => JSON.stringify({ kind: 'writeDraft', gameId: game.id, version: 0, draft });
			draft.documents.state += 'x'.repeat(size - new TextEncoder().encode(body()).length);
			expect(new TextEncoder().encode(body()).length).toBe(size);
			uploadDocumentBody.mockClear();
			await saveAuthoringDraft(game.id, draft, 0);
			const sent = desktop ? host.mock.lastCall![0] : JSON.parse(fetch.mock.lastCall![1].body);
			if (size === 8 * 1024 * 1024) {
				expect(uploadDocumentBody).not.toHaveBeenCalled();
				expect(sent.draft).toEqual(draft);
			} else {
				expect(uploadDocumentBody).toHaveBeenCalledWith(game.id, 'draftSave', body());
				expect(sent).toEqual({ kind: 'writeDraft', gameId: game.id, bodyRef: 'helia-upload:doc' });
			}
		}
	}
);
