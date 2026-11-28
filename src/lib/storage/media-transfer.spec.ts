import { afterEach, expect, it, vi } from 'vitest';

import { MEDIA_CHUNK_SIZE } from './media-protocol.js';
import { uploadEditMedia } from './media-transfer.js';

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return platform.desktop;
	},
	isTauri: () => platform.desktop
}));
const file = new Blob(['hello'], { type: 'video/mp4' }),
	sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const begun = { uploadId: 'upload', chunkSize: MEDIA_CHUNK_SIZE, chunkCount: 1 };
const result = {
	kind: 'blob',
	size: 5,
	mime: 'video/mp4',
	sha256: sha,
	blobId: '1'.repeat(64),
	assetHash: '2'.repeat(64)
};
afterEach(() => {
	platform.desktop = false;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function transport(chunk: () => Response, finish: () => Response = () => Response.json(result)) {
	const send = vi.fn(async (url: string, request: RequestInit) => {
		if (url.endsWith('/uploads')) {
			return Response.json(begun);
		}
		if (request.method === 'PUT') {
			return chunk();
		}
		if (url.endsWith('/finish')) {
			return finish();
		}
		return Response.json({ cancelled: true });
	});
	vi.stubGlobal('fetch', send);
	return send;
}
it('honors Retry-After without spending retries, retries lost chunks and replays Finish', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	const times: number[] = [];
	let finishes = 0;
	const send = transport(
		() => {
			times.push(Date.now());
			if (times.length <= 6) {
				return Response.json(
					{ errorCode: 'busy' },
					{ status: 503, headers: { 'retry-after': times.length === 1 ? '0' : '2' } }
				);
			}
			if (times.length === 7) {
				throw TypeError('offline');
			}
			return Response.json({ received: 0 });
		},
		() => {
			finishes++;
			if (finishes === 1) {
				throw TypeError('lost reply');
			}
			if (finishes === 2) {
				return Response.json({ errorCode: 'inProgress' }, { status: 400 });
			}
			return Response.json(result);
		}
	);
	const task = uploadEditMedia('g', file);
	await vi.waitFor(() => expect(times.length).toBe(1));
	await vi.runAllTimersAsync();
	expect(await task).toEqual(result);
	expect(times).toHaveLength(8);
	expect(times[1] - times[0]).toBe(100);
	expect(times[6] - times[1]).toBe(10000);
	expect(times[7] - times[6]).toBe(250);
	expect(finishes).toBe(3);
	expect(send.mock.calls.filter(([url]) => url.endsWith('/uploads'))).toHaveLength(1);
	expect(send.mock.calls[1][1].headers).toMatchObject({ 'x-helia-chunk-sha256': sha });
});
it('stops after five chunk retries and cancels instead of resuming', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	let attempts = 0;
	const send = transport(() => {
		attempts++;
		throw TypeError('offline');
	});
	const failure = expect(uploadEditMedia('g', file)).rejects.toThrow('offline');
	await vi.waitFor(() => expect(attempts).toBe(1));
	await vi.runAllTimersAsync();
	await failure;
	expect(attempts).toBe(6);
	expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', keepalive: true });
});
it.each(['abort', 'pagehide'])(
	'interrupts a request on %s and sends keepalive Cancel',
	async (action) => {
		const events = new EventTarget();
		vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
		vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
		const started = Promise.withResolvers<void>();
		let signal: AbortSignal | null | undefined;
		const send = vi.fn(async (url: string, req: RequestInit) => {
			if (req.method === 'PUT') {
				signal = req.signal;
				started.resolve();
				return new Promise<Response>((_, reject) =>
					signal?.addEventListener('abort', () => reject(signal?.reason))
				);
			}
			return Response.json(url.endsWith('/uploads') ? begun : { cancelled: true });
		});
		vi.stubGlobal('fetch', send);
		const controller = new AbortController();
		const failure = expect(
			uploadEditMedia('g', file, { signal: controller.signal })
		).rejects.toMatchObject({ name: 'AbortError' });
		await started.promise;
		if (action === 'abort') {
			controller.abort();
		} else {
			events.dispatchEvent(new Event('pagehide'));
		}
		await failure;
		expect(signal?.aborted).toBe(true);
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', keepalive: true });
	}
);
it('uses the protected desktop bridge with one bounded base64 chunk', async () => {
	platform.desktop = true;
	const host = vi.fn(async (request: { kind: string }) => {
		if (request.kind === 'mediaUploadBegin') {
			return begun;
		}
		if (request.kind === 'mediaUploadChunk') {
			return { received: 0 };
		}
		return result;
	});
	const view = { __HELIA_STORAGE__: host };
	Object.assign(view, { top: view });
	vi.stubGlobal('window', view);
	expect(await uploadEditMedia('g', file)).toEqual(result);
	expect(host.mock.calls[1][0]).toEqual({
		kind: 'mediaUploadChunk',
		gameId: 'g',
		uploadId: 'upload',
		index: 0,
		sha256: sha,
		data: 'aGVsbG8='
	});
});
