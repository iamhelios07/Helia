import { describe, it, expect, vi } from 'vitest';

import { createGameRepository } from '#lib/games/repository-core.js';
import { evaluateAction } from '#lib/games/scripting/engine.js';
import { openStorage } from '#lib/server/sqlite.js';
import { parseReply, type StorageRequest, type StorageTransport } from '#lib/storage/protocol.js';

import type { ModelGenerator, AgentEvent } from './protocol.js';

import { hostAILeases, SessionLeases } from './leases.js';
import { runAgentWorkspace } from './loop.js';

const args = "{type:'object',properties:{},additionalProperties:false}";
const scripts = `
helia.defineAction({name:'spend',ai:true,description:'Spend one gold',arguments:${args},run({state}){state.gold--;helia.emit('spent',{gold:state.gold});return state;}});
helia.defineAction({name:'hidden',arguments:${args},run({state}){return state;}});
helia.defineQuery({name:'balance',ai:true,description:'Read gold',arguments:${args},run({state}){return {gold:state.gold};}});
helia.defineFilter({name:'nonnegative',run({after}){return {allow:after.gold>=0,reason:'Insufficient gold'};}});
`;
const connection = {
	provider: { id: 'test', kind: 'openai-compatible' as const, baseUrl: 'https://example.com/v1' },
	model: 'test'
};
async function setup(source = scripts) {
	const storage = openStorage(':memory:');
	const writes: StorageRequest[] = [];
	const transport: StorageTransport = async (command) => {
		if (command.kind === 'commit') {
			writes.push(command);
		}
		return parseReply(storage.request(command));
	};
	const repo = createGameRepository(transport, { runAction: evaluateAction });
	const game = await repo.createGame();
	await repo.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			required: ['gold'],
			additionalProperties: false
		},
		initialState: { gold: 2 },
		scripts: { main: { language: 'typescript', source } }
	});
	const timeline = await repo.getSessionTimeline(game.id, game.activeSessionId);
	writes.length = 0;
	return { storage, repo, game, timeline, writes };
}
describe('atomic AI workspace', () => {
	it('triggers explicit script AI requests after a successful commit even without a custom UI', async () => {
		const storage = openStorage(':memory:'),
			requestAI = vi.fn();
		const repo = createGameRepository(async (command) => parseReply(storage.request(command)), {
			runAction: evaluateAction,
			requestAI
		});
		try {
			const game = await repo.createGame();
			await repo.updateGameRules(game.id, {
				schema: { type: 'object', properties: {}, additionalProperties: false },
				initialState: {},
				scripts: {
					main: {
						language: 'typescript',
						source: `helia.defineAction({name:'ask',arguments:${args},run({state}){helia.requestAI('Describe',{visible:true});return state;}});`
					}
				}
			});
			await repo.getSessionTimeline(game.id, game.activeSessionId);
			await repo.executeSessionAction(game.id, game.activeSessionId, {
				expectedRevision: 0,
				action: { name: 'ask', args: {} }
			});
			await Promise.resolve();
			expect(requestAI).toHaveBeenCalledWith(game.id, game.activeSessionId, {
				text: 'Describe',
				visible: true
			});
		} finally {
			storage.close();
		}
	});
});

describe('atomic AI workspace', () => {
	it('shares temporary writes with queries and commits input, answer, state and notifications only after final completion', async () => {
		const { storage, repo, game, timeline, writes } = await setup();
		const events: AgentEvent[] = [];
		const notifications = vi.fn();
		repo.subscribeSessionEvents(game.id, game.activeSessionId, notifications);
		let round = 0;
		const generate: ModelGenerator = async (request, _signal, emit) => {
			expect(request.tools.map((t) => t.name)).toEqual(['spend', 'balance']);
			expect((await repo.getSessionTimeline(game.id, game.activeSessionId)).messages).toEqual([]);
			expect(
				(await repo.getSessionHistory(game.id, game.activeSessionId)).progress.state.gold
			).toBe(2);
			expect(notifications).not.toHaveBeenCalled();
			if (round++ === 0) {
				return {
					text: 'Checking',
					calls: [
						{ id: 'one', name: 'spend', arguments: {} },
						{ id: 'two', name: 'balance', arguments: {} }
					]
				};
			}
			expect(JSON.parse(request.messages.find((m) => m.callId === 'two')!.content)).toEqual({
				gold: 1
			});
			expect(request.messages.at(-1)?.content).toContain('"gold":1');
			emit({ type: 'text', text: 'Done' });
			return { text: 'Done', calls: [] };
		};
		try {
			const result = await runAgentWorkspace(timeline, 'Buy', {
				connection: connection,
				generate: generate,
				run: evaluateAction,
				signal: new AbortController().signal,
				emit: (e) => events.push(e)
			});
			expect(writes).toHaveLength(0);
			await repo.commitSessionAgent(game.id, game.activeSessionId, {
				expectedRevision: 0,
				snapshotId: timeline.history.snapshot.id,
				input: 'Buy',
				visible: true,
				result
			});
			const after = await repo.getSessionTimeline(game.id, game.activeSessionId);
			expect(after.messages.map((m) => m.content)).toEqual(['Buy', 'Done']);
			expect(after.history.progress.state.gold).toBe(1);
			expect(writes).toHaveLength(1);
			expect(notifications).toHaveBeenCalledTimes(1);
			expect(events).toContainEqual({ type: 'reset' });
		} finally {
			storage.close();
		}
	});
});

