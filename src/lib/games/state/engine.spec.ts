import { describe, expect, it } from 'vitest';
import {
	activeMemories,
	activeTransactions,
	applyChanges,
	checkoutHistory,
	createSessionState,
	prepareTransaction,
	messageBase,
	stateAt
} from './engine.js';
import {
	parseGameSnapshot,
	parseAction,
	parseSessionState,
	parseTransaction,
	type SessionHistory,
	type Memory
} from './model.js';
import { parseGameState, type GameState } from './value.js';

const now = '2026-11-02T00:00:00.000Z';
function start(): SessionHistory {
	const snapshot = parseGameSnapshot({
		schemaVersion: 1,
		id: 'snapshot',
		gameId: 'game',
		createdAt: now,
		settings: { description: '', firstMessage: '', authorNote: '' },
		schema: {
			type: 'object',
			properties: {
				gold: { type: ['integer', 'null'] },
				inventory: {
					type: 'object',
					properties: { iron: { type: 'integer' } },
					additionalProperties: false
				},
				orders: {
					type: 'array',
					items: {
						type: 'object',
						properties: { id: { type: 'string' } },
						additionalProperties: false
					}
				},
				reputation: { type: 'integer' },
				'a.b': { type: 'boolean' }
			},
			additionalProperties: false
		},
		initialState: { gold: 100, inventory: { iron: 3 }, orders: [] },
		scripts: {}
	});
	return { snapshot, progress: createSessionState(snapshot, 'session'), transactions: [] };
}
function commit(
	history: SessionHistory,
	id: string,
	nextState: GameState,
	withMessage = false,
	parentId = history.progress.headId
): SessionHistory {
	const result = prepareTransaction(
		history,
		{
			expectedRevision: history.progress.revision,
			parentId,
			nextState,
			action: { name: id, args: {} }
		},
		{ id, createdAt: now, ...(withMessage ? { messageId: `message-${id}` } : {}) }
	);
	return {
		...history,
		progress: result.progress,
		transactions: [...history.transactions, result.transaction]
	};
}

