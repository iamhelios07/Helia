import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { networkHop } from './transport.js';

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return platform.desktop;
	},
	isTauri: () => true
}));
vi.mock('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage?: (value: unknown) => void;
	}
}));
beforeEach(() => {
	platform.desktop = false;
});
afterEach(() => vi.unstubAllGlobals());
const request = {
	url: 'https://api.example/',
	method: 'GET',
	headers: [] as [string, string][],
	body: null
};
const head = {
	kind: 'head',
	head: { status: 200, statusText: 'OK', headers: [['content-type', 'application/octet-stream']] }
};

it('reconstructs a streaming web response before the response body has arrived', async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(value) {
							controller = value;
							controller.enqueue(new TextEncoder().encode(JSON.stringify(head) + '\n'));
						}
					})
				)
		)
	);
	const abort = new AbortController();
	const response = await networkHop(request, abort.signal);
	expect(response.status).toBe(200);
	controller.enqueue(new TextEncoder().encode('{"kind":"chunk","data":"AP8="}\n{"kind":"end"}\n'));
	controller.close();
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
});
it('fails interrupted web streams instead of returning a partial success', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(head) + '\n{"kind":"chunk","data":"YQ=="}\n'))
	);
	const response = await networkHop(request, new AbortController().signal);
	await expect(response.text()).rejects.toThrow('interrupted');
});
it('closes the upstream stream when an HTTP upgrade cannot become a Fetch Response', async () => {
	const cancelled = vi.fn();
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									JSON.stringify({ kind: 'head', head: { status: 101, headers: [] } }) + '\n'
								)
							);
						},
						cancel: cancelled
					})
				)
		)
	);
	await expect(networkHop(request, new AbortController().signal)).rejects.toThrow();
	expect(cancelled).toHaveBeenCalled();
});
it('uses the private native channel and cancels the native request after consumption', async () => {
	platform.desktop = true;
	const host = vi.fn(
		async (input: { kind: string }, channel: { onmessage?: (value: unknown) => void }) => {
			if (input.kind === 'fetch') {
				channel.onmessage?.(head);
				channel.onmessage?.({ kind: 'chunk', data: 'AP8=' });
				channel.onmessage?.({ kind: 'end' });
			}
		}
	);
	const windowObject = { top: null as unknown, __HELIA_NETWORK__: host };
	windowObject.top = windowObject;
	vi.stubGlobal('window', windowObject);
	const response = await networkHop(request, new AbortController().signal);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
	expect(host.mock.calls.map(([input]) => input.kind)).toEqual(['fetch', 'cancel']);
});
it('aborts a native response while waiting for more bytes', async () => {
	platform.desktop = true;
	const host = vi.fn(
		async (input: { kind: string }, channel: { onmessage?: (value: unknown) => void }) => {
			if (input.kind === 'fetch') {
				channel.onmessage?.(head);
			}
		}
	);
	const windowObject = { top: null as unknown, __HELIA_NETWORK__: host };
	windowObject.top = windowObject;
	vi.stubGlobal('window', windowObject);
	const abort = new AbortController();
	const response = await networkHop(request, abort.signal);
	const body = response.text();
	abort.abort();
	await expect(body).rejects.toThrow();
	expect(host.mock.calls.some(([input]) => input.kind === 'cancel')).toBe(true);
});
