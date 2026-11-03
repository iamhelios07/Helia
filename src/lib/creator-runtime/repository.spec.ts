import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '#lib/server/sqlite.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { parseReply, type StorageTransport } from '#lib/storage/protocol.js';
import { evaluateAction } from './engine.js';
import type { ActionResult } from './protocol.js';

let storage: ReturnType<typeof openStorage>;
const transport: StorageTransport = async (input) => parseReply(storage.request(input));
beforeEach(() => {
	storage = openStorage(':memory:');
});
afterEach(() => storage.close());
const source = `helia.defineAction({
 name:'buy', description:'아이템 구매',
 arguments:{type:'object',properties:{price:{type:'integer'}},required:['price'],additionalProperties:false},
 run({state,args}) {state.gold -= args.price; return state;}
});`;
async function fixture(script = source, runner = vi.fn(evaluateAction)) {
	const repository = createGameRepository(transport, { runAction: runner });
	const game = await repository.createGame();
	await repository.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			required: ['gold'],
			additionalProperties: false
		},
		initialState: { gold: 100 },
		scripts: { main: { language: 'javascript', source: script } }
	});
	const gameId = game.id,
		sessionId = game.activeSessionId;
	await repository.getSessionHistory(gameId, sessionId);
	const read = () => transport({ kind: 'read', gameId, sessionId });
	const run = (revision = 0, price: number | string = 20, signal?: AbortSignal) =>
		repository.executeSessionAction(
			gameId,
			sessionId,
			{ expectedRevision: revision, action: { name: 'buy', args: { price } } },
			{ signal }
		);
	return { repository, gameId, sessionId, read, run, runner };
}
describe('creator Action → SQLite transaction', () => {
	it('commits one atomic event, forks from history, and restores without reexecuting code', async () => {
		const { repository, gameId, sessionId, run, runner } = await fixture();
		const first = await run();
		expect(first.progress.state).toEqual({ gold: 80 });
		expect(first.transactions).toHaveLength(1);
		expect(first.transactions[0]).toMatchObject({
			description: '아이템 구매',
			action: { name: 'buy', args: { price: 20 } },
			changes: [
				{ path: ['gold'], before: { exists: true, value: 100 }, after: { exists: true, value: 80 } }
			]
		});
		expect(Object.keys(runner.mock.calls[0][0]).sort()).toEqual([
			'action',
			'schema',
			'scripts',
			'state'
		]);
		await repository.selectSessionBranch(gameId, sessionId, null, 1);
		const second = await run(2, 30);
		expect(second.progress.state).toEqual({ gold: 70 });
		expect(second.transactions).toHaveLength(2);
		await repository.selectSessionBranch(gameId, sessionId, first.progress.headId, 3);
		expect((await repository.getSessionTimeline(gameId, sessionId)).history.progress.state).toEqual(
			{ gold: 80 }
		);
		expect(runner).toHaveBeenCalledTimes(2);
	});
	it.each([
		['invalid result', source.replace('return state;', 'return {gold:"bad"};')],
		['exception', source.replace('return state;', 'throw Error("failed");')],
		[
			'forbidden access',
			source.replace('return state;', 'fetch("https://example.com/leak"); return state;')
		],
		['infinite loop', source.replace('return state;', 'while(true) {}')]
	])('leaves records and storage version unchanged after %s', async (_name, script) => {
		const { run, read } = await fixture(script);
		const before = await read();
		await expect(run()).rejects.toThrow();
		expect(await read()).toEqual(before);
	});
	it('rejects bad arguments and stale revisions before executing an Action', async () => {
		const { run, read, runner } = await fixture();
		const before = await read();
		await expect(run(0, '20')).rejects.toMatchObject({ code: 'arguments' });
		expect(await read()).toEqual(before);
		runner.mockClear();
		await expect(run(1)).rejects.toThrow();
		expect(runner).not.toHaveBeenCalled();
		expect(await read()).toEqual(before);
	});
	it('rolls back event, state and metadata when SQL fails after execution', async () => {
		const { run, read } = await fixture();
		const before = await read();
		storage.connection.exec(
			"CREATE TRIGGER fail_action BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'forced failure'); END"
		);
		await expect(run()).rejects.toThrow();
		expect(await read()).toEqual(before);
	});
	it.each(['conflict', 'cancel'] as const)('discards an in-flight result on %s', async (kind) => {
		let release!: (result: ActionResult) => void;
		let began!: () => void;
		const started = new Promise<void>((resolve) => (began = resolve));
		const runner = vi.fn(evaluateAction).mockImplementationOnce(() => {
			began();
			return new Promise<ActionResult>((resolve) => (release = resolve));
		});
		const { repository, gameId, sessionId, read, run } = await fixture(source, runner);
		const controller = new AbortController();
		const pending = run(0, 20, controller.signal);
		await started;
		if (kind === 'cancel') controller.abort();
		else
			await repository.commitSessionTransaction(gameId, sessionId, {
				expectedRevision: 0,
				parentId: null,
				nextState: { gold: 50 },
				action: { name: 'other', args: {} }
			});
		const before = await read();
		release({ state: { gold: 80 } });
		await expect(pending).rejects.toThrow();
		expect(await read()).toEqual(before);
	});
});
