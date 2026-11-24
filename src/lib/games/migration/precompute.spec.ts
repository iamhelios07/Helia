import { afterEach, expect, it, vi } from 'vitest';

import type {
	MigrationWorkerRequest,
	MigrationWorkerResult
} from '../scripting/migration-protocol.js';
import type { BaselineUse } from '../state/baseline.js';
import type { MigrationSource, StateResolver } from './inputs.js';

import { createGameRepository } from '../repository-core.js';
import { evaluateMigration } from '../scripting/migration-engine.js';
import { runMigrationWorker } from '../scripting/migration-runner.js';
import { parseBaselineHeader } from '../state/baseline.js';
import { canonical, parseGameSnapshot } from '../state/model.js';
import { StateValidationError } from '../state/schema.js';
import { MigrationBudget } from './budget.js';
import { MigrationFailure, safeSchemaPath } from './failure.js';
import * as inputsModule from './inputs.js';
import { migrationStates } from './inputs.js';
import { planMigration } from './plan.js';
import {
	createMigrationMemo,
	defaultResolver,
	disposeMigrationMemo,
	migrationResolver,
	precomputeMigrations
} from './precompute.js';
import { binding, GOLD_SCHEMA, migrationGame, migrationSource } from './test-fixtures.js';

vi.mock('../scripting/migration-runner.js', () => ({ runMigrationWorker: vi.fn() }));
const runner = vi.mocked(runMigrationWorker);
const owned: MigrationBudget[] = [];
function budget(limits: Partial<MigrationBudget['limits']> = {}, signal?: AbortSignal) {
	const value = new MigrationBudget(
		{ entries: 20_000, bytes: 128 * 1024 * 1024, deadlineMs: 600_000, ...limits },
		signal
	);
	owned.push(value);
	return value;
}
async function inProcess(
	request: MigrationWorkerRequest,
	_budget: MigrationBudget,
	receive: (result: MigrationWorkerResult) => void
) {
	if (!request.runs) {
		const result = await evaluateMigration(request.compiled);
		if (result.kind === 'catalog') {
			receive(result);
		}
		return;
	}
	for (const [index, input] of request.runs.entries()) {
		const result = await evaluateMigration(request.compiled, input);
		if (result.kind === 'state') {
			receive({ ...result, index });
		}
	}
}
runner.mockImplementation(inProcess);
afterEach(() => {
	owned.forEach((value) => value.dispose());
	owned.length = 0;
	runner.mockReset().mockImplementation(inProcess);
});
async function fixture(
	body?: string,
	limits?: Partial<MigrationBudget['limits']>,
	scope: 'all' | 'baseline' = 'all'
) {
	const game = migrationGame(body);
	const source = migrationSource();
	const work = budget(limits);
	const plan = await planMigration(game, binding, { budget: work });
	const memo = createMigrationMemo(plan, work, { scope });
	const context = {
		game,
		schemaOf: (id: string) => parseGameSnapshot(source.unit.get('snapshots', id)).schema
	};
	runner.mockClear();
	return { game, source, work, memo, context };
}
it('preserves values on every historical branch, initial state and current state', async () => {
	const { source, memo, context, work } = await fixture();
	await precomputeMigrations(memo, source, context);
	const inputs = [...migrationStates(source)];
	expect(inputs.map(migrationResolver(memo, context))).toEqual(
		[10, 12, 30, 15, 15].map((coins) => ({ coins }))
	);
	expect(inputs.map(defaultResolver(context))).toEqual(inputs.map(() => ({ coins: 0 })));
	expect(work.usage.entries).toBe(4);
	disposeMigrationMemo(memo);
	expect(work.usage).toEqual({ entries: 0, bytes: 0 });
});
it('deduplicates roles and sessions, reuses retries and removes keys absent from the new view', async () => {
	const { source, memo, context, work } = await fixture();
	const same = migrationSource([10, 10], source.baselines, ['a', 'b']);
	const onProgress = vi.fn();
	await precomputeMigrations(memo, same, context, { onProgress });
	expect(runner.mock.calls.flatMap(([request]) => request.runs ?? [])).toHaveLength(1);
	expect(onProgress).toHaveBeenLastCalledWith({ done: 1, total: 1 });
	const before = work.usage;
	runner.mockClear();
	await precomputeMigrations(memo, same, context);
	expect(runner).not.toHaveBeenCalled();
	expect(work.usage).toEqual(before);
	await precomputeMigrations(memo, source, context);
	expect(work.usage.entries).toBe(4);
	await precomputeMigrations(memo, same, context);
	expect(work.usage.entries).toBe(1);
	expect(work.usage.bytes).toBeLessThan(before.bytes + 100);
});
it('detects the entry ceiling before running any states and releases partial reservations', async () => {
	const { source, memo, context, work } = await fixture(undefined, { entries: 3 });
	await expect(precomputeMigrations(memo, source, context)).rejects.toMatchObject({
		kind: 'limit'
	});
	expect(runner).not.toHaveBeenCalled();
	expect(work.usage).toEqual({ entries: 0, bytes: 0 });
});