describe('atomic AI workspace', () => {
	it.each(['cancel', 'stream', 'filter', 'unexposed'] as const)(
		'discards staged changes after %s failure',
		async (mode) => {
			const { storage, repo, game, timeline, writes } = await setup();
			const abort = new AbortController();
			let round = 0;
			const generate: ModelGenerator = async () => {
				if (round++ === 0) {
					return {
						text: '',
						calls: [
							{ id: 'one', name: mode === 'unexposed' ? 'hidden' : 'spend', arguments: {} },
							...(mode === 'filter'
								? [
										{ id: 'two', name: 'spend', arguments: {} },
										{ id: 'three', name: 'spend', arguments: {} }
									]
								: [])
						]
					};
				}
				if (mode === 'cancel') {
					abort.abort();
				}
				throw Error('Interrupted stream');
			};
			try {
				await expect(
					runAgentWorkspace(timeline, 'Buy', {
						connection: connection,
						generate: generate,
						run: evaluateAction,
						signal: abort.signal,
						emit: () => {}
					})
				).rejects.toThrow();
				expect(writes).toHaveLength(0);
				expect(
					(await repo.getSessionTimeline(game.id, game.activeSessionId)).history.progress.state.gold
				).toBe(2);
			} finally {
				storage.close();
			}
		}
	);
});

describe('atomic AI workspace', () => {
	it('rejects stale results and a canceled final commit without persisting either message', async () => {
		const { storage, repo, game, timeline } = await setup();
		try {
			const result = { state: { gold: 1 }, text: 'Done', events: [], hooks: [] };
			const abort = new AbortController();
			abort.abort();
			await expect(
				repo.commitSessionAgent(
					game.id,
					game.activeSessionId,
					{
						expectedRevision: 0,
						snapshotId: timeline.history.snapshot.id,
						input: 'Buy',
						visible: true,
						result
					},
					{ signal: abort.signal }
				)
			).rejects.toThrow();
			await repo.executeSessionAction(game.id, game.activeSessionId, {
				expectedRevision: 0,
				action: { name: 'spend', args: {} }
			});
			await expect(
				repo.commitSessionAgent(game.id, game.activeSessionId, {
					expectedRevision: 0,
					snapshotId: timeline.history.snapshot.id,
					input: 'Buy',
					visible: true,
					result
				})
			).rejects.toThrow();
			expect((await repo.getSessionTimeline(game.id, game.activeSessionId)).messages).toEqual([]);
		} finally {
			storage.close();
		}
	});
});

describe('atomic AI workspace', () => {
	it('rejects other host state writes during generation and rejects a released lease at commit', async () => {
		const { storage, repo, game, timeline } = await setup();
		const lease = hostAILeases.begin(game.id, game.activeSessionId);
		try {
			await expect(
				repo.appendUserMessage(game.id, game.activeSessionId, 'Blocked')
			).rejects.toThrow('생성 중');
			const result = { state: { gold: 1 }, text: 'Done', events: [], hooks: [] };
			hostAILeases.release(lease, game.id, game.activeSessionId);
			await expect(
				repo.commitSessionAgent(
					game.id,
					game.activeSessionId,
					{
						expectedRevision: 0,
						snapshotId: timeline.history.snapshot.id,
						input: 'Buy',
						visible: true,
						result
					},
					{ lease }
				)
			).rejects.toThrow('중단');
			expect((await repo.getSessionTimeline(game.id, game.activeSessionId)).messages).toEqual([]);
		} finally {
			hostAILeases.release(lease, game.id, game.activeSessionId);
			storage.close();
		}
	});
});
describe('Query capability boundary', () => {
	it.each([
		'state.gold=0;return 1;',
		"helia.emit('event',{});return 1;",
		"helia.requestAI('Hi');return 1;",
		'return Promise.resolve(1);'
	])('rejects side effects and non-JSON results: %s', async (body) => {
		const { storage, timeline } = await setup(
			`helia.defineQuery({name:'lookup',arguments:${args},run({state}){${body}}});`
		);
		try {
			await expect(
				evaluateAction({
					scripts: timeline.history.snapshot.scripts,
					schema: timeline.history.snapshot.schema,
					state: timeline.history.progress.state,
					action: { name: 'lookup', args: {} },
					operation: { kind: 'query', name: 'lookup', args: {} }
				})
			).rejects.toThrow();
		} finally {
			storage.close();
		}
	});
	it('returns scalar query results without transactions or events', async () => {
		const { storage, timeline } = await setup(
			`helia.defineQuery({name:'lookup',arguments:${args},run({state}){return state.gold;}});`
		);
		try {
			expect(
				await evaluateAction({
					scripts: timeline.history.snapshot.scripts,
					schema: timeline.history.snapshot.schema,
					state: timeline.history.progress.state,
					action: { name: 'lookup', args: {} },
					operation: { kind: 'query', name: 'lookup', args: {} }
				})
			).toEqual({ state: { gold: 2 }, value: 2 });
		} finally {
			storage.close();
		}
	});
	it('binds leases to one session and permits unrelated sessions', () => {
		const leases = new SessionLeases(),
			id = leases.begin('game', 'one');
		expect(() => leases.begin('game', 'one')).toThrow();
		expect(() => leases.require(id, 'game', 'two')).toThrow();
		expect(() =>
			leases.guard({
				kind: 'prune',
				gameId: 'game',
				sessionId: 'two',
				eventId: 'event',
				expectedRevision: 0
			})
		).not.toThrow();
		leases.release(id, 'game', 'one');
		expect(() => leases.require(id, 'game', 'one')).toThrow();
	});
});
