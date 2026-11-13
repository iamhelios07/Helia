import { it, expect, vi, afterEach, beforeEach } from 'vitest';

import { savePromptSettings } from '#lib/app/settings/prompt-repository.js';
import {
	emptyPromptSettings,
	upsertPromptPreset,
	selectPromptPreset
} from '#lib/app/settings/prompts.js';
import { createGame, updateGameRules, getSessionTimeline } from '#lib/games/repository.js';

import type { RoundRequest } from './protocol.js';

import { isSessionBusy } from './activity.js';
import { invokeSessionAI } from './browser.js';
import { parsePromptConfig } from './prompts.js';

const faults = vi.hoisted(() => ({
	failRefresh: false,
	committed: false,
	cancel: undefined as AbortController | undefined,
	requests: [] as RoundRequest[],
	onGenerate: undefined as (() => void) | undefined
}));
vi.mock('#lib/app/settings/repository.js', () => ({
	loadAISettings: () => ({
		version: 1,
		providers: [
			{
				id: 'connection',
				name: 'Test',
				kind: 'openai-compatible',
				baseUrl: 'https://example.com/v1'
			}
		],
		models: [{ id: 'model', name: 'Test', providerId: 'connection', modelId: 'test' }],
		defaultModelId: 'model'
	})
}));
vi.mock('#lib/storage/transport.js', async () => {
	const { openStorage } = await import('#lib/server/sqlite.js');
	const { parseReply } = await import('#lib/storage/protocol.js');
	const storage = openStorage(':memory:');
	return {
		storageRequest: async (input: import('#lib/storage/protocol.js').StorageRequest) => {
			if (faults.failRefresh && faults.committed && input.kind === 'read') {
				throw Error('Read unavailable after commit');
			}
			const reply = parseReply(storage.request(input));
			if (
				input.kind === 'commit' &&
				input.records.some(
					(r) => r.table === 'messages' && (r.value as { role?: string }).role === 'assistant'
				)
			) {
				faults.committed = true;
			}
			return reply;
		}
	};
});
vi.mock('#lib/games/scripting/browser.js', async () => ({
	runCreatorAction: (await import('#lib/games/scripting/engine.js')).evaluateAction
}));
vi.mock('./transport.js', async () => {
	const { hostAILeases } = await import('./leases.js');
	return {
		beginGeneration: async (gameId: string, sessionId: string) => {
			const lease = hostAILeases.begin(gameId, sessionId);
			return {
				lease,
				release: async () => hostAILeases.release(lease, gameId, sessionId),
				generate: async (
					request: RoundRequest,
					_signal: AbortSignal,
					emit: (event: { type: 'text'; text: string }) => void
				) => {
					faults.requests.push(request);
					faults.onGenerate?.();
					emit({ type: 'text', text: 'Answer' });
					faults.cancel?.abort();
					return { text: 'Answer', calls: [] };
				}
			};
		}
	};
});
beforeEach(() => {
	const stored = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => {
	faults.failRefresh = false;
	faults.committed = false;
	faults.cancel = undefined;
	faults.requests = [];
	faults.onGenerate = undefined;
	vi.unstubAllGlobals();
});
it('uses the selected global preset on an existing session and picks up changes only on the next request', async () => {
	const game = await createGame();
	await updateGameRules(game.id, {
		schema: { type: 'object', properties: {}, additionalProperties: false },
		initialState: {},
		scripts: {},
		ai: {
			version: 1,
			lorebook: [{ name: 'Game lore', keys: [], content: 'Game lore', always: true }]
		}
	});
	await getSessionTimeline(game.id, game.activeSessionId);
	const settings = selectPromptPreset(
		upsertPromptPreset(emptyPromptSettings(), {
			id: 'player',
			name: 'Player',
			config: parsePromptConfig({
				version: 2,
				promptTemplate: [
					{ type: 'plain', type2: 'main', text: 'First preset' },
					{ type: 'lorebook' },
					{ type: 'chat' }
				],
				maxTokens: 300
			})
		}),
		'player'
	);
	savePromptSettings(settings);
	faults.onGenerate = () =>
		savePromptSettings(
			upsertPromptPreset(settings, {
				id: 'player',
				name: 'Player',
				config: parsePromptConfig({
					version: 2,
					promptTemplate: [
						{ type: 'plain', type2: 'main', text: 'Next preset' },
						{ type: 'lorebook' },
						{ type: 'chat' }
					],
					maxTokens: 600
				})
			})
		);
	await invokeSessionAI(game.id, game.activeSessionId, { text: 'Input' });
	expect(faults.requests[0].messages.map((m) => m.content)).toContain('First preset');
	expect(faults.requests[0].messages.map((m) => m.content)).toContain('Game lore');
	expect(faults.requests[0].maxTokens).toBe(300);
	faults.onGenerate = undefined;
	await invokeSessionAI(game.id, game.activeSessionId, { text: 'More' });
	expect(faults.requests[1].messages.map((m) => m.content)).toContain('Next preset');
	expect(faults.requests[1].maxTokens).toBe(600);
	const timeline = await getSessionTimeline(game.id, game.activeSessionId);
	expect(timeline.history.snapshot.ai).toEqual({
		version: 1,
		lorebook: [
			{
				id: 'lore-1',
				name: 'Game lore',
				order: 0,
				keys: [],
				content: 'Game lore',
				always: true,
				enabled: true,
				caseSensitive: false
			}
		]
	});
	expect(JSON.stringify(timeline)).not.toContain('First preset');
	expect(JSON.stringify(timeline)).not.toContain('Next preset');
});
it('returns committed progress even if the post-commit refresh fails', async () => {
	const game = await createGame();
	await updateGameRules(game.id, {
		schema: { type: 'object', properties: {}, additionalProperties: false },
		initialState: {},
		scripts: {}
	});
	await getSessionTimeline(game.id, game.activeSessionId);
	faults.failRefresh = true;
	const result = await invokeSessionAI(game.id, game.activeSessionId, {
		text: '  Input\n',
		modelId: 'model'
	});
	expect(result.messages.map((m) => m.content)).toEqual(['  Input\n', 'Answer']);
	expect(result.history.progress.revision).toBe(2);
	expect(isSessionBusy(game.id, game.activeSessionId)).toBe(false);
});
it('cancellation before commit leaves no message history and releases session activity', async () => {
	const game = await createGame();
	await getSessionTimeline(game.id, game.activeSessionId);
	const abort = new AbortController();
	faults.cancel = abort;
	await expect(
		invokeSessionAI(game.id, game.activeSessionId, { text: 'Input' }, { signal: abort.signal })
	).rejects.toThrow('중단');
	expect((await getSessionTimeline(game.id, game.activeSessionId)).messages).toEqual([]);
	expect(isSessionBusy(game.id, game.activeSessionId)).toBe(false);
});
