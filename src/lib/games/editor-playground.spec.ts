import { beforeEach, expect, it, vi } from 'vitest';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import type { RoundRequest } from './ai/protocol.js';

import { hostAILeases } from './ai/leases.js';
import {
	createEditorPlaythrough,
	playgroundFingerprint,
	type EditorDiagnostic
} from './editor-playground.js';
import { createGameRepository } from './repository-core.js';
import { evaluateAction } from './scripting/engine.js';

const generation = vi.hoisted(() => ({
	scopes: [] as { gameId: string; sessionId: string }[],
	requests: [] as RoundRequest[],
	fail: false
}));
vi.mock('#lib/app/settings/repository.js', () => ({
	loadAISettings: () => ({
		version: 1,
		providers: [
			{ id: 'provider', name: 'Test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' }
		],
		models: [{ id: 'model', name: 'Model', providerId: 'provider', modelId: 'test-model' }],
		defaultModelId: 'model'
	})
}));
vi.mock('#lib/app/settings/prompt-repository.js', async () => ({
	loadSelectedPromptConfig: () => undefined
}));
vi.mock('./ai/transport.js', () => ({
	beginGeneration: async (gameId: string, sessionId: string) => {
		generation.scopes.push({ gameId, sessionId });
		const lease = hostAILeases.begin(gameId, sessionId);
		let round = 0;
		return {
			lease,
			release: async () => hostAILeases.release(lease, gameId, sessionId),
			generate: async (request: RoundRequest) => {
				hostAILeases.round(lease, gameId, sessionId);
				generation.requests.push(request);
				if (generation.fail) {
					throw Error('Provider unavailable');
				}
				if (++round === 1) {
					return { text: '', calls: [{ id: 'call', name: 'increment', arguments: {} }] };
				}
				return { text: 'Test reply', calls: [] };
			}
		};
	}
}));

beforeEach(() => {
	generation.scopes = [];
	generation.requests = [];
	generation.fail = false;
});
async function fixture() {
	const repository = createGameRepository(memoryStorage());
	let game = await repository.createGame({ title: 'Live game', genre: '', description: '' });
	game = await repository.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { value: { type: 'integer' } },
			required: ['value'],
			additionalProperties: false
		},
		initialState: { value: 0 },
		scripts: {
			main: {
				language: 'javascript',
				source: `
helia.defineAction({name:'increment',ai:true,arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.value++;helia.emit('count',{value:state.value});return state;}});
helia.defineFilter({name:'limit',run({after}){return {allow:after.value<3,reason:'Maximum reached'};}});
`
			}
		}
	});
	return { game, repository };
}

