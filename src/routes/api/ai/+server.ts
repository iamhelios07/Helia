import { json } from '@sveltejs/kit';
import { serverCredentials } from '#lib/server/credentials.js';
import { hostAILeases } from '#lib/games/ai/leases.js';
import { aiError, AI_LIMITS, parseRoundRequest } from '#lib/games/ai/protocol.js';
import { credentialRecord, credentialId } from '#lib/app/settings/credential-protocol.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		!request.headers.get('content-type')?.startsWith('application/json')
	)
		return json({ error: '허용하지 않는 AI 요청이에요.' }, { status: 403 });
	try {
		const body = await request.text();
		if (new TextEncoder().encode(body).length > AI_LIMITS.wireBytes) throw aiError('limit');
		const input = credentialRecord(JSON.parse(body)),
			gameId = credentialId(input.gameId),
			sessionId = credentialId(input.sessionId);
		if (input.kind === 'begin')
			return json(
				{ lease: hostAILeases.begin(gameId, sessionId) },
				{ headers: { 'cache-control': 'no-store' } }
			);
		const lease = credentialId(input.lease);
		if (input.kind === 'release') {
			hostAILeases.release(lease, gameId, sessionId);
			return json({});
		}
		if (input.kind !== 'round') throw aiError('protocol');
		const round = parseRoundRequest(input.request),
			leaseSignal = hostAILeases.round(lease, gameId, sessionId);
		const abort = new AbortController(),
			signal = AbortSignal.any([
				request.signal,
				leaseSignal,
				abort.signal,
				AbortSignal.timeout(AI_LIMITS.timeoutMs)
			]);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				void serverCredentials()
					.generate(round, signal, (chunk) =>
						controller.enqueue(encoder.encode(JSON.stringify({ chunk }) + '\n'))
					)
					.then(
						() => {
							controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
							controller.close();
						},
						() => {
							try {
								controller.enqueue(
									encoder.encode(JSON.stringify({ error: 'AI 응답을 완료하지 못했어요.' }) + '\n')
								);
								controller.close();
							} catch {
								/* Disconnected. */
							}
						}
					);
			},
			cancel() {
				abort.abort();
				hostAILeases.release(lease, gameId, sessionId);
			}
		});
		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error && /^[가-힣]/u.test(error.message)
						? error.message
						: 'AI 요청을 처리하지 못했어요.'
			},
			{ status: 400, headers: { 'cache-control': 'no-store' } }
		);
	}
};
