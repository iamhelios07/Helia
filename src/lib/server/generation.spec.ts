import { it, expect, vi, afterEach } from 'vitest';

import type { RoundRequest } from '#lib/games/ai/protocol.js';

import { AI_LIMITS } from '#lib/games/ai/protocol.js';

import { generateProvider, SecretRedactor } from './generation.js';
afterEach(() => vi.useRealTimers());
const provider = {
	id: 'test',
	kind: 'openai-compatible' as const,
	baseUrl: 'https://example.com/v1'
};
const input: RoundRequest = {
	provider,
	model: 'test',
	maxTokens: 100,
	messages: [{ role: 'user', content: 'Hi' }],
	tools: []
};
it('keeps authentication in the trusted request and redacts a key split across response chunks', async () => {
	const key = 'secret-test-key',
		seen: string[] = [];
	const send = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of ['data: {"text":"secret-', 'test-key"}\n\n']) {
						controller.enqueue(new TextEncoder().encode(chunk));
					}
					controller.close();
				}
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	);
	await generateProvider({ ...provider, apiKey: key }, input, {
		signal: new AbortController().signal,
		emit: (chunk) => seen.push(chunk),
		send
	});
	expect(send.mock.calls[0][1]?.headers).toMatchObject({ authorization: `Bearer ${key}` });
	expect(send.mock.calls[0][1]?.redirect).toBe('error');
	expect(String(send.mock.calls[0][1]?.body)).not.toContain(key);
	expect(seen.join('')).not.toContain(key);
	expect(seen.join('')).toContain('[redacted]');
});

it('counts raw bytes even when redaction holds them and times out only after ten minutes of silence', async () => {
	vi.useFakeTimers();
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const send = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			new ReadableStream({
				start(controller) {
					stream = controller;
				},
				cancel
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	);
	const emit = vi.fn(),
		activity = vi.fn();
	const generation = generateProvider(
		{ ...provider, apiKey: 'a-secret-longer-than-the-chunks' },
		input,
		{
			signal: new AbortController().signal,
			send,
			emit,
			onActivity: activity
		}
	);
	const rejected = expect(generation).rejects.toMatchObject({ name: 'TimeoutError' });
	await vi.advanceTimersByTimeAsync(0);
	for (let index = 0; index < 3; index++) {
		await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
		stream.enqueue(new TextEncoder().encode(':'));
		await vi.advanceTimersByTimeAsync(0);
	}
	expect(emit).not.toHaveBeenCalled();
	expect(activity).toHaveBeenCalledTimes(4);
	await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs);
	await rejected;
	expect(cancel).toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it('times out waiting for the first response and aborts the provider request', async () => {
	vi.useFakeTimers();
	const send = vi.fn<typeof fetch>(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
			})
	);
	const generation = generateProvider({ ...provider, apiKey: 'test-key' }, input, {
		signal: new AbortController().signal,
		send,
		emit: vi.fn()
	});
	const rejected = expect(generation).rejects.toMatchObject({ name: 'TimeoutError' });
	await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
	expect(send.mock.calls[0][1]!.signal!.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	await rejected;
});
it('never exposes provider error bodies or follows redirects', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response('secret-test-key', { status: 401 }));
	await expect(
		generateProvider({ ...provider, apiKey: 'secret-test-key' }, input, {
			signal: new AbortController().signal,
			emit: () => {},
			send
		})
	).rejects.not.toThrow('secret-test-key');
});
it('redacts escaped JSON credentials without leaking suffixes between chunks', () => {
	const redactor = new SecretRedactor(['key"quoted']);
	const output = redactor.push('before key\\"quo') + redactor.push('ted after', true);
	expect(output).toBe('before [redacted] after');
});
