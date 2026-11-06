import { it, expect, vi } from 'vitest';
import { generateProvider, SecretRedactor } from './generation.js';
import type { RoundRequest } from '#lib/games/ai/protocol.js';
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
					for (const chunk of ['data: {"text":"secret-', 'test-key"}\n\n'])
						controller.enqueue(new TextEncoder().encode(chunk));
					controller.close();
				}
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	);
	await generateProvider(
		{ ...provider, apiKey: key },
		input,
		new AbortController().signal,
		(chunk) => seen.push(chunk),
		undefined,
		send
	);
	expect(send.mock.calls[0][1]?.headers).toMatchObject({ authorization: `Bearer ${key}` });
	expect(send.mock.calls[0][1]?.redirect).toBe('error');
	expect(String(send.mock.calls[0][1]?.body)).not.toContain(key);
	expect(seen.join('')).not.toContain(key);
	expect(seen.join('')).toContain('[redacted]');
});
it('never exposes provider error bodies or follows redirects', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response('secret-test-key', { status: 401 }));
	await expect(
		generateProvider(
			{ ...provider, apiKey: 'secret-test-key' },
			input,
			new AbortController().signal,
			() => {},
			undefined,
			send
		)
	).rejects.not.toThrow('secret-test-key');
});
it('redacts escaped JSON credentials without leaking suffixes between chunks', () => {
	const redactor = new SecretRedactor(['key"quoted']);
	const output = redactor.push('before key\\"quo') + redactor.push('ted after', true);
	expect(output).toBe('before [redacted] after');
});
