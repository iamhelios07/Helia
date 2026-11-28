import { metadata, uploadResponse } from '#lib/server/media-http.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, url }) =>
	uploadResponse(request, url, async () =>
		serverStorage().uploads.begin(params.id, await metadata(request))
	);
