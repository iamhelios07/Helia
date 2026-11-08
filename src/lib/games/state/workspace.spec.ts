import { describe, expect, it } from 'vitest';

import { createWorkspace, TransactionFailure } from './workspace.js';

const schema = {
	type: 'object',
	properties: {
		gold: { type: 'integer' },
		inventory: { type: 'array', items: { type: 'string' } }
	},
	required: ['gold', 'inventory'],
	additionalProperties: false
};
const initial = { gold: 100, inventory: [] };
const args = {
	type: 'object',
	properties: { amount: { type: 'integer' } },
	required: ['amount'],
	additionalProperties: false
};
const action = { name: 'buy', args: { amount: 20 } };

describe('atomic state workspace', () => {
	it('accumulates tool results and returns one net change set without mutating authoritative state', () => {
		const work = createWorkspace(schema, initial);
		work.step(action, args, (state, input) => ({
			...state,
			gold: Number(state.gold) - Number(input.amount)
		}));
		work.step(
			{ name: 'receive', args: {} },
			{ type: 'object', properties: {}, additionalProperties: false },
			(state) => ({ ...state, inventory: ['sword'] })
		);
		expect(work.read()).toEqual({ gold: 80, inventory: ['sword'] });
		expect(initial).toEqual({ gold: 100, inventory: [] });
		const result = work.finish(action);
		expect(result.state).toEqual({ gold: 80, inventory: ['sword'] });
		expect(result.changes.map((change) => change.path)).toEqual([['gold'], ['inventory']]);
		expect(() => work.finish(action)).toThrow(/finished/);
	});
});

describe('atomic state workspace', () => {
	it('validates arguments before invoking an operation and poisons the atomic scope on failure', () => {
		const work = createWorkspace(schema, initial);
		work.replace({ gold: 90, inventory: [] });
		let invoked = false;
		expect(() =>
			work.step({ name: 'buy', args: { amount: 'twenty' } }, args, () => {
				invoked = true;
				return initial;
			})
		).toThrow(/arguments/);
		expect(invoked).toBe(false);
		expect(() => work.finish(action)).toThrow(/failed/);
		expect(initial.gold).toBe(100);
	});
});

describe('atomic state workspace', () => {
	it.each(['throw', 'schema', 'extra'])(
		'discards a partially mutated step on %s failure',
		(kind) => {
			const work = createWorkspace(schema, initial);
			expect(() =>
				work.step(action, args, (state) => {
					state.gold = 0;
					if (kind === 'throw') {
						throw new Error('execution failed');
					}
					return kind === 'schema' ? { ...state, gold: 'invalid' } : { ...state, extra: true };
				})
			).toThrow();
			expect(() => work.read()).toThrow(/failed/);
			expect(initial).toEqual({ gold: 100, inventory: [] });
		}
	);
});

describe('atomic state workspace', () => {
	it.each(['filter', 'hook'] as const)(
		'propagates a trusted %s integration failure and prevents finalization',
		(phase) => {
			const work = createWorkspace(schema, initial);
			work.replace({ gold: 80, inventory: ['sword'] });
			expect(() =>
				work.finish(action, () => {
					throw new TransactionFailure(phase, 'rule', 'rejected');
				})
			).toThrow(TransactionFailure);
			expect(() => work.finish(action)).toThrow(/failed/);
		}
	);
});

describe('atomic state workspace', () => {
	it('provides frozen detached rule inputs and rejects malformed validator results', () => {
		const work = createWorkspace(schema, initial);
		expect(() =>
			work.finish(action, (context) => {
				Object.defineProperty(context.after.inventory, '0', { value: 'forged' });
			})
		).toThrow();
		expect(initial.inventory).toEqual([]);
		const other = createWorkspace(schema, initial);
		expect(() => other.finish(action, () => false)).toThrow(/invalid-validator-result/);
	});
});

describe('atomic state workspace', () => {
	it('detaches input, returned state and replacements, and rejects use after abort', () => {
		const input = { gold: 100, inventory: ['potion'] };
		const work = createWorkspace(schema, input);
		input.inventory.push('external');
		const read = work.read();
		(read.inventory as string[]).push('external');
		expect(work.read().inventory).toEqual(['potion']);
		work.abort();
		expect(() => work.replace(initial)).toThrow(/failed/);
	});
});
