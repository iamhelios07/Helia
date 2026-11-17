import { afterEach, expect, it, vi } from 'vitest';

import { SessionLeases } from './leases.js';
import { AI_LIMITS } from './protocol.js';
import { streamTimeout } from './stream-timeout.js';

afterEach(() => vi.useRealTimers());

it('expires ten minutes after the last activity, regardless of total duration', async () => {
	vi.useFakeTimers();
	const idle = streamTimeout(new AbortController().signal);
	for (let round = 0; round < 4; round++) {
		await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
		expect(idle.signal.aborted).toBe(false);
		idle.touch();
	}
	await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
	expect(idle.signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(idle.signal.reason).toMatchObject({ name: 'TimeoutError' });
	idle.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it('cleans up deadlines on cancellation and disposal without reviving canceled work', () => {
	vi.useFakeTimers();
	const abort = new AbortController();
	const idle = streamTimeout(abort.signal);
	abort.abort();
	idle.touch();
	expect(idle.signal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	const completed = streamTimeout(new AbortController().signal);
	completed.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it('renews generation leases during long streams but expires abandoned leases', () => {
	vi.useFakeTimers();
	const leases = new SessionLeases();
	const id = leases.begin('game', 'session');
	for (let round = 0; round < 3; round++) {
		vi.advanceTimersByTime(AI_LIMITS.streamIdleMs - 1);
		leases.touch(id, 'game', 'session');
	}
	expect(() => leases.begin('game', 'session')).toThrow();
	expect(() => leases.require(id, 'game', 'session')).not.toThrow();
	vi.advanceTimersByTime(AI_LIMITS.streamIdleMs);
	expect(() => leases.require(id, 'game', 'session')).toThrow();
	expect(() => leases.touch(id, 'game', 'session')).toThrow();
});
