import { byteRange, type ByteRange } from '#lib/server/http-range.js';
import { type OpenMedia, RuntimeContent } from '#lib/server/runtime-content.js';
import { serverStorage } from '#lib/server/sqlite.js';
import { storageAsset } from '#lib/server/storage-sync.js';
import { syncHash } from '#lib/storage/sync.js';

import type { RequestHandler } from './$types';

function assetHeaders(mime: string, etag: string) {
	return new Headers({
		'content-type': mime,
		'cross-origin-resource-policy': 'cross-origin',
		'cache-control': 'private, max-age=31536000, immutable',
		'x-content-type-options': 'nosniff',
		etag
	});
}

function mediaBody(media: OpenMedia, signal: AbortSignal, range: ByteRange) {
	const reader = media.read(range.start, range.end).getReader();
	let stopped = false;
	const finish = () => {
		stopped = true;
		signal.removeEventListener('abort', abort);
	};
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const abort = () => {
		finish();
		controller.error(signal.reason);
		// An already failed source can reject cancellation; the body carries the abort error.
		void reader.cancel(signal.reason).catch(() => undefined);
	};
	return new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) {
					abort();
				}
			},
			async pull() {
				try {
					const item = await reader.read();
					if (stopped) {
						return;
					}
					if (item.done) {
						finish();
						controller.close();
						return;
					}
					controller.enqueue(item.value);
				} catch (error) {
					if (!stopped) {
						finish();
						controller.error(error);
					}
				}
			},
			cancel(reason) {
				finish();
				return reader.cancel(reason);
			}
		},
		{ highWaterMark: 0 }
	);
}

function mediaResponse(media: OpenMedia, request: Request, headers: Headers) {
	headers.set('accept-ranges', 'bytes');
	if (request.headers.get('if-none-match') === media.etag) {
		return new Response(null, { status: 304, headers });
	}
	const ifRange = request.headers.get('if-range');
	const range = byteRange(
		ifRange === null || ifRange === media.etag ? request.headers.get('range') : null,
		media.size
	);
	if (range === 'unsatisfiable') {
		headers.set('cache-control', 'no-store');
		headers.delete('etag');
		headers.set('content-range', `bytes */${media.size}`);
		headers.set('content-length', '0');
		return new Response(null, { status: 416, headers });
	}
	const bounds = range ?? { start: 0, end: media.size };
	headers.set('content-length', String(bounds.end - bounds.start));
	if (range) {
		headers.set('content-range', `bytes ${range.start}-${range.end - 1}/${media.size}`);
	}
	return new Response(mediaBody(media, request.signal, bounds), {
		status: range ? 206 : 200,
		headers
	});
}

export const GET: RequestHandler = ({ params, request }) => {
	try {
		const fingerprint = syncHash(params.hash);
		const store = serverStorage();
		const runtime = new RuntimeContent(store.connection);
		const media = runtime.isV2Media(params.id, fingerprint)
			? runtime.openMedia(params.id, fingerprint)
			: null;
		if (media?.objectId) {
			return mediaResponse(media, request, assetHeaders(media.mime, media.etag));
		}
		const asset = storageAsset(store, params.id, fingerprint);
		if (!asset) {
			return new Response(null, { status: 404 });
		}
		const headers = assetHeaders(asset.mime, `"${fingerprint}"`);
		if (request.headers.get('if-none-match') === headers.get('etag')) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(Buffer.from(asset.data.slice(asset.data.indexOf(',') + 1), 'base64'), {
			headers
		});
	} catch {
		return new Response(null, { status: 400 });
	}
};
