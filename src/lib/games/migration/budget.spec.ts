import { expect, it } from 'vitest';

import { MigrationBudget } from './budget.js';

it('bounds reservations and entries and makes release and disposal idempotent', () => {
	const budget = new MigrationBudget({ bytes: 10, entries: 1, deadlineMs: 10_000 });
	const reservation = budget.reserve(10);
	budget.addEntry();
	expect(() => budget.reserve(1)).toThrowError(expect.objectContaining({ kind: 'limit' }));
	expect(() => budget.addEntry()).toThrowError(expect.objectContaining({ kind: 'limit' }));
	reservation.dispose();
	reservation.dispose();
	budget.removeEntry();
	expect(budget.usage).toEqual({ bytes: 0, entries: 0 });
	budget.reserve(10);
	budget.dispose();
	budget.dispose();
	expect(budget.usage).toEqual({ bytes: 0, entries: 0 });
	expect(() => budget.checkpoint()).toThrow('Disposed migration budget');
});
