import { json } from '@sveltejs/kit';

import { FILE_LIMITS, SessionFileError } from '#lib/games/files/model.js';
import { sessionFileStorage } from '#lib/server/session-files.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

function failure(error: unknown) {
	const code = error instanceof SessionFileError ? error.code : 'FILE_UNAVAILABLE';
	return json(
		{ error: code },
		{ status: code === 'FILE_NOT_FOUND' ? 404 : 400, headers: { 'cache-control': 'no-store' } }
	);
}
function allowed(request: Request, url: URL) {
	if (request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin)) {
		throw new SessionFileError('FILE_INPUT');
	}
}
async function bytes(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) {
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			length += next.value.byteLength;
			if (length > FILE_LIMITS.fileBytes) {
				throw new SessionFileError('FILE_INPUT');
			}
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
export const GET: RequestHandler = ({ params, url }) => {
	try {
		const store = sessionFileStorage(serverStorage().connection);
		const scope = { gameId: params.id, sessionId: params.sessionId };
		const ref = url.searchParams.get('ref');
		if (!ref) {
			return json(
				store.list(scope, {
					...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
					...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {})
				}),
				{ headers: { 'cache-control': 'no-store' } }
			);
		}
		if (url.searchParams.has('stat')) {
			return json(store.stat(scope, ref), { headers: { 'cache-control': 'no-store' } });
		}
		const { info, data } = store.read(scope, ref);
		return new Response(new Uint8Array(data), {
			headers: {
				'content-type': info.mime,
				'content-length': String(info.size),
				'content-disposition': 'attachment',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (error) {
		return failure(error);
	}
};
export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		allowed(request, url);
		const data = await bytes(request);
		return json(
			sessionFileStorage(serverStorage().connection).save(
				{ gameId: params.id, sessionId: params.sessionId },
				data,
				url.searchParams.get('name') ?? 'file',
				request.headers.get('content-type') ?? 'application/octet-stream'
			),
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return failure(error);
	}
};
export const DELETE: RequestHandler = ({ params, request, url }) => {
	try {
		allowed(request, url);
		sessionFileStorage(serverStorage().connection).remove(
			{ gameId: params.id, sessionId: params.sessionId },
			url.searchParams.get('ref') ?? ''
		);
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return failure(error);
	}
};
