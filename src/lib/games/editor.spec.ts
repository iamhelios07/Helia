import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import {
	createEditorDraft,
	changedEditorDraft,
	clearEditorDraft,
	editorContent,
	loadEditorDraft,
	readEditorDraft,
	storeEditorDraft,
	validateEditorDraft
} from './editor.js';
import { createGameRepository } from './repository-core.js';

const repository = () => createGameRepository(memoryStorage());
let stored: Map<string, string>;
beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key)
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('IDE authoring drafts', () => {
	it('keeps even invalid source separate from applied game and other games', async () => {
		const repo = repository();
		const game = await repo.createGame();
		const other = await repo.createGame();
		const draft = createEditorDraft(game);
		expect(changedEditorDraft(draft)).toBe(false);
		draft.documents.state = '{unfinished';
		storeEditorDraft(draft);
		expect(loadEditorDraft(game.id)).toEqual(draft);
		expect(loadEditorDraft(other.id)).toBeNull();
		expect(changedEditorDraft(draft)).toBe(true);
		expect((await repo.getGameWorkspace(game.id))?.game).toEqual(game);
		expect(validateEditorDraft(game, draft)).toMatchObject({
			game: null,
			problems: [{ documentId: 'state' }]
		});
	});
});

describe('IDE authoring drafts', () => {
	it('reports document errors and validates initial state against the edited schema', async () => {
		const game = await repository().createGame();
		const draft = createEditorDraft(game);
		const schema = {
			type: 'object',
			properties: { hp: { type: 'integer' } },
			required: ['hp'],
			additionalProperties: false
		};
		draft.documents.state = JSON.stringify({ schema, initialState: { hp: 'wrong' } });
		expect(validateEditorDraft(game, draft).problems[0].documentId).toBe('state');
		draft.documents.state = JSON.stringify({ schema, initialState: { hp: 20 } });
		expect(validateEditorDraft(game, draft).game?.initialState).toEqual({ hp: 20 });
	});
});

describe('IDE authoring drafts', () => {
	it('does not erase a newer draft when an older apply completes', async () => {
		const game = await repository().createGame();
		const draft = createEditorDraft(game);
		const newer = structuredClone(draft);
		newer.documents.instructions = JSON.stringify({
			description: 'New',
			firstMessage: '',
			authorNote: ''
		});
		storeEditorDraft(newer);
		clearEditorDraft(game.id, draft);
		expect(loadEditorDraft(game.id)).toEqual(newer);
		clearEditorDraft(game.id, newer);
		expect(loadEditorDraft(game.id)).toBeNull();
	});
});

describe('IDE authoring drafts', () => {
	it('reports corrupt or unavailable storage without overwriting saved data', async () => {
		stored.set('helia:editor-draft:broken', '{broken');
		expect(() => loadEditorDraft('broken')).toThrow('불러오지 못했어요');
		expect(stored.get('helia:editor-draft:broken')).toBe('{broken');
		const draft = createEditorDraft(await repository().createGame());
		vi.stubGlobal('localStorage', {
			setItem() {
				throw new Error('Unavailable');
			}
		});
		expect(() => storeEditorDraft(draft)).toThrow('저장하지 못했어요');
	});
});

describe('IDE authoring drafts', () => {
	it('atomically applies authored content to existing sessions, retaining active session and history', async () => {
		const repo = repository();
		const game = await repo.createGame();
		const history = await repo.getSessionHistory(game.id, game.activeSessionId);
		const draft = createEditorDraft(game);
		draft.documents.info = JSON.stringify({
			title: 'Edited game',
			genre: 'Adventure',
			description: 'Library introduction'
		});
		draft.documents.instructions = JSON.stringify({
			description: 'Game instructions',
			firstMessage: 'Opening',
			authorNote: 'Note'
		});
		draft.documents.state = JSON.stringify({ schema: game.schema, initialState: {} });
		const validated = validateEditorDraft(game, draft);
		expect(validated.problems).toEqual([]);
		const other = await repo.createSession(game.id);
		const saved = await repo.applyGameDraft(game.id, {
			baseContent: draft.baseContent,
			content: editorContent(validated.game!)
		});
		expect(saved.title).toBe('Edited game');
		expect(saved.settings.firstMessage).toBe('Opening');
		expect(saved.activeSessionId).toBe(other.id);
		const refreshed = await repo.getSessionHistory(game.id, game.activeSessionId);
		expect(refreshed.snapshot.settings).toEqual(saved.settings);
		expect(refreshed.snapshot.migrationFrom).toBe(history.snapshot.id);
		expect(refreshed.transactions).toEqual(history.transactions);
	});
});

