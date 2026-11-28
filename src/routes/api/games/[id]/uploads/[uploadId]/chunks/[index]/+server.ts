import { requirePackage } from '#lib/games/package/limits.js';
import { readBytes, uploadResponse } from '#lib/server/media-http.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

export const PUT: RequestHandler = ({ params, request, url }) =>
	uploadResponse(request, url, () => {
		requirePackage(
			request.headers.get('content-type') === 'application/octet-stream' &&
				/^(0|[1-9]\d*)$/.test(params.index),
			'chunkInvalid'
		);
		return serverStorage().uploads.chunk(params.id, params.uploadId, Number(params.index), {
			sha256: request.headers.get('x-helia-chunk-sha256'),
			read: (limit) => readBytes(request, limit)
		});
	});
