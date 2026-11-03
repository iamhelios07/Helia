import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '#lib/server/sqlite.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { parseReply, type StorageTransport } from '#lib/storage/protocol.js';
import { evaluateAction } from './engine.js';
import type { SessionUIEvent } from './events.js';

let storage: ReturnType<typeof openStorage>;
const transport: StorageTransport = async (input) => parseReply(storage.request(input));
beforeEach(() => {
	storage = openStorage(':memory:');
});
afterEach(() => storage.close());
const noArgs = `{type:'object',properties:{},additionalProperties:false}`;
const base = `
helia.defineAction({name:'start',arguments:${noArgs},run({state}){state.value++;helia.emit('root',{value:state.value});return state;}});
helia.defineAction({name:'bonus',arguments:${noArgs},run({state}){state.value+=10;helia.emit('bonus',{value:state.value});return state;}});
`;
async function fixture(extra: string) {
	const runner = vi.fn(evaluateAction),
		repository = createGameRepository(transport, { runAction: runner });
	const game = await repository.createGame(),
		gameId = game.id,
		sessionId = game.activeSessionId;
	await repository.updateGameRules(gameId, {
		schema: {
			type: 'object',
			properties: { value: { type: 'integer' } },
			required: ['value'],
			additionalProperties: false
		},
		initialState: { value: 0 },
		scripts: { main: { language: 'javascript', source: base + extra } }
	});
	await repository.getSessionHistory(gameId, sessionId);
	const read = () => transport({ kind: 'read', gameId, sessionId });
	const run = (revision = 0, signal?: AbortSignal) =>
		repository.executeSessionAction(
			gameId,
			sessionId,
			{ expectedRevision: revision, action: { name: 'start', args: {} } },
			{ signal }
		);
	return { repository, gameId, sessionId, read, run, runner };
}
describe('transactional creator rules', () => {
	it('commits included Actions as one event and publishes UI events only after SQL succeeds', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'included',actions:['start'],run(){return [{name:'bonus',args:{}}];}});`
		);
		const observed: { event: SessionUIEvent; revision: unknown; frozen: boolean }[] = [];
		const unsubscribe = setup.repository.subscribeSessionEvents(
			setup.gameId,
			setup.sessionId,
			(event) => {
				const row = storage.connection
					.prepare('SELECT value FROM progress WHERE id=?')
					.get(setup.sessionId) as { value: string };
				observed.push({
					event,
					revision: JSON.parse(row.value).revision,
					frozen: Object.isFrozen(event.payload)
				});
			}
		);
		const result = await setup.run();
		expect(result.progress.state).toEqual({ value: 11 });
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].changes).toEqual([
			{ path: ['value'], before: { exists: true, value: 0 }, after: { exists: true, value: 11 } }
		]);
		expect(observed.map((item) => [item.event.name, item.revision, item.frozen])).toEqual([
			['root', 1, true],
			['bonus', 1, true]
		]);
		expect(new Set(observed.map((item) => item.event.transactionId))).toEqual(
			new Set([result.progress.headId])
		);
		await setup.repository.selectSessionBranch(setup.gameId, setup.sessionId, null, 1);
		expect(observed).toHaveLength(2);
		unsubscribe();
		await setup.run(2);
		expect(observed).toHaveLength(2);
	});
	it.each(['hook', 'filter', 'sql'])(
		'rolls back all included work and suppresses UI events after %s failure',
		async (phase) => {
			const extra =
				`helia.defineHook({name:'included',actions:['start'],run(){helia.emit('hook');${phase === 'hook' ? `throw Error('failed');` : `return [{name:'bonus',args:{}}];`}}});` +
				(phase === 'filter'
					? `helia.defineFilter({name:'aggregate',actions:['start'],run({after}){return {allow:after.value<5};}});`
					: '');
			const setup = await fixture(extra),
				listener = vi.fn();
			setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, listener);
			const before = await setup.read();
			if (phase === 'sql')
				storage.connection.exec(
					"CREATE TRIGGER fail_rules BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'forced'); END"
				);
			await expect(setup.run()).rejects.toThrow();
			expect(await setup.read()).toEqual(before);
			expect(listener).not.toHaveBeenCalled();
		}
	);
	it('does not bypass Filters through direct state proposals or message commits', async () => {
		const setup = await fixture(
			`helia.defineFilter({name:'guard',run({action,after}){return {allow:action.name!=='sendMessage'&&after.value>=0,reason:'Denied'};}});`
		);
		const before = await setup.read();
		await expect(
			setup.repository.commitSessionTransaction(setup.gameId, setup.sessionId, {
				expectedRevision: 0,
				parentId: null,
				nextState: { value: -1 },
				action: { name: 'host', args: {} }
			})
		).rejects.toMatchObject({ code: 'filter-rejected' });
		await expect(
			setup.repository.appendUserMessage(setup.gameId, setup.sessionId, 'blocked')
		).rejects.toMatchObject({ code: 'filter-rejected' });
		expect(await setup.read()).toEqual(before);
	});
	it('runs independent work after the root commit in its own atomic scope', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run(){helia.emit('independent');return [{name:'bonus',args:{}}];}});`
		);
		const seen: { name: string; revision: number }[] = [];
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, (event) => {
			const row = storage.connection
				.prepare('SELECT value FROM progress WHERE id=?')
				.get(setup.sessionId) as { value: string };
			seen.push({ name: event.name, revision: JSON.parse(row.value).revision });
		});
		const saved = await setup.run();
		expect(saved.progress.state).toEqual({ value: 11 });
		expect(saved.transactions).toHaveLength(2);
		expect(saved.transactions[1].action.name).toBe('hook:independent');
		expect(saved.transactions[1].parentId).toBe(saved.execution.rootTransactionId);
		expect(saved.execution.independent).toMatchObject([
			{ name: 'independent', status: 'committed' }
		]);
		expect(seen).toEqual([
			{ name: 'root', revision: 1 },
			{ name: 'independent', revision: 2 },
			{ name: 'bonus', revision: 2 }
		]);
	});
	it('preserves the root and continues sibling jobs when one independent Hook fails', async () => {
		const setup = await fixture(`
helia.defineHook({name:'bad',mode:'independent',actions:['start'],run(){helia.emit('discard');throw Error('bad');}});
helia.defineHook({name:'good',mode:'independent',actions:['start'],run(){return [{name:'bonus',args:{}}];}});
`);
		const seen: string[] = [];
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, (event) =>
			seen.push(event.name)
		);
		const saved = await setup.run();
		expect(saved.progress.state).toEqual({ value: 11 });
		expect(saved.transactions).toHaveLength(2);
		expect(saved.execution.independent).toMatchObject([
			{ name: 'bad', status: 'failed', code: 'hook', ruleId: 'bad' },
			{ name: 'good', status: 'committed' }
		]);
		expect(seen).toEqual(['root', 'bonus']);
	});
	it('rolls back an independent SQL failure while keeping its trigger committed', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run(){helia.emit('discard');return [{name:'bonus',args:{}}];}});`
		);
		storage.connection.exec(
			"CREATE TRIGGER fail_independent BEFORE INSERT ON transactions WHEN json_extract(NEW.value,'$.action.name')='hook:independent' BEGIN SELECT RAISE(ABORT,'forced'); END"
		);
		const seen: string[] = [];
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, (event) =>
			seen.push(event.name)
		);
		const saved = await setup.run();
		expect(saved.progress.state).toEqual({ value: 1 });
		expect(saved.transactions).toHaveLength(1);
		expect(saved.execution.independent).toMatchObject([{ status: 'failed', code: 'storage' }]);
		expect(seen).toEqual(['root']);
	});
	it('never executes independent Hooks if the root SQL commit fails', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run(){throw Error('must not execute');}});`
		);
		const before = await setup.read();
		storage.connection.exec(
			"CREATE TRIGGER fail_root BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'forced'); END"
		);
		await expect(setup.run()).rejects.toThrow();
		expect(setup.runner).toHaveBeenCalledOnce();
		expect(await setup.read()).toEqual(before);
	});
	it('stops independent work on cancellation after the root commit', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run(){return [{name:'bonus',args:{}}];}});`
		);
		const controller = new AbortController();
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, () =>
			controller.abort()
		);
		const saved = await setup.run(0, controller.signal);
		expect(saved.progress.state).toEqual({ value: 1 });
		expect(saved.transactions).toHaveLength(1);
		expect(saved.execution.independent).toMatchObject([{ status: 'failed', code: 'canceled' }]);
	});
	it('isolates listener failures and session subscriptions from committed state', async () => {
		const setup = await fixture(''),
			other = await setup.repository.createSession(setup.gameId),
			foreign = vi.fn(),
			good = vi.fn();
		setup.repository.subscribeSessionEvents(setup.gameId, other.id, foreign);
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, () => {
			throw Error('listener');
		});
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, good);
		const saved = await setup.run();
		expect(saved.progress.state).toEqual({ value: 1 });
		expect(saved.execution.deliveryFailures).toBe(1);
		expect(good).toHaveBeenCalledOnce();
		expect(foreign).not.toHaveBeenCalled();
	});
	it('bounds independent reentry without rolling back earlier commits', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'loop',mode:'independent',run(){return [{name:'bonus',args:{}}];}});`
		);
		const saved = await setup.run();
		expect(saved.transactions).toHaveLength(2);
		expect(saved.progress.state).toEqual({ value: 11 });
		expect(saved.execution.independent).toMatchObject([
			{ status: 'committed' },
			{ status: 'failed', code: 'reentry' }
		]);
	});
	it('consumes accidental async listener failures after committing', async () => {
		const setup = await fixture('');
		setup.repository.subscribeSessionEvents(setup.gameId, setup.sessionId, async () => {
			throw Error('async listener');
		});
		const saved = await setup.run();
		expect(saved.execution.deliveryFailures).toBe(1);
		expect(saved.progress.revision).toBe(1);
	});
	it('caps independent follow-up commits for one invocation', async () => {
		const hooks = Array.from(
			{ length: 17 },
			(_, index) =>
				`helia.defineHook({name:'j${index}',mode:'independent',actions:['start'],run(){return [{name:'bonus',args:{}}];}});`
		).join('\n');
		const setup = await fixture(hooks),
			saved = await setup.run();
		expect(saved.progress.state).toEqual({ value: 161 });
		expect(saved.transactions).toHaveLength(17);
		expect(saved.execution.independent.filter((job) => job.status === 'committed')).toHaveLength(
			16
		);
		expect(saved.execution.independent.at(-1)).toMatchObject({
			name: 'j16',
			status: 'skipped',
			code: 'chain-limit'
		});
	});
	it('discards pending independent work if the player changes branch', async () => {
		const setup = await fixture(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run(){return [{name:'bonus',args:{}}];}});`
		);
		let began!: () => void, release!: () => void;
		const started = new Promise<void>((resolve) => (began = resolve)),
			gate = new Promise<void>((resolve) => (release = resolve));
		setup.runner.mockImplementation(async (request) => {
			if (request.operation?.kind === 'hook') {
				began();
				await gate;
			}
			return evaluateAction(request);
		});
		const pending = setup.run();
		await started;
		await setup.repository.selectSessionBranch(setup.gameId, setup.sessionId, null, 1);
		release();
		const saved = await pending;
		expect(saved.execution.independent).toMatchObject([{ status: 'failed', code: 'conflict' }]);
		const actual = await setup.repository.getSessionHistory(setup.gameId, setup.sessionId);
		expect(saved.progress).toEqual(actual.progress);
		expect(actual.progress.state).toEqual({ value: 0 });
		expect(actual.transactions).toHaveLength(1);
	});
});