describe('IDE authoring drafts', () => {
	it('uses one canonical state document and migrates separate legacy sources without losing edits', async () => {
		const game = await repository().createGame();
		const draft = createEditorDraft(game);
		expect(JSON.parse(draft.documents.state)).toEqual({
			schema: game.schema,
			initialState: game.initialState
		});
		expect(draft.documents).not.toHaveProperty('schema');
		const legacy = {
			...draft,
			version: 1,
			documents: {
				...draft.documents,
				schema: JSON.stringify(game.schema),
				scripts: JSON.stringify(game.scripts),
				ui: JSON.stringify(game.ui ?? null),
				state: JSON.stringify(game.initialState)
			}
		};
		const migrated = readEditorDraft(JSON.stringify(legacy), game.id);
		expect(migrated).toEqual(draft);
		expect(changedEditorDraft(migrated)).toBe(false);
		legacy.documents.schema = JSON.stringify({
			type: 'object',
			properties: { hp: { type: 'integer' } },
			required: ['hp'],
			additionalProperties: false
		});
		legacy.documents.state = '{"hp":42}';
		const edited = readEditorDraft(JSON.stringify(legacy), game.id);
		expect(changedEditorDraft(edited)).toBe(true);
		expect(validateEditorDraft(game, edited).game?.initialState).toEqual({ hp: 42 });
		legacy.documents.schema = '{unfinished-schema';
		legacy.documents.state = '{unfinished-state';
		const unfinished = readEditorDraft(JSON.stringify(legacy), game.id);
		expect(unfinished.documents.state).toContain(legacy.documents.schema);
		expect(unfinished.documents.state).toContain(legacy.documents.state);
		storeEditorDraft(unfinished);
		expect(loadEditorDraft(game.id)).toEqual(unfinished);
		expect(validateEditorDraft(game, unfinished).game).toBeNull();
	});
});

describe('IDE authoring drafts', () => {
	it('rejects stale content and invalid new content without partial updates', async () => {
		const repo = repository();
		const game = await repo.createGame();
		const base = editorContent(game);
		await expect(
			repo.applyGameDraft(game.id, {
				baseContent: base,
				content: { ...base, title: 'Must not persist', initialState: { unknown: 1 } }
			})
		).rejects.toThrow();
		expect((await repo.getGameWorkspace(game.id))?.game.title).toBe(game.title);
		await repo.updateGameSettings(game.id, { title: 'Other edit', ...game.settings });
		await expect(
			repo.applyGameDraft(game.id, { baseContent: base, content: { ...base, title: 'Stale' } })
		).rejects.toThrow('다른 화면');
		expect((await repo.getGameWorkspace(game.id))?.game.title).toBe('Other edit');
	});
});

describe('IDE authoring drafts', () => {
	it('detects newly added optional content and supports explicit UI removal', async () => {
		const repo = repository();
		const game = await repo.createGame();
		const ui = {
			version: 1 as const,
			entry: 'main.tsx',
			modules: { 'main.tsx': { language: 'tsx' as const, source: '' } }
		};
		await repo.updateGameRules(game.id, {
			schema: game.schema,
			initialState: game.initialState,
			scripts: {},
			ui
		});
		await expect(
			repo.applyGameDraft(game.id, {
				baseContent: editorContent(game),
				content: editorContent(game)
			})
		).rejects.toThrow('다른 화면');
		const current = (await repo.getGameWorkspace(game.id))!.game;
		const content = editorContent(current);
		delete content.ui;
		const result = await repo.applyGameDraft(game.id, {
			baseContent: editorContent(current),
			content
		});
		expect(result.ui).toBeUndefined();
	});
});

it('keeps the applied baseline independent from later draft edits', async () => {
	const game = await repository().createGame();
	const first = createEditorDraft(game);
	const second = createEditorDraft(game);
	// Editing one draft snapshot must not rewrite another draft's baseline documents.
	first.documents.state = '{unfinished';
	expect(second.documents.state).toBe(createEditorDraft(game).documents.state);
	expect(changedEditorDraft(second)).toBe(false);
});
