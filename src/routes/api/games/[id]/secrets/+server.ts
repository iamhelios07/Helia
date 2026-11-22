import { json } from '@sveltejs/kit';

import { SECRET_ERROR } from '#lib/games/secrets/protocol.js';
import { serverGameSecrets } from '#lib/server/game-secrets.js';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, params }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		request.headers.get('sec-fetch-site') === 'cross-site' ||
		!request.headers.get('content-type')?.startsWith('application/json')
	) {
		return json({ error: SECRET_ERROR }, { status: 403 });
	}
	try {
		const reader = request.body?.getReader();
		if (!reader) {
			throw new TypeError(SECRET_ERROR);
		}
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let bytes = 0;
		for (;;) {
			const part = await reader.read();
			if (part.done) {
				break;
			}
			bytes += part.value.length;
			if (bytes > 64 * 1024) {
				await reader.cancel();
				throw new TypeError(SECRET_ERROR);
			}
			chunks.push(part.value);
		}
		const result = serverGameSecrets().request(
			params.id,
			JSON.parse(await new Blob(chunks).text())
		);
		return json({ result }, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return json({ error: SECRET_ERROR }, { status: 400, headers: { 'cache-control': 'no-store' } });
	}
};
