import { uploadResponse } from '#lib/server/media-http.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request, url }) =>
	uploadResponse(request, url, () => serverStorage().uploads.status(params.id, params.uploadId));
export const DELETE: RequestHandler = ({ params, request, url }) =>
	uploadResponse(request, url, () => serverStorage().uploads.cancel(params.id, params.uploadId));
