import { Agent } from 'undici';

import {
	NETWORK_LIMITS,
	parseNetworkRequest,
	decodeBytes,
	encodeBytes,
	type NetworkEvent
} from '#lib/games/network/protocol.js';

import { networkAddresses } from './network-policy.js';

/** A single hop: redirect destinations must return to the trusted permission gate. */
export async function sendNetworkRequest(
	input: unknown,
	signal: AbortSignal,
	send: typeof fetch = fetch
) {
	const request = parseNetworkRequest(input);
	const addresses = await networkAddresses(request.url);
	signal.throwIfAborted();
	const dispatcher = new Agent({
		headersTimeout: NETWORK_LIMITS.idleMs,
		bodyTimeout: NETWORK_LIMITS.idleMs,
		connect: {
			lookup: (_hostname, options, callback) => {
				const candidates = addresses.filter(
					(item) => !options.family || item.family === options.family
				);
				const first = candidates[0];
				if (!first) {
					callback(new Error('Network address unavailable'), '', 4);
				} else if (options.all) {
					callback(null, candidates);
				} else {
					callback(null, first.address, first.family);
				}
			}
		}
	});
	try {
		const headers = new Headers(request.headers);
		headers.set('accept-encoding', 'identity');
		const options = {
			method: request.method,
			headers,
			body: request.body === null ? undefined : decodeBytes(request.body),
			redirect: 'manual' as const,
			credentials: 'omit' as const,
			signal,
			dispatcher
		};
		const response = await send(request.url, options);
		return { response, close: () => dispatcher.destroy() };
	} catch {
		await dispatcher.destroy();
		throw new TypeError('Fetch failed');
	}
}
async function* networkEvents(
	input: unknown,
	signal: AbortSignal
): AsyncGenerator<NetworkEvent, void> {
	const { response, close } = await sendNetworkRequest(input, signal);
	const reader = response.body?.getReader();
	try {
		const headers = [...response.headers].filter(([name]) => name !== 'set-cookie');
		if (JSON.stringify(headers).length > NETWORK_LIMITS.headerBytes) {
			throw new TypeError('Fetch headers too large');
		}
		yield {
			kind: 'head',
			head: { status: response.status, statusText: response.statusText, headers }
		};
		let bytes = 0;
		for (;;) {
			const part = await reader?.read();
			if (!part || part.done) {
				break;
			}
			bytes += part.value.byteLength;
			if (bytes > NETWORK_LIMITS.responseBytes) {
				throw new TypeError('Fetch response too large');
			}
			yield { kind: 'chunk', data: encodeBytes(part.value) };
		}
		yield { kind: 'end' };
	} finally {
		await reader?.cancel().catch(() => {});
		await close();
	}
}
export function networkResponse(input: unknown, parent: AbortSignal): Response {
	const abort = new AbortController();
	const events = networkEvents(input, AbortSignal.any([parent, abort.signal]));
	const encoder = new TextEncoder();
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await events.next();
				if (closed) {
					return;
				}
				if (next.done) {
					closed = true;
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'));
			} catch {
				if (!closed) {
					controller.enqueue(encoder.encode('{"kind":"error"}\n'));
					closed = true;
					controller.close();
				}
				abort.abort();
			}
		},
		async cancel() {
			closed = true;
			abort.abort();
			await events.return(undefined);
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'application/x-ndjson',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
}