it('checks result-text reservations before memo insertion', async () => {
	const { memo, context, work } = await fixture("return {coins:'x'.repeat(1000)};", {
		bytes: 2000
	});
	context.game.schema = {
		type: 'object',
		properties: { coins: { type: 'string' } },
		additionalProperties: false
	};
	context.game.initialState = { coins: '' };
	await expect(precomputeMigrations(memo, migrationSource([]), context)).rejects.toMatchObject({
		kind: 'limit'
	});
	expect(runner).toHaveBeenCalledOnce();
	expect(work.usage).toEqual({ bytes: 0, entries: 0 });
});
it('checks cancellation, deadlines and restored-object memory before the first execution', async () => {
	const { source, memo, context, work } = await fixture();
	const tiny = budget({ bytes: 20 });
	const tinyMemo = createMigrationMemo(memo.plan, tiny, { scope: 'all' });
	await expect(precomputeMigrations(tinyMemo, source, context)).rejects.toMatchObject({
		kind: 'limit'
	});
	expect(tiny.usage.bytes).toBe(0);
	const abort = new AbortController();
	abort.abort();
	const canceled = createMigrationMemo(memo.plan, budget({}, abort.signal), { scope: 'all' });
	await expect(precomputeMigrations(canceled, source, context)).rejects.toMatchObject({
		kind: 'canceled'
	});
	const timed = createMigrationMemo(memo.plan, budget({ deadlineMs: 0 }), { scope: 'all' });
	await expect(precomputeMigrations(timed, source, context)).rejects.toMatchObject({
		kind: 'timeout'
	});
	expect(runner).not.toHaveBeenCalled();
	expect(work.usage.bytes).toBe(0);
});
it('yields while enumerating duplicate-heavy histories so cancellation precedes sandbox execution', async () => {
	const { memo, context } = await fixture();
	const abort = new AbortController();
	const work = budget({}, abort.signal);
	const canceled = createMigrationMemo(memo.plan, work, { scope: 'all' });
	const source = migrationSource(Array.from({ length: 1024 }, () => 10));
	setTimeout(() => abort.abort(), 0);
	await expect(precomputeMigrations(canceled, source, context)).rejects.toMatchObject({
		kind: 'canceled'
	});
	expect(runner).not.toHaveBeenCalled();
	expect(work.usage.bytes).toBe(0);
});
it('uses migrated=null to rescue default enum failures and validates complete output without defaults', async () => {
	const { source, memo, context } = await fixture(
		'if(migrated!==null)throw Error();return {coins:1};'
	);
	context.game.schema.properties.coins = { type: 'integer', enum: [1] };
	context.game.initialState = { coins: 2 };
	await precomputeMigrations(memo, source, context);
	expect([...migrationStates(source)].map(migrationResolver(memo, context))).toEqual(
		Array(5).fill({ coins: 1 })
	);
	const missing = await fixture('return {};');
	await expect(
		precomputeMigrations(missing.memo, missing.source, missing.context)
	).rejects.toMatchObject({ kind: 'schema', schemaPath: ['coins'], schemaCode: 'required' });
});
it('normalizes all observable property orders, including schemas and negative zero', async () => {
	const { source, memo, context } = await fixture(
		'return {coins:Object.keys(previous).join("")+"/"+Object.keys(migrated).join("")+"/"+Object.keys(previousSchema.properties).join("")};'
	);
	context.game.schema = {
		type: 'object',
		properties: { coins: { type: 'string' } },
		additionalProperties: false
	};
	context.game.initialState = { coins: '' };
	const old = parseGameSnapshot(source.unit.get('snapshots', 'old'));
	old.schema = {
		type: 'object',
		properties: { b: { type: 'number' }, a: { type: 'number' } },
		additionalProperties: false
	};
	old.initialState = { b: -0, a: 1 };
	source.unit.put('snapshots', old);
	const one = migrationSource([], source.baselines, ['b', 'a']);
	one.unit.put('snapshots', old);
	await precomputeMigrations(memo, one, context);
	expect(runner.mock.calls.flatMap(([request]) => request.runs ?? [])).toHaveLength(1);
	expect([...migrationStates(one)].map(migrationResolver(memo, context))).toEqual(
		Array(4).fill({ coins: 'ab/coins/ab' })
	);
	expect(canonical({ b: -0, a: 1 })).toBe(canonical({ a: 1, b: 0 }));
});
it('never reuses memo results across plans with different bindings', async () => {
	const game = migrationGame();
	const source = migrationSource();
	const work = budget();
	const context = {
		game,
		schemaOf: (id: string) => parseGameSnapshot(source.unit.get('snapshots', id)).schema
	};
	const first = createMigrationMemo(await planMigration(game, binding, { budget: work }), work, {
		scope: 'all'
	});
	const second = createMigrationMemo(
		await planMigration(game, { ...binding, targetReleaseId: 'other' }, { budget: work }),
		work,
		{ scope: 'all' }
	);
	runner.mockClear();
	await precomputeMigrations(first, source, context);
	const runs = runner.mock.calls.flatMap(([request]) => request.runs ?? []).length;
	expect(runs).toBeGreaterThan(0);
	runner.mockClear();
	await precomputeMigrations(first, source, context);
	expect(runner).not.toHaveBeenCalled();
	runner.mockClear();
	await precomputeMigrations(second, source, context);
	expect(runner.mock.calls.flatMap(([request]) => request.runs ?? [])).toHaveLength(runs);
	disposeMigrationMemo(first);
	disposeMigrationMemo(second);
});
it('deduplicates states that differ only in property order within one batch', async () => {
	const { memo, context } = await fixture('return {coins:previous.gold};');
	const base = {
		sessionId: 'a',
		sourceSnapshotId: 'old',
		origin: 'draft' as const
	};
	const first = { ...base, role: 'initial' as const, state: { gold: 12, bonus: 1 } };
	const second = { ...base, role: 'current' as const, state: { bonus: 1, gold: 12 } };
	const spy = vi.spyOn(inputsModule, 'migrationStates').mockImplementation(function* () {
		yield first;
		yield second;
	});
	try {
		await precomputeMigrations(memo, migrationSource(), context);
		expect(runner.mock.calls.flatMap(([request]) => request.runs ?? [])).toHaveLength(1);
		const resolve = migrationResolver(memo, context);
		expect([first, second].map(resolve)).toEqual([{ coins: 12 }, { coins: 12 }]);
	} finally {
		spy.mockRestore();
		disposeMigrationMemo(memo);
	}
});

