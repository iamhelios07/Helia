import { afterEach, expect, it, vi } from 'vitest';

import { openStorage } from '#lib/server/sqlite.js';
import { parseReply, type StorageRequest } from '#lib/storage/protocol.js';

import { runAgentWorkspace } from './ai/loop.js';
import { parseMessageInput } from './model.js';
import { createGameRepository } from './repository-core.js';
import { evaluateAction } from './scripting/engine.js';

const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const action = `helia.defineAction({name:'craft',ai:true,run({state}){
  state.gold--;
  helia.appendMessage({role:'user',content:'철검을 제작한다.'});
  helia.appendMessage({role:'assistant',content:'<b>철검 완성</b>'});
  return state;
}});`;
async function fixture(source = action) {
	const store = openStorage(':memory:');
	stores.push(store);
	const runTurn = vi.fn();
	const transport = vi.fn(async (input: StorageRequest) => parseReply(store.request(input)));
	const repo = createGameRepository(transport, { runAction: evaluateAction, runTurn });
	const game = await repo.createGame();
	const gameId = game.id,
		sessionId = game.activeSessionId;
	await repo.updateGameRules(gameId, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			required: ['gold'],
			additionalProperties: false
		},
		initialState: { gold: 10 },
		scripts: { main: { language: 'typescript', source } }
	});
	await repo.getSessionTimeline(gameId, sessionId);
	transport.mockClear();
	const read = () => repo.getSessionTimeline(gameId, sessionId);
	const run = () =>
		repo.executeSessionAction(gameId, sessionId, {
			expectedRevision: 0,
			action: { name: 'craft', args: {} }
		});
	return { repo, gameId, sessionId, store, runTurn, transport, read, run };
}

it('appends both roles without AI calls, retaining HTML and whitespace in the normal timeline', async () => {
	const f = await fixture();
	await f.repo.appendSessionMessage(f.gameId, f.sessionId, {
		expectedRevision: 0,
		message: { role: 'user', content: '  철검 주세요.\n' }
	});
	await f.repo.appendSessionMessage(f.gameId, f.sessionId, {
		expectedRevision: 1,
		message: { role: 'assistant', content: '<b>알겠습니다.</b>' }
	});
	const saved = await f.read();
	expect(saved.messages.map(({ role, content }) => ({ role, content }))).toEqual([
		{ role: 'user', content: '  철검 주세요.\n' },
		{ role: 'assistant', content: '<b>알겠습니다.</b>' }
	]);
	expect(saved.history.progress.state).toEqual({ gold: 10 });
	expect(saved.messages.map((message) => message.sequence)).toEqual([1, 2]);
	expect(f.runTurn).not.toHaveBeenCalled();
});

it('commits Action messages and state as one event, restores branches and deletes all linked messages', async () => {
	const f = await fixture();
	const result = await f.run();
	expect(f.transport.mock.calls.filter(([input]) => input.kind === 'commit')).toHaveLength(1);
	const saved = await f.read();
	expect(saved.history.transactions).toHaveLength(1);
	expect(saved.events[0].messages?.map((message) => message.role)).toEqual(['user', 'assistant']);
	expect(saved.history.transactions[0].messageIds).toEqual(
		saved.messages.map((message) => message.id)
	);
	expect(saved.history.progress.state.gold).toBe(9);
	await f.repo.selectSessionBranch(f.gameId, f.sessionId, null, 1);
	expect((await f.read()).messages).toEqual([]);
	await f.repo.selectSessionBranch(f.gameId, f.sessionId, result.progress.headId, 2);
	expect((await f.read()).messages).toEqual(saved.messages);
	const deleted = await f.repo.deleteSessionEvent(
		f.gameId,
		f.sessionId,
		result.progress.headId!,
		3
	);
	expect(deleted.messages).toEqual([]);
	expect(deleted.history.progress.state.gold).toBe(10);
	expect(deleted.session.messageCount).toBe(0);
	expect((await f.read()).history.transactions).toEqual([]);
});

