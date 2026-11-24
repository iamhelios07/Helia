import { expect, it } from 'vitest';

import { parseBaselineEpoch, parseBaselineHeader, parseBaselineState } from './baseline.js';

const common = { schemaVersion: 1, id: 'game', gameId: 'game', epochId: 'epoch' };
const epoch = { ...common, releaseId: 'release', openedAt: '2026-11-24T00:00:00Z' };
const header = {
	...common,
	id: 'session',
	sessionId: 'session',
	releaseId: 'release',
	fromVersion: '1.0.0-beta.1+build',
	snapshotId: 'snapshot',
	capturedAt: epoch.openedAt
};
const state = {
	...common,
	id: 'transaction',
	sessionId: 'session',
	transactionId: 'transaction',
	state: { gold: 10 }
};
it('parses the three independent baseline identities and strips unknown fields', () => {
	expect(parseBaselineEpoch({ ...epoch, ignored: true })).toEqual(epoch);
	expect(parseBaselineHeader({ ...header, ignored: true })).toEqual(header);
	expect(parseBaselineState({ ...state, ignored: true })).toEqual(state);
});
it.each([
	() => parseBaselineEpoch({ ...epoch, id: 'wrong' }),
	() => parseBaselineEpoch({ ...epoch, schemaVersion: 2 }),
	() => parseBaselineEpoch({ ...epoch, openedAt: 'bad' }),
	() => parseBaselineHeader({ ...header, id: 'wrong' }),
	() => parseBaselineHeader({ ...header, fromVersion: '1.0' }),
	() => parseBaselineState({ ...state, transactionId: 'wrong' }),
	() => parseBaselineState({ ...state, state: { bad: NaN } }),
	() => parseBaselineState({ ...state, epochId: '' })
])('rejects malformed baseline values', (parse) => {
	expect(parse).toThrow();
});
