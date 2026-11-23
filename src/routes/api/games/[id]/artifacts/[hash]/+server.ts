import { RuntimeContent } from '#lib/server/runtime-content.js';
import { serverStorage } from '#lib/server/sqlite.js';
import { syncHash } from '#lib/storage/sync.js';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) => {
	try {
		const hash = syncHash(params.hash),
			content = new RuntimeContent(serverStorage().connection).readArtifact(params.id, hash);
		if (content === null) {
			return new Response(null, { status: 404 });
		}
		const headers = {
			'content-type': 'application/json',
			'cache-control': 'private, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			etag: `"${hash}"`
		};
		if (request.headers.get('if-none-match') === headers.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(JSON.stringify(content), { headers });
	} catch {
		return new Response(null, { status: 400 });
	}
};