describe('transaction state engine', () => {
	it('records action arguments separately from the resulting changes and detaches both', () => {
		const history = start();
		const action = { name: 'buyItem', args: { itemId: 'iron', quantity: 2 } };
		const prepared = prepareTransaction(
			history,
			{
				expectedRevision: 0,
				parentId: null,
				nextState: { gold: 80, inventory: { iron: 5 }, orders: [] },
				action
			},
			{ id: 'purchase', createdAt: now }
		);
		action.args.quantity = 100;
		expect(prepared.transaction.action).toEqual({
			name: 'buyItem',
			args: { itemId: 'iron', quantity: 2 }
		});
		expect(prepared.transaction.changes).toHaveLength(2);
		expect(prepared.transaction).not.toHaveProperty('origin');
	});

	it.each([
		null,
		{},
		{ name: ' ', args: {} },
		{ name: 'buy', args: [] },
		{ name: 'buy', args: { quantity: NaN } }
	])('rejects invalid action records: %j', (value) => {
		expect(() => parseAction(value)).toThrow();
	});

	it('finds a message checkpoint regardless of its action name', () => {
		const history = commit(start(), 'creator.customAction', { gold: 80 }, true);
		expect(messageBase(history, 'creator.customAction')).toEqual({
			headId: null,
			state: start().snapshot.initialState
		});
	});

	it('rejects unsupported transaction and session-state formats', () => {
		const history = commit(start(), 'purchase', { gold: 80 });
		const node = history.transactions[0];
		expect(() => parseTransaction({ ...node, schemaVersion: 1 })).toThrow();
		expect(() => parseSessionState({ ...history.progress, schemaVersion: 1 })).toThrow();
		expect(parseTransaction(JSON.parse(JSON.stringify(node)))).toEqual(node);
	});
	it('records a multi-field purchase with exact before/after values without mutating inputs', () => {
		const before = start();
		const desired = { gold: 80, inventory: { iron: 5 }, orders: [] };
		const after = commit(before, '철 구매', desired);
		expect(after.transactions[0].changes).toEqual([
			{ path: ['gold'], before: { exists: true, value: 100 }, after: { exists: true, value: 80 } },
			{
				path: ['inventory', 'iron'],
				before: { exists: true, value: 3 },
				after: { exists: true, value: 5 }
			}
		]);
		expect(before.progress.state.gold).toBe(100);
		desired.inventory.iron = 999;
		expect(after.progress.state.inventory).toEqual({ iron: 5 });
		expect(stateAt(after)).toEqual(after.progress.state);
	});

	it('rerolls from the response base, preserves the player purchase, and restores an older continuation', () => {
		let history = commit(start(), 'buy', { gold: 80, inventory: { iron: 5 }, orders: [] });
		history = commit(history, 'response-a', { ...history.progress.state, reputation: 1 }, true);
		history = commit(history, 'later-action', { ...history.progress.state, gold: 70 });
		const originalHead = history.progress.headId;
		const base = messageBase(history, 'response-a');
		expect(base.headId).toBe('buy');
		expect(base.state.gold).toBe(80);
		history = commit(history, 'response-b', { ...base.state, reputation: -1 }, true, base.headId);
		expect(activeTransactions(history).map((node) => node.id)).toEqual(['buy', 'response-b']);
		expect(history.progress.state).toMatchObject({ gold: 80, reputation: -1 });
		expect(history.transactions).toHaveLength(4);
		history = {
			...history,
			progress: checkoutHistory(history, originalHead, history.progress.revision)
		};
		expect(history.progress.state).toMatchObject({ gold: 70, reputation: 1 });
		expect(activeTransactions(history).map((node) => node.id)).toEqual([
			'buy',
			'response-a',
			'later-action'
		]);
	});

	it('distinguishes missing values from null and records arrays as complete values', () => {
		let history = commit(start(), 'create', {
			gold: null,
			inventory: { iron: 3 },
			orders: [{ id: 'sword' }],
			'a.b': false
		});
		expect(
			history.transactions[0].changes.find((change) => change.path[0] === 'a.b')?.before
		).toEqual({ exists: false });
		history = commit(history, 'delete', { inventory: {}, orders: [] });
		expect(stateAt(history)).toEqual({ inventory: {}, orders: [] });
		expect(history.transactions[1].changes.find((change) => change.path[0] === 'gold')).toEqual({
			path: ['gold'],
			before: { exists: true, value: null },
			after: { exists: false }
		});
	});

	it('rejects stale results even after moving away from and back to the same head', () => {
		let history = commit(start(), 'action', { gold: 80 });
		const stale = history.progress.revision;
		history = { ...history, progress: checkoutHistory(history, null, stale) };
		history = {
			...history,
			progress: checkoutHistory(history, 'action', history.progress.revision)
		};
		expect(() =>
			prepareTransaction(
				history,
				{
					expectedRevision: stale,
					parentId: 'action',
					nextState: { gold: 0 },
					action: { name: 'stale', args: {} }
				},
				{ id: 'stale', createdAt: now }
			)
		).toThrow(/최신 상태/);
		expect(history.progress.revision).toBe(3);
	});

	it('never partially applies a corrupted change batch', () => {
		const original = { gold: 100, iron: 3 };
		expect(() =>
			applyChanges(original, [
				{
					path: ['gold'],
					before: { exists: true, value: 100 },
					after: { exists: true, value: 80 }
				},
				{ path: ['iron'], before: { exists: true, value: 999 }, after: { exists: true, value: 5 } }
			])
		).toThrow();
		expect(original).toEqual({ gold: 100, iron: 3 });
		expect(() =>
			applyChanges(original, [
				{
					path: ['__proto__'],
					before: { exists: false },
					after: { exists: true, value: { polluted: true } }
				}
			])
		).toThrow();
	});

	it('filters memories by every source transaction in the selected branch', () => {
		let history = commit(start(), 'a', { gold: 80 }, true);
		const memory: Memory = {
			schemaVersion: 1,
			id: 'memory',
			gameId: 'game',
			sessionId: 'session',
			sourceTransactionIds: ['a'],
			content: 'A에서 발생한 사건',
			createdAt: now
		};
		expect(activeMemories(history, [memory])).toEqual([memory]);
		history = commit(history, 'b', { gold: 60 }, true, null);
		expect(
			activeMemories(history, [
				memory,
				{ ...memory, sessionId: 'other' },
				{ ...memory, sourceTransactionIds: [] }
			])
		).toEqual([]);
		history = { ...history, progress: checkoutHistory(history, 'a', history.progress.revision) };
		expect(activeMemories(history, [memory])).toEqual([memory]);
	});

	it('rejects orphaned, cyclic, duplicate and foreign history nodes', () => {
		const history = commit(start(), 'a', { gold: 80 });
		const node = history.transactions[0];
		for (const transactions of [
			[{ ...node, parentId: 'missing' }],
			[{ ...node, parentId: 'a' }],
			[node, node],
			[{ ...node, sessionId: 'foreign' }]
		]) {
			expect(() => stateAt({ ...history, transactions })).toThrow();
		}
		expect(() => messageBase(history, 'a')).toThrow();
	});

	it('round-trips a history through JSON with the same branch and state', () => {
		const original = commit(start(), 'a', { gold: 80, inventory: { iron: 5 } });
		const stored = JSON.parse(JSON.stringify(original));
		const restored: SessionHistory = {
			snapshot: parseGameSnapshot(stored.snapshot),
			progress: parseSessionState(stored.progress),
			transactions: stored.transactions.map(parseTransaction)
		};
		expect(stateAt(restored)).toEqual(original.progress.state);
		expect(() =>
			parseTransaction({
				...stored.transactions[0],
				changes: [
					{ path: ['constructor'], before: { exists: false }, after: { exists: true, value: null } }
				]
			})
		).toThrow();
	});

	it.each([undefined, NaN, Infinity, 1n, () => 1, Symbol('value'), new Date(), new Map()])(
		'rejects values that cannot be faithfully saved: %s',
		(value) => {
			expect(() => parseGameState({ value })).toThrow();
		}
	);
	it('rejects cycles, array holes and accessors without evaluating getters', () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => parseGameState(cycle)).toThrow();
		expect(() => parseGameState({ value: new Array(2) })).toThrow();
		let reads = 0;
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				reads += 1;
				return 1;
			}
		});
		expect(() => parseGameState(accessor)).toThrow();
		expect(reads).toBe(0);
	});
});
