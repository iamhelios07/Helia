import { json } from '@sveltejs/kit';
import { CONFLICT } from '#lib/storage/protocol.js';
import { serverStorage } from '#lib/server/sqlite.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		!request.headers.get('content-type')?.startsWith('application/json')
	)
		return json({ error: '허용하지 않는 저장 요청이에요.' }, { status: 403 });
	let input: unknown;
	try {
		input = await request.json();
	} catch {
		return json({ error: '저장 요청을 읽을 수 없어요.' }, { status: 400 });
	}
	try {
		return json(serverStorage().request(input), { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		if (error instanceof Error && error.message === CONFLICT)
			return json({ error: CONFLICT }, { status: 409 });
		return json({ error: '게임 데이터를 저장하거나 읽을 수 없어요.' }, { status: 400 });
	}
};