it.each(['script', 'filter', 'sql', 'invalid', 'limit'] as const)(
	'discards state and every staged message after %s failure',
	async (failure) => {
		const suffix = failure === 'script' ? "throw Error('failed');" : '';
		const outputs: Record<string, string> = {
			invalid: "helia.appendMessage({role:'system',content:'invalid'});",
			limit: "for(let i=0;i<129;i++)helia.appendMessage({role:'user',content:'spam'});"
		};
		const emit =
			outputs[failure] ?? "helia.appendMessage({role:'assistant',content:'must roll back'});";
		const source =
			`helia.defineAction({name:'craft',run({state}){state.gold--;${emit}${suffix}return state;}});` +
			(failure === 'filter'
				? "helia.defineFilter({name:'deny',run(){return {allow:false};}});"
				: '');
		const f = await fixture(source);
		if (failure === 'sql') {
			f.store.connection.exec(
				"CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'forced'); END"
			);
		}
		await expect(f.run()).rejects.toThrow();
		const saved = await f.read();
		expect(saved.messages).toEqual([]);
		expect(saved.history.transactions).toEqual([]);
		expect(saved.history.progress.state.gold).toBe(10);
	}
);

it('validates standalone input and rejects stale, canceled and Filter-denied writes', async () => {
	const f = await fixture("helia.defineFilter({name:'deny',run(){return {allow:false};}});");
	const append = (expectedRevision: number, signal?: AbortSignal) =>
		f.repo.appendSessionMessage(
			f.gameId,
			f.sessionId,
			{ expectedRevision, message: { role: 'assistant', content: 'hello' } },
			{ signal }
		);
	for (const value of [
		{ role: 'system', content: 'bad' },
		{ role: 'user', content: '  ' },
		{ role: 'assistant', content: 123 }
	]) {
		expect(() => parseMessageInput(value)).toThrow();
	}
	await expect(append(1)).rejects.toThrow();
	await expect(append(0, AbortSignal.abort())).rejects.toThrow();
	await expect(append(0)).rejects.toMatchObject({ code: 'filter-rejected' });
	expect((await f.read()).messages).toEqual([]);
});

it('allows only one concurrent append against a revision and records no duplicate messages', async () => {
	const f = await fixture();
	const append = () =>
		f.repo.appendSessionMessage(f.gameId, f.sessionId, {
			expectedRevision: 0,
			message: { role: 'user', content: '주문' }
		});
	const outcomes = await Promise.allSettled([append(), append()]);
	expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
	expect((await f.read()).messages).toHaveLength(1);
});

it.each(['query', 'filter', 'registration'] as const)(
	'prohibits message writes in %s code',
	async (kind) => {
		const source = {
			query:
				"helia.defineQuery({name:'inspect',run(){helia.appendMessage({role:'user',content:'denied'});return {};}});",
			filter:
				"helia.defineAction({name:'inspect',run({state}){return state;}});helia.defineFilter({name:'guard',run(){helia.appendMessage({role:'user',content:'denied'});return {allow:true};}});",
			registration: "helia.appendMessage({role:'user',content:'denied'});"
		}[kind];
		await expect(
			evaluateAction({
				scripts: { main: { language: 'typescript', source } },
				schema: { type: 'object', properties: {}, additionalProperties: false },
				state: {},
				action: { name: 'inspect', args: {} },
				...(kind === 'query'
					? { operation: { kind: 'query', name: 'inspect', args: {} } as const }
					: {})
			})
		).rejects.toThrow();
	}
);

