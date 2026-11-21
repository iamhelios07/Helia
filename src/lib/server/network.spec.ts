import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

import { POST } from '../../routes/api/network/+server.js';
import { networkAddresses } from './network-policy.js';
import { networkResponse, sendNetworkRequest } from './network.js';

vi.mock('./network-policy.js', () => ({
	networkAddresses: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
const input = {
	url: 'https://api.example/image',
	method: 'POST',
	headers: [['authorization', 'Bearer caller-supplied']],
	body: btoa('hello')
};
it('connects to the pinned address without resolving again and leaves redirects for the permission gate', async () => {
	let calls = 0;
	const upstream = createServer(async (request, response) => {
		calls++;
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}
		expect(Buffer.concat(chunks).toString()).toBe('hello');
		expect(request.headers.authorization).toBe('Bearer caller-supplied');
		expect(request.headers.cookie).toBeUndefined();
		response.writeHead(302, { location: 'http://127.0.0.1/private', 'content-type': 'text/plain' });
		response.end('redirect');
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	try {
		const address = upstream.address();
		if (!address || typeof address === 'string') {
			throw new Error('Missing test server');
		}
		vi.mocked(networkAddresses).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		const result = await sendNetworkRequest(
			{ ...input, url: `http://pinned.invalid:${address.port}/image` },
			new AbortController().signal
		);
		try {
			expect(result.response.status).toBe(302);
			expect(await result.response.text()).toBe('redirect');
			expect(calls).toBe(1);
		} finally {
			await result.close();
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			upstream.close((error) => (error ? reject(error) : resolve()))
		);
	}
});
it('sends one pinned hop without cookies, streams binary and preserves HTTP errors', async () => {
	const send = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(new Uint8Array([0, 255]), {
			status: 429,
			headers: { 'set-cookie': 'secret=1', 'content-type': 'image/png' }
		})
	);
	vi.stubGlobal('fetch', send);
	const events = (await networkResponse(input, new AbortController().signal).text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(events).toEqual([
		{
			kind: 'head',
			head: { status: 429, statusText: '', headers: [['content-type', 'image/png']] }
		},
		{ kind: 'chunk', data: 'AP8=' },
		{ kind: 'end' }
	]);
	expect(send).toHaveBeenCalledOnce();
	const [url, options] = send.mock.calls[0];
	expect(url).toBe(input.url);
	expect(options).toMatchObject({
		redirect: 'manual',
		credentials: 'omit',
		body: new TextEncoder().encode('hello'),
		dispatcher: expect.any(Object)
	});
	expect(new Headers(options?.headers).get('cookie')).toBeNull();
	expect(new Headers(options?.headers).get('authorization')).toBe('Bearer caller-supplied');
	expect(networkAddresses).toHaveBeenCalledWith(input.url);
});
it('sanitizes network errors and aborts upstream when the consumer cancels', async () => {
	const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret token and URL'));
	vi.stubGlobal('fetch', send);
	expect(await networkResponse(input, new AbortController().signal).text()).toBe(
		'{"kind":"error"}\n'
	);
	let signal: AbortSignal | undefined;
	send.mockImplementation(async (_url, options) => {
		signal = options?.signal ?? undefined;
		return new Response(new ReadableStream({ start() {} }));
	});
	const reader = networkResponse(input, new AbortController().signal).body!.getReader();
	await reader.read();
	await reader.cancel();
	expect(signal?.aborted).toBe(true);
	await expect(
		sendNetworkRequest(
			{ ...input, headers: [['cookie', 'secret']] },
			new AbortController().signal,
			send
		)
	).rejects.toThrow();
});
it('rejects cross-origin and malformed proxy requests before contacting a destination', async () => {
	vi.stubEnv('HELIA_ORIGIN', 'http://helia.test');
	const send = vi.fn<typeof fetch>();
	vi.stubGlobal('fetch', send);
	const event = (origin: string, body: string) =>
		({
			request: new Request('http://helia.test/api/network', {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body
			}),
			url: new URL('http://helia.test/api/network')
		}) as Parameters<typeof POST>[0];
	expect((await POST(event('https://foreign.example', JSON.stringify(input)))).status).toBe(403);
	expect((await POST(event('http://helia.test', '{'))).status).toBe(400);
	expect(send).not.toHaveBeenCalled();
});
