import { afterEach, expect, it, vi } from 'vitest';

import { AI_LIMITS, type RoundRequest } from './protocol.js';
import { beginGeneration } from './transport.js';

vi.mock('#lib/platform/index.js', () => ({ isDesktopBuild: false, isTauri: () => false }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const request: RoundRequest = {
	provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' },
	model: 'test',
	messages: [],
	tools: [],
	maxTokens: 100
};
function providerStream() {
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			const input = JSON.parse(String(init?.body));
			if (input.kind === 'begin') {
				return Response.json({ lease: 'test-lease' });
			}
			if (input.kind === 'release') {
				return Response.json({});
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						stream = controller;
						init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
							once: true
						});
					}
				})
			);
		})
	);
	return {
		send: (text: string) => stream.enqueue(new TextEncoder().encode(text)),
		close: () => stream.close()
	};
}

it('accepts a long web stream with partial transport frames and completes the model round', async () => {
	vi.useFakeTimers();
	const stream = providerStream();
	const scope = await beginGeneration('game', 'session');
	const result = scope.generate(request, new AbortController().signal, vi.fn());
	await vi.advanceTimersByTimeAsync(0);
	for (const fragment of ['{"activity":', 'true}', '\n']) {
		await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs - 1);
		stream.send(fragment);
		await vi.advanceTimersByTimeAsync(0);
	}
	const chunk =
		'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	stream.send(JSON.stringify({ chunk }) + '\n' + JSON.stringify({ done: true }) + '\n');
	stream.close();
	await expect(result).resolves.toMatchObject({ text: 'Done', calls: [] });
	expect(vi.getTimerCount()).toBe(0);
});

it('aborts a silent web stream instead of leaving a read pending', async () => {
	vi.useFakeTimers();
	providerStream();
	const scope = await beginGeneration('game', 'session');
	const result = scope.generate(request, new AbortController().signal, vi.fn());
	const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
	await vi.advanceTimersByTimeAsync(AI_LIMITS.streamIdleMs);
	await rejected;
	expect(vi.getTimerCount()).toBe(0);
});
