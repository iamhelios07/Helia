import { json } from '@sveltejs/kit';

import { NETWORK_LIMITS, parseNetworkRequest } from '#lib/games/network/protocol.js';
import { serverGameSecrets } from '#lib/server/game-secrets.js';
import { networkResponse } from '#lib/server/network.js';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		request.headers.get('sec-fetch-site') === 'cross-site' ||
		!request.headers.get('content-type')?.startsWith('application/json')
	) {
		return json({ error: 'Fetch not permitted' }, { status: 403 });
	}
	try {
		// Bound the encoded body while reading, rather than trusting Content-Length.
		const reader = request.body?.getReader();
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		if (!reader) {
			throw new TypeError('Missing request');
		}
		for (;;) {
			const part = await reader.read();
			if (part.done) {
				break;
			}
			size += part.value.byteLength;
			if (size > NETWORK_LIMITS.requestBytes * 1.4 + 32768) {
				await reader.cancel();
				throw new TypeError('Request too large');
			}
			chunks.push(part.value);
		}
		const raw: unknown = JSON.parse(await new Blob(chunks).text());
		const input = parseNetworkRequest(raw);
		const gameId = raw && typeof raw === 'object' && 'gameId' in raw ? raw.gameId : undefined;
		const authorized = serverGameSecrets().authorize(gameId, input.url, input.headers);
		return networkResponse(
			{ ...input, headers: authorized.headers },
			request.signal,
			authorized.values
		);
	} catch {
		return json(
			{ error: 'Invalid fetch request' },
			{ status: 400, headers: { 'cache-control': 'no-store' } }
		);
	}
};
