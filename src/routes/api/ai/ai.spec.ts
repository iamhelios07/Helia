import { afterEach, expect, it, vi } from 'vitest';

import { hostAILeases } from '#lib/games/ai/leases.js';
import { aiError, AI_LIMITS } from '#lib/games/ai/protocol.js';

import { POST } from './+server.js';

const generate = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/credentials.js', () => ({ serverCredentials: () => ({ generate }) }));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	generate.mockReset();
});

function event(lease: string) {
	return {
		url: new URL('http://localhost/api/ai'),
		request: new Request('http://localhost/api/ai', {
			method: 'POST',
			headers: { origin: 'http://localhost', 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: 'round',
				lease,
				gameId: 'test-game',
				sessionId: 'test-session',
				request: {
					provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
					model: 'test',
					messages: [],
					tools: [],
					maxTokens: 100
				}
			})
		})
	} as Parameters<typeof POST>[0];
}
it('renews the owning generation lease during tool IO and rejects another session', async () => {
	vi.useFakeTimers();
	vi.stubEnv('HELIA_ORIGIN', 'http://localhost');
	const lease = hostAILeases.begin('test-game', 'test-session');
	const touch = (sessionId: string) =>
		POST({
			...event(lease),
			request: new Request('http://localhost/api/ai', {
				method: 'POST',
				headers: { origin: 'http://localhost', 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'touch', gameId: 'test-game', sessionId, lease })
			})
		});
	try {
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(AI_LIMITS.streamIdleMs - 1);
			expect((await touch('test-session')).status).toBe(200);
		}
		expect((await touch('other-session')).status).toBe(400);
		expect(() => hostAILeases.require(lease, 'test-game', 'test-session')).not.toThrow();
	} finally {
		hostAILeases.release(lease, 'test-game', 'test-session');
	}
});

it('forwards real provider activity, renews the lease, and retains it for the final commit', async () => {
	vi.useFakeTimers();
	vi.stubEnv('HELIA_ORIGIN', 'http://localhost');
	const lease = hostAILeases.begin('test-game', 'test-session');
	let activity!: () => void;
	let finish!: () => void;
	generate.mockImplementation((_request, _signal, _emit, onActivity) => {
		activity = onActivity;
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	try {
		const response = await POST(event(lease));
		const text = response.text();
		for (let round = 0; round < 3; round++) {
			vi.advanceTimersByTime(AI_LIMITS.streamIdleMs - 1);
			activity();
		}
		expect(generate.mock.calls[0][1].aborted).toBe(false);
		finish();
		expect(
			(await text)
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		).toEqual([{ activity: true }, { activity: true }, { activity: true }, { done: true }]);
		expect(() => hostAILeases.require(lease, 'test-game', 'test-session')).not.toThrow();
	} finally {
		hostAILeases.release(lease, 'test-game', 'test-session');
	}
});

it.each(['timeout', 'provider'] as const)(
	'forwards %s failures without leaking the provider error',
	async (kind) => {
		vi.stubEnv('HELIA_ORIGIN', 'http://localhost');
		const lease = hostAILeases.begin('test-game', 'test-session');
		generate.mockRejectedValue(
			kind === 'timeout' ? aiError('timeout') : Error('secret provider error')
		);
		try {
			const response = await POST(event(lease));
			const value = JSON.parse((await response.text()).trim());
			expect(value.error).not.toContain('secret');
			if (kind === 'timeout') {
				expect(value.code).toBe('timeout');
				expect(() => hostAILeases.require(lease, 'test-game', 'test-session')).toThrow();
			} else {
				expect(value.code).toBeUndefined();
				expect(() => hostAILeases.require(lease, 'test-game', 'test-session')).not.toThrow();
			}
		} finally {
			hostAILeases.release(lease, 'test-game', 'test-session');
		}
	}
);