function use(): BaselineUse {
	return {
		kind: 'use',
		header: parseBaselineHeader({
			schemaVersion: 1,
			id: 'a',
			sessionId: 'a',
			gameId: 'game',
			epochId: 'epoch',
			releaseId: 'release',
			fromVersion: '1.0.0',
			snapshotId: 'old',
			capturedAt: '2026-11-24T00:00:00Z'
		}),
		states: new Map([['a-0', { gold: 99 }]])
	};
}
it('enumerates mixed capture/use/none origins and applies baseline scope even with the same snapshot ID', async () => {
	const { source, memo: all, context } = await fixture();
	const baselines = new Map<string, BaselineUse>([
		['a', use()],
		['b', { kind: 'capture' }]
	]);
	const mixed = migrationSource([12, 30], baselines, ['c', 'b', 'a']);
	const inputs = [...migrationStates(mixed)];
	expect(
		inputs.map(({ sessionId, role, origin, state }) => [sessionId, role, origin, state.gold])
	).toEqual([
		['a', 'initial', 'baseline', 10],
		['a', 'checkpoint', 'baseline', 99],
		['a', 'checkpoint', 'draft', 30],
		['a', 'current', 'draft', 30],
		['b', 'initial', 'baseline', 10],
		['b', 'checkpoint', 'baseline', 12],
		['b', 'checkpoint', 'baseline', 30],
		['b', 'current', 'baseline', 30],
		['c', 'initial', 'draft', 10],
		['c', 'checkpoint', 'draft', 12],
		['c', 'checkpoint', 'draft', 30],
		['c', 'current', 'draft', 30]
	]);
	const memo = createMigrationMemo(all.plan, all.budget, { scope: 'baseline' });
	await precomputeMigrations(memo, mixed, context);
	const resolve = migrationResolver(memo, context);
	expect(inputs.map(resolve)).toEqual(
		inputs.map((input) => ({ coins: input.origin === 'baseline' ? input.state.gold : 0 }))
	);
	expect([...migrationStates(source)].every((input) => input.origin === 'draft')).toBe(true);
});
it('rejects damaged baseline state and missing baseline snapshots with safe locations', () => {
	const selection = use();
	if (selection.kind !== 'use') {
		throw Error();
	}
	const source = migrationSource(
		[12],
		new Map([['a', { ...selection, states: new Map([['a-0', { gold: 'bad' }]]) }]])
	);
	expect(() => [...migrationStates(source)]).toThrowError(
		expect.objectContaining({
			kind: 'default',
			location: { sessionId: 'a', role: 'checkpoint', transactionId: 'a-0' }
		})
	);
	const missing = migrationSource(
		[],
		new Map([['a', { ...selection, header: { ...selection.header, snapshotId: 'missing' } }]])
	);
	expect(() => [...migrationStates(missing)]).toThrowError(
		expect.objectContaining({ kind: 'default', location: { sessionId: 'a', role: 'initial' } })
	);
});
it('reports only schema-approved paths and never retains input state in failures', async () => {
	const { source, memo, context } = await fixture(
		'return {...migrated,[String(previous.gold)]:true};'
	);
	await expect(precomputeMigrations(memo, source, context)).rejects.toMatchObject({
		kind: 'schema',
		schemaPath: ['<unknown>'],
		location: { sessionId: 'a', role: 'initial' }
	});
	const error = new MigrationFailure('default', {
		location: { ...[...migrationStates(source)][0] },
		validation: {
			schema: GOLD_SCHEMA,
			error: new StateValidationError('load', ['constructor', 'secret'], 'arbitrary')
		}
	});
	expect(error.location).toEqual({ sessionId: 'a', role: 'initial' });
	expect(error.schemaPath).toEqual(['<unknown>']);
	expect(error.schemaCode).toBe('invalid');
	expect(
		safeSchemaPath(
			{
				type: 'object',
				properties: { items: { type: 'array', items: GOLD_SCHEMA } },
				additionalProperties: false
			},
			['items', 0, 'secret']
		)
	).toEqual(['items', 0, '<unknown>']);
});
it('uses no memo or per-state execution when no migration is selected; resolver still enforces budget', async () => {
	const { source, memo, context } = await fixture();
	const plain = createMigrationMemo({ ...memo.plan, migration: null }, memo.budget, {
		scope: 'all'
	});
	await precomputeMigrations(plain, source, context);
	const input = [...migrationStates(source)][0];
	expect(migrationResolver(plain, context)(input)).toEqual(defaultResolver(context)(input));
	expect(runner).not.toHaveBeenCalled();
	const expired = createMigrationMemo(plain.plan, budget({ deadlineMs: 0 }), { scope: 'all' });
	expect(() => migrationResolver(expired, context)(input)).toThrowError(
		expect.objectContaining({ kind: 'timeout' })
	);
	expect(() => migrationResolver(memo, context)(input)).toThrowError(
		expect.objectContaining({ kind: 'missing' })
	);
});