it('isolates preview and test transactions, histories, and IDs from normal play', async () => {
	const { game, repository } = await fixture();
	const diagnostics: EditorDiagnostic[] = [];
	const test = await createEditorPlaythrough(game, {
		runAction: evaluateAction,
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	const preview = await createEditorPlaythrough(game, { runAction: evaluateAction });
	try {
		expect(test.game.id).not.toBe(game.id);
		expect(test.game.activeSessionId).not.toBe(game.activeSessionId);
		expect(preview.game.id).not.toBe(test.game.id);
		expect((await test.catalog()).map((tool) => tool.name)).toContain('increment');
		await test.action('increment', {});
		expect(test.timeline.history.progress.state).toEqual({ value: 1 });
		expect(test.timeline.events).toHaveLength(1);
		expect(preview.timeline.history.progress.state).toEqual({ value: 0 });
		expect(
			(await repository.getSessionHistory(game.id, game.activeSessionId)).progress.state
		).toEqual({ value: 0 });
		expect((await repository.getGameWorkspace(game.id))?.sessions).toHaveLength(1);
		expect(diagnostics.some((entry) => entry.message.startsWith('트랜잭션'))).toBe(true);
		expect(diagnostics.some((entry) => entry.message === 'UI 이벤트')).toBe(true);
	} finally {
		test.dispose();
		preview.dispose();
	}
});

it('retains an independent test snapshot until explicit recreation and reports rejected Filters', async () => {
	const { game } = await fixture();
	const diagnostics: EditorDiagnostic[] = [];
	const test = await createEditorPlaythrough(game, {
		runAction: evaluateAction,
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	try {
		await test.action('increment', {});
		const edited = { ...game, initialState: { value: 10 } };
		expect(test.fingerprint).not.toBe(playgroundFingerprint(edited));
		expect(test.timeline.history.progress.state).toEqual({ value: 1 });
		const restarted = await createEditorPlaythrough(edited, { runAction: evaluateAction });
		try {
			expect(restarted.timeline.history.progress.state).toEqual({ value: 10 });
		} finally {
			restarted.dispose();
		}
		await expect(test.transaction({ value: 3 })).rejects.toMatchObject({
			code: 'filter-rejected',
			ruleId: 'limit'
		});
		expect(test.timeline.history.progress.state).toEqual({ value: 1 });
		expect(test.timeline.events).toHaveLength(1);
		expect(
			diagnostics
				.filter((entry) => entry.failed)
				.map((entry) => entry.detail)
				.join()
		).toContain('Maximum reached');
	} finally {
		test.dispose();
	}
});

it('runs the existing BYOK agent loop and tool calls entirely within the isolated repository', async () => {
	const { game, repository } = await fixture();
	const test = await createEditorPlaythrough(game, { runAction: evaluateAction });
	try {
		await test.ai('Increment for the test');
		expect(generation.scopes).toEqual([
			{ gameId: test.game.id, sessionId: test.game.activeSessionId }
		]);
		expect(generation.requests).toHaveLength(2);
		expect(test.timeline.history.progress.state).toEqual({ value: 1 });
		expect(test.timeline.messages.map((message) => message.content)).toEqual([
			'Increment for the test',
			'Test reply'
		]);
		expect(
			(await repository.getSessionTimeline(game.id, game.activeSessionId)).messages
		).toHaveLength(0);
		expect(
			(await repository.getSessionHistory(game.id, game.activeSessionId)).progress.state
		).toEqual({ value: 0 });
		const nextLease = hostAILeases.begin(test.game.id, test.game.activeSessionId);
		expect(nextLease).toEqual(expect.any(String));
		hostAILeases.release(nextLease, test.game.id, test.game.activeSessionId);
	} finally {
		test.dispose();
	}
});

it('keeps failed AI requests out of committed test state and emits a diagnostic', async () => {
	const { game } = await fixture();
	const diagnostics: EditorDiagnostic[] = [];
	const test = await createEditorPlaythrough(game, {
		runAction: evaluateAction,
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	generation.fail = true;
	try {
		await expect(test.ai('Fail')).rejects.toThrow();
		expect(test.timeline.events).toHaveLength(0);
		expect(test.timeline.messages).toHaveLength(0);
		expect(diagnostics.some((entry) => entry.failed && entry.message === 'AI 실행 실패')).toBe(
			true
		);
	} finally {
		test.dispose();
	}
});

it('diagnoses independent Hook failures without hiding the already committed Action', async () => {
	const { game } = await fixture();
	game.scripts.main.source += `helia.defineHook({name:'broken',mode:'independent',actions:['increment'],run(){throw Error('Broken independent hook');}});`;
	const diagnostics: EditorDiagnostic[] = [];
	const test = await createEditorPlaythrough(game, {
		runAction: evaluateAction,
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	try {
		await test.action('increment', {});
		expect(test.timeline.history.progress.state).toEqual({ value: 1 });
		expect(test.timeline.events).toHaveLength(1);
		expect(
			diagnostics.some(
				(entry) =>
					entry.failed && entry.message === 'hook · broken 실패' && entry.detail?.includes('broken')
			)
		).toBe(true);
	} finally {
		test.dispose();
	}
});
