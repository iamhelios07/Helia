import { afterEach, it, expect, vi } from 'vitest';

import type { RoundRequest } from './protocol.js';

import { AI_LIMITS } from './protocol.js';
import { beginGeneration } from './transport.js';
vi.mock('#lib/platform/index.js', () => ({ isDesktopBuild: true, isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage?: (value: unknown) => void;
	}
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it('cancels native generation promptly and ignores late host chunks without awaiting the HTTP read', async () => {
	let deliver: ((value: unknown) => void) | undefined;
	const host = vi.fn(
		(input: { kind: string }, channel: { onmessage: (value: unknown) => void }) => {
			if (input.kind === 'begin') {
				return Promise.resolve({ lease: 'test-lease' });
			}
			if (input.kind === 'release') {
				return Promise.resolve({});
			}
			deliver = channel.onmessage;
			return new Promise<unknown>(() => {});
		}
	);
	const windowObject: Record<string, unknown> = { __HELIA_AI__: host };
	windowObject.top = windowObject;
	vi.stubGlobal('window', windowObject);
	const scope = await beginGeneration('game', 'session'),
		abort = new AbortController(),
		events = vi.fn();
	const request: RoundRequest = {
		provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
		model: 'test',
		messages: [{ role: 'user', content: 'Hi' }],
		tools: [],
		maxTokens: 100
	};
	const response = scope.generate(request, abort.signal, events);
	abort.abort();
	await expect(response).rejects.toThrow('중단');
	deliver?.({ chunk: 'data: {"choices":[{"delta":{"content":"Late"}}]}\n\n' });
	expect(events).not.toHaveBeenCalled();
	expect(host.mock.calls.some(([input]) => input.kind === 'release')).toBe(true);
});

it('renews native stream deadlines on provider activity without requiring visible text', async () => {
	vi.useFakeTimers();
	let deliver!: (value: unknown) => void;
	let finish!: (value: unknown) => void;
	const host = vi.fn(
		(input: { kind: string }, channel: { onmessage: (value: unknown) => void }) => {
			if (input.kind === 'begin') {
				return Promise.resolve({ lease: 'test-lease' });
			}
			if (input.kind === 'release') {
				return Promise.resolve({});
			}
			deliver = channel.onmessage;
			return new Promise((resolve) => {
				finish = resolve;
			});
		}
	);
	const windowObject: Record<string, unknown> = { __HELIA_AI__: host };
	windowObject.top = windowObject;
	vi.stubGlobal('window', windowObject);
	const scope = await beginGeneration('game', 'session');
	const request: RoundRequest = {
		provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
		model: 'test',
		messages: [],
		tools: [],
		maxTokens: 100
	};
	const events = vi.fn();
	const response = scope.generate(request, new AbortController().signal, events);
	const rejected = expect(response).rejects.toMatchObject({ name: 'TimeoutError' });
	for (let round = 0; round < 3; round++) {
		await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
		deliver({ activity: true });
	}
	expect(events.mock.calls.map(([event]) => event)).toEqual([
		{ type: 'activity' },
		{ type: 'activity' },
		{ type: 'activity' }
	]);
	expect(host.mock.calls.filter(([input]) => input.kind === 'release')).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs);
	await rejected;
	expect(host.mock.calls.filter(([input]) => input.kind === 'release')).toHaveLength(1);
	deliver({ chunk: 'data: {"choices":[{"delta":{"content":"late"}}]}\n\n' });
	finish({});
	expect(events).toHaveBeenCalledTimes(3);
	expect(vi.getTimerCount()).toBe(0);
});