it('buffers Hook messages with included work and independently committed work', async () => {
	const f = await fixture(
		action +
			`
helia.defineHook({name:'included',actions:['craft'],run(){helia.appendMessage({role:'assistant',content:'included'});}});
helia.defineHook({name:'independent',mode:'independent',actions:['craft'],run(){helia.appendMessage({role:'assistant',content:'independent'});}});
`
	);
	await f.run();
	const saved = await f.read();
	expect(saved.messages.map((message) => message.content)).toEqual([
		'철검을 제작한다.',
		'<b>철검 완성</b>',
		'included',
		'independent'
	]);
	expect(saved.history.transactions).toHaveLength(2);
	expect(saved.events[0].messages).toHaveLength(3);
});

it('commits messages emitted by AI-invoked Actions only after the final answer succeeds', async () => {
	const f = await fixture();
	const timeline = await f.read();
	let round = 0;
	const result = await runAgentWorkspace(timeline, '만들어줘', {
		connection: {
			provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
			model: 'test'
		},
		run: evaluateAction,
		signal: new AbortController().signal,
		emit: () => {},
		generate: async (request) => {
			expect((await f.read()).messages).toEqual([]);
			if (round++ === 0) {
				return { text: '', calls: [{ id: 'craft-call', name: 'craft', arguments: {} }] };
			}
			expect(request.messages.find((message) => message.role === 'tool')?.content).toContain(
				'철검 완성'
			);
			return { text: '제작했습니다.', calls: [] };
		}
	});
	await f.repo.commitSessionAgent(f.gameId, f.sessionId, {
		expectedRevision: 0,
		snapshotId: timeline.history.snapshot.id,
		input: '만들어줘',
		visible: true,
		result
	});
	const saved = await f.read();
	expect(saved.messages.map((message) => message.content)).toEqual([
		'만들어줘',
		'철검을 제작한다.',
		'<b>철검 완성</b>',
		'제작했습니다.'
	]);
	expect(saved.history.transactions).toHaveLength(2);
	expect(saved.events[1].messages).toHaveLength(3);
	await runAgentWorkspace(saved, '다음 주문', {
		connection: {
			provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
			model: 'test'
		},
		run: evaluateAction,
		signal: new AbortController().signal,
		emit: () => {},
		generate: async (request) => {
			expect(request.messages).toContainEqual(
				expect.objectContaining({ role: 'assistant', content: '<b>철검 완성</b>' })
			);
			return { text: '다음 손님입니다.', calls: [] };
		}
	});
});

it.each(['잘 쓸게요!', ''])(
	'records an authored HTML receipt once with final reaction %j',
	async (reaction) => {
		const f = await fixture();
		const timeline = await f.read();
		let round = 0;
		const streamed: string[] = [];
		const result = await runAgentWorkspace(timeline, '만들어줘', {
			connection: {
				provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
				model: 'test'
			},
			run: evaluateAction,
			signal: new AbortController().signal,
			emit: (event) => {
				if (event.type === 'text') {
					streamed.push(event.text);
				}
			},
			generate: async (request, _signal, emit) => {
				if (round++ === 0) {
					return { text: '', calls: [{ id: 'craft-call', name: 'craft', arguments: {} }] };
				}
				const tool = JSON.parse(
					request.messages.find((message) => message.role === 'tool')!.content
				);
				const receipt = tool.messages.find(
					(message: { role: string }) => message.role === 'assistant'
				).content;
				const text = receipt + reaction;
				emit({ type: 'text', text });
				return { text, calls: [] };
			}
		});
		await f.repo.commitSessionAgent(f.gameId, f.sessionId, {
			expectedRevision: 0,
			snapshotId: timeline.history.snapshot.id,
			input: '만들어줘',
			visible: true,
			result
		});
		const saved = await f.read();
		expect(
			saved.messages.filter((message) => message.content.includes('<b>철검 완성</b>'))
		).toHaveLength(1);
		expect(saved.messages.at(-1)?.content).toBe(reaction || '<b>철검 완성</b>');
		expect(streamed.join('')).toBe(reaction);
		expect(saved.history.progress.state.gold).toBe(9);
	}
);
