import { afterEach, expect, it, vi } from 'vitest';

import { GamePackageError } from '#lib/games/package/limits.js';

import { POST } from '../../routes/api/games/[id]/uploads/+server.js';
import { DELETE, GET } from '../../routes/api/games/[id]/uploads/[uploadId]/+server.js';
import { PUT } from '../../routes/api/games/[id]/uploads/[uploadId]/chunks/[index]/+server.js';
import { POST as FINISH } from '../../routes/api/games/[id]/uploads/[uploadId]/finish/+server.js';
import { readBytes, uploadResponse } from './media-http.js';
import * as sqlite from './sqlite.js';

const url = new URL('http://helia.test/api/games/g/uploads');
type UploadEvent = Parameters<typeof POST | typeof PUT | typeof FINISH | typeof GET>[0];
function event<T extends UploadEvent>(
	method: string,
	params: { id: string; uploadId: string; index: string },
	body?: BodyInit,
	headers: Record<string, string> = {}
) {
	return {
		params,
		url,
		request: new Request(url, {
			method,
			body,
			duplex: 'half',
			headers: { origin: url.origin, ...headers }
		} as RequestInit)
	} as T;
}
const type = {
	'content-type': 'application/octet-stream',
	'x-helia-chunk-sha256': '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d'
};
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
it('serves edit upload routes with no-store, origin checks and stable errors', async () => {
	const store = sqlite.openStorage(':memory:');
	vi.spyOn(sqlite, 'serverStorage').mockReturnValue(store);
	try {
		store.connection.exec("INSERT INTO games(id,value) VALUES('g','{}')");
		const begin = JSON.stringify({ purpose: 'edit', mime: 'video/mp4', size: 1 }),
			params = { id: 'g', uploadId: '', index: '0' };
		const forbidden = await POST(event('POST', params, begin, { origin: 'http://other.test' }));
		expect(await forbidden.json()).toEqual({ errorCode: 'format' });
		expect(forbidden.headers.get('cache-control')).toBe('no-store');
		const start = await POST(event('POST', params, begin));
		params.uploadId = (await start.json()).uploadId;
		const tooLong = await PUT(event('PUT', params, new Uint8Array(2), type));
		expect(await tooLong.json()).toEqual({ errorCode: 'chunkInvalid' });
		const put = await PUT(event('PUT', params, new Uint8Array(1), type));
		expect(await put.json()).toEqual({ received: 0 });
		const finish = await FINISH(event('POST', params));
		const result = await finish.json();
		expect(result.kind).toBe('blob');
		const status = await GET(event('GET', params));
		expect(await status.json()).toMatchObject({ state: 'completed', result });
		const cancel = await DELETE(event('DELETE', params));
		expect(await cancel.json()).toEqual({ alreadyCompleted: result });
		for (const response of [start, tooLong, put, finish, status, cancel]) {
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	} finally {
		store.close();
	}
});
it('returns busy for a queued PUT and admits its retry once idle bodies time out', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const store = sqlite.openStorage(':memory:');
	vi.spyOn(sqlite, 'serverStorage').mockReturnValue(store);
	const closing = Promise.withResolvers<void>();
	const cancel = vi.fn(() => closing.promise);
	try {
		store.connection.exec("INSERT INTO games(id,value) VALUES('g','{}')");
		const { uploadId } = store.uploads.begin('g', { purpose: 'edit', mime: 'image/png', size: 1 });
		const put = (body: BodyInit) =>
			PUT(event('PUT', { id: 'g', uploadId, index: '0' }, body, type));
		const sources: ReadableStreamDefaultController<Uint8Array>[] = [];
		const occupied = Array.from({ length: 4 }, () =>
			put(
				new ReadableStream<Uint8Array>({
					start(c) {
						sources.push(c);
					},
					cancel
				})
			)
		);
		const queued = put(new Uint8Array(1));
		await vi.advanceTimersByTimeAsync(20000);
		for (const source of sources) {
			source.enqueue(new Uint8Array(1)); // Progress restarts the idle timer, not the queue timer.
		}
		await vi.advanceTimersByTimeAsync(10000);
		const busy = await queued;
		expect(busy.status).toBe(503);
		expect(busy.headers.get('retry-after')).toBe('1');
		expect(busy.headers.get('cache-control')).toBe('no-store');
		expect(await busy.json()).toEqual({ errorCode: 'busy' });
		const retry = put(new Uint8Array(1));
		await vi.advanceTimersByTimeAsync(19999);
		expect(cancel).not.toHaveBeenCalled();
		expect(store.uploads.status('g', uploadId).received).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		for (const response of await Promise.all(occupied)) {
			expect(await response.json()).toEqual({ errorCode: 'chunkInvalid' });
		}
		expect(cancel).toHaveBeenCalledTimes(4);
		expect(await (await retry).json()).toEqual({ received: 0 });
	} finally {
		closing.resolve();
		store.close();
	}
});
it('stops the reader on overflow and maps adapter 413, overload and unexpected exceptions', async () => {
	const cancelled = vi.fn();
	const stream = new ReadableStream({
		pull(c) {
			c.enqueue(new Uint8Array(2));
		},
		cancel: cancelled
	});
	const request = new Request(url, {
		method: 'PUT',
		body: stream,
		duplex: 'half',
		headers: { origin: url.origin }
	} as RequestInit);
	await expect(readBytes(request, 1)).rejects.toMatchObject({ code: 'chunkInvalid' });
	expect(cancelled).toHaveBeenCalledOnce();
	for (const [error, code, status] of [
		[{ status: 413 }, 'requestLimit', 413],
		[new GamePackageError('busy'), 'busy', 503],
		[Error('secret SQL/path'), 'format', 400]
	] as const) {
		const response = await uploadResponse(request, url, () => {
			throw error;
		});
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ errorCode: code });
		if (code === 'busy') {
			expect(response.headers.get('retry-after')).toBe('1');
		}
	}
});