it('selects zero, one or ambiguous migrations using the selected release version', async () => {
	const game = migrationGame();
	expect(
		(await planMigration(game, { ...binding, fromVersion: '2.0.0' }, { budget: budget() }))
			.migration
	).toBeNull();
	expect(
		(await planMigration(game, { ...binding, fromVersion: '2.0.0-beta.1' }, { budget: budget() }))
			.migration?.name
	).toBe('rename');
	const source =
		game.scripts.rules.source + `helia.defineMigration({name:'second',run(){return {coins:0};}});`;
	game.scripts.rules = { language: 'typescript', source, compiled: source };
	await expect(planMigration(game, binding, { budget: budget() })).rejects.toMatchObject({
		kind: 'ambiguous'
	});
	game.scripts = {};
	runner.mockClear();
	expect((await planMigration(game, binding, { budget: budget() })).migration).toBeNull();
	expect(runner).not.toHaveBeenCalled();
});
it('keeps planning within the same cancelable budget and permits caller cleanup on every failure', async () => {
	const abort = new AbortController();
	const work = budget({}, abort.signal);
	runner.mockImplementationOnce(async () => {
		abort.abort();
		throw new MigrationFailure('canceled');
	});
	await expect(planMigration(migrationGame(), binding, { budget: work })).rejects.toMatchObject({
		kind: 'canceled'
	});
	work.dispose();
	expect(work.usage).toEqual({ bytes: 0, entries: 0 });
	const invalid = migrationGame();
	invalid.scripts.rules.source = invalid.scripts.rules.compiled =
		'helia.defineMigration({name:"bad",from:"^1.0.0",run(){return {}}});';
	const failed = budget();
	await expect(planMigration(invalid, binding, { budget: failed })).rejects.toMatchObject({
		kind: 'registration'
	});
	failed.dispose();
	expect(failed.usage.bytes).toBe(0);
});

