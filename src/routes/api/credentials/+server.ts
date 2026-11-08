import { json } from '@sveltejs/kit';

import { serverCredentials } from '#lib/server/credentials.js';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		!request.headers.get('content-type')?.startsWith('application/json')
	) {
		return json({ error: '허용하지 않는 연결 요청이에요.' }, { status: 403 });
	}
	let input: unknown;
	try {
		const body = await request.text();
		if (Buffer.byteLength(body) > 256 * 1024) {
			throw new Error('limit');
		}
		input = JSON.parse(body);
	} catch {
		return json({ error: '연결 요청을 읽을 수 없어요.' }, { status: 400 });
	}
	try {
		return json(await serverCredentials().request(input, request.signal), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error && /^[가-힣]/u.test(error.message)
						? error.message
						: '보안 저장소 또는 모델 목록을 사용할 수 없어요.'
			},
			{ status: 400, headers: { 'cache-control': 'no-store' } }
		);
	}
};
