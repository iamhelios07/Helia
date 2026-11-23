import { serverStorage } from '#lib/server/sqlite.js';
import { storageAsset } from '#lib/server/storage-sync.js';
import { syncHash } from '#lib/storage/sync.js';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) => {
	try {
		const fingerprint = syncHash(params.hash);
		const asset = storageAsset(serverStorage(), params.id, fingerprint);
		if (!asset) {
			return new Response(null, { status: 404 });
		}
		const headers = {
			'content-type': asset.mime,
			'cross-origin-resource-policy': 'cross-origin',
			'cache-control': 'private, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			etag: `"${fingerprint}"`
		};
		if (request.headers.get('if-none-match') === headers.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(Buffer.from(asset.data.slice(asset.data.indexOf(',') + 1), 'base64'), {
			headers
		});
	} catch {
		return new Response(null, { status: 400 });
	}
};