it('consumes identical locations, origins, keys and values in precompute and repository migration', async () => {
	const { memo: all, context } = await fixture();
	const source = migrationSource(
		[12, 30],
		new Map<string, BaselineUse>([
			['a', use()],
			['b', { kind: 'capture' }]
		]),
		['c', 'b', 'a']
	);
	const memo = createMigrationMemo(all.plan, all.budget, { scope: 'baseline' });
	const original = inputsModule.migrationStates;
	const traces: string[][] = [];
	const spy = vi.spyOn(inputsModule, 'migrationStates').mockImplementation(function* (value) {
		const trace: string[] = [];
		traces.push(trace);
		for (const input of original(value)) {
			trace.push(canonical(input));
			yield input;
		}
	});
	try {
		await precomputeMigrations(memo, source, context);
		const repository = createGameRepository(async () => {
			throw Error('No host writes in unit test');
		});
		const consumer = repository as unknown as {
			migrateSessions(
				source: MigrationSource,
				game: typeof context.game,
				resolve: StateResolver
			): void;
		};
		consumer.migrateSessions(source, context.game, migrationResolver(memo, context));
		expect(traces).toHaveLength(2);
		expect(traces[1]).toEqual(traces[0]);
		expect(source.unit.all('checkpoints')).toHaveLength(6);
	} finally {
		spy.mockRestore();
		disposeMigrationMemo(memo);
	}
});

it('cancels every parallel lane after the first failure and clears partial memo results', async () => {
	const { memo, context, work } = await fixture();
	let canceled = 0;
	runner.mockImplementation(async (_request, _budget, _receive, signal) => {
		await new Promise<void>((_resolve, reject) => {
			if (runner.mock.calls.length === 1) {
				setTimeout(() => reject(new MigrationFailure('exception')), 0);
				return;
			}
			signal!.addEventListener(
				'abort',
				() => {
					canceled++;
					reject(new MigrationFailure('canceled'));
				},
				{ once: true }
			);
		});
	});
	await expect(
		precomputeMigrations(
			memo,
			migrationSource(Array.from({ length: 800 }, (_, index) => index)),
			context
		)
	).rejects.toMatchObject({ kind: 'exception' });
	expect(canceled).toBe(3);
	expect(work.usage).toEqual({ bytes: 0, entries: 0 });
	expect(memo.entries.size).toBe(0);
});

it('preserves default Apply wording and locates enum failures inside historical arrays', () => {
	const game = migrationGame();
	game.schema = {
		type: 'object',
		properties: { coins: { type: 'integer' } },
		required: ['coins'],
		additionalProperties: false
	};
	game.initialState = {};
	const input = [...migrationStates(migrationSource())][0];
	const missing = defaultResolver({ game, schemaOf: () => GOLD_SCHEMA });
	expect(() => missing(input)).toThrow('새 필드의 초기값이 필요해요: coins');
	const old = {
		type: 'object',
		properties: {
			inventory: {
				type: 'array',
				items: {
					type: 'object',
					properties: { kind: { type: 'string' } },
					additionalProperties: false
				}
			}
		},
		additionalProperties: false
	} as const;
	const schema = structuredClone(old);
	game.schema = {
		...schema,
		properties: {
			inventory: {
				type: 'array',
				items: {
					type: 'object',
					properties: { kind: { type: 'string', enum: ['new'] } },
					additionalProperties: false
				}
			}
		}
	};
	game.initialState = { inventory: [{ kind: 'new' }] };
	const resolve = defaultResolver({ game, schemaOf: () => old });
	expect(() => resolve({ ...input, state: { inventory: [{ kind: 'old' }] } })).toThrowError(
		expect.objectContaining({
			kind: 'default',
			schemaPath: ['inventory', 0, 'kind'],
			schemaCode: 'enum'
		})
	);
});
