import { Channel } from '@tauri-apps/api/core';

import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import { decodeBytes, NETWORK_LIMITS, type NetworkEvent, type NetworkRequest } from './protocol.js';

async function* webEvents(
	request: NetworkRequest,
	signal: AbortSignal,
	gameId?: string
): AsyncGenerator<NetworkEvent, void> {
	const response = await fetch('/api/network', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...request, ...(gameId ? { gameId } : {}) }),
		signal
	});
	if (!response.ok || !response.body) {
		throw new TypeError('Fetch failed');
	}
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) {
				break;
			}
			buffer += part.value;
			if (buffer.length > 2 * NETWORK_LIMITS.responseBytes) {
				throw new TypeError('Invalid fetch response');
			}
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				yield JSON.parse(line) as NetworkEvent;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}
async function* nativeEvents(
	request: NetworkRequest,
	signal: AbortSignal,
	gameId?: string
): AsyncGenerator<NetworkEvent, void> {
	if (!isTauri() || window !== window.top) {
		throw new TypeError('Fetch unavailable');
	}
	const host: unknown = Reflect.get(window, '__HELIA_NETWORK__');
	if (typeof host !== 'function') {
		throw new TypeError('Fetch unavailable');
	}
	const id = crypto.randomUUID();
	const channel = new Channel<NetworkEvent>();
	const queue: NetworkEvent[] = [];
	let wake = () => {};
	channel.onmessage = (event) => {
		queue.push(event);
		wake();
	};
	const cancel = () => {
		wake();
		void Promise.resolve(host({ kind: 'cancel', id }, new Channel())).catch(() => {});
	};
	signal.addEventListener('abort', cancel, { once: true });
	try {
		signal.throwIfAborted();
		await host({ kind: 'fetch', id, request, ...(gameId ? { gameId } : {}) }, channel);
		for (;;) {
			signal.throwIfAborted();
			if (!queue.length) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const event = queue.shift()!;
			yield event;
			if (event.kind === 'end' || event.kind === 'error') {
				break;
			}
		}
	} finally {
		signal.removeEventListener('abort', cancel);
		cancel();
	}
}
export async function networkHop(
	request: NetworkRequest,
	signal: AbortSignal,
	gameId?: string
): Promise<Response> {
	const events = isDesktopBuild
		? nativeEvents(request, signal, gameId)
		: webEvents(request, signal, gameId);
	const first = await events.next();
	if (first.done || first.value.kind !== 'head') {
		await events.return(undefined);
		throw new TypeError('Fetch failed');
	}
	const head = first.value.head;
	let bytes = 0;
	const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			try {
				const part = await events.next();
				if (part.done || part.value.kind === 'error') {
					throw new TypeError('Fetch response interrupted');
				}
				if (part.value.kind === 'end') {
					controller.close();
					await events.return(undefined);
					return;
				}
				if (part.value.kind !== 'chunk') {
					throw new TypeError('Invalid fetch response');
				}
				const data = decodeBytes(part.value.data);
				bytes += data.byteLength;
				if (bytes > NETWORK_LIMITS.responseBytes) {
					throw new TypeError('Fetch response too large');
				}
				controller.enqueue(data);
			} catch (error) {
				controller.error(error);
				await events.return(undefined);
			}
		},
		async cancel() {
			await events.return(undefined);
		}
	});
	const noBody = request.method === 'HEAD' || [204, 205, 304].includes(head.status);
	if (noBody) {
		await body.cancel();
	}
	try {
		return new Response(noBody ? null : body, head);
	} catch (error) {
		await body.cancel().catch(() => {});
		throw error;
	}
}
