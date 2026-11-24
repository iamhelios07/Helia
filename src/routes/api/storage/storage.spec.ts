import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { GAME_EDIT_LOCKED, INVALID_EDIT_LOCK } from '#lib/games/edit-lock.js';
import { GamePackageError, isGamePackageErrorCode } from '#lib/games/package/limits.js';
import errorCodes from '#lib/storage/fixtures/install/error-codes.json';

import { POST } from './+server.js';

const execute = vi.hoisted(() => vi.fn());

it.each([GAME_EDIT_LOCKED, INVALID_EDIT_LOCK])('returns lock error code %s', async (code) => {
	execute.mockImplementationOnce(() => {
		throw Error(code);
	});
	const response = await POST(event('http://localhost'));
	expect(response.status).toBe(code === GAME_EDIT_LOCKED ? 403 : 400);
	expect(await response.json()).toEqual({ error: code, errorCode: code });
});
afterEach(() => vi.unstubAllEnvs());
vi.mock('#lib/server/sqlite.js', () => ({
	serverStorage: () => ({ request: execute, requestAsync: execute })
}));
beforeEach(() => {
	execute.mockReset();
	execute.mockReturnValue({ version: 0, records: [] });
});

function event(origin: string | null, body = '{"kind":"list"}', contentType = 'application/json') {
	return {
		url: new URL('http://localhost/api/storage'),
		request: new Request('http://localhost/api/storage', {
			method: 'POST',
			headers: { ...(origin === null ? {} : { origin }), 'content-type': contentType },
			body
		})
	} as Parameters<typeof POST>[0];
}
it('rejects cross-origin, originless and non-JSON requests before accessing storage', async () => {
	for (const request of [
		event('http://foreign'),
		event(null),
		event('http://localhost', '{}', 'text/plain')
	]) {
		expect((await POST(request)).status).toBe(403);
	}
	expect(execute).not.toHaveBeenCalled();
});
it('returns the host reply without allowing caches to retain game data', async () => {
	const response = await POST(event('http://localhost'));
	expect(await response.json()).toEqual({ version: 0, records: [] });
	expect(response.headers.get('cache-control')).toBe('no-store');
});
it('returns conflicts with status 409 and hides raw database errors', async () => {
	execute.mockImplementationOnce(() => {
		throw new Error('STORAGE_CONFLICT');
	});
	expect((await POST(event('http://localhost'))).status).toBe(409);
	execute.mockImplementationOnce(() => {
		throw new Error('SQL error with private path');
	});
	const response = await POST(event('http://localhost'));
	expect(response.status).toBe(400);
	expect(JSON.stringify(await response.json())).not.toContain('private path');
});
it('rejects malformed JSON before accessing storage', async () => {
	expect((await POST(event('http://localhost', '{'))).status).toBe(400);
	expect(execute).not.toHaveBeenCalled();
});
it.each(errorCodes)(
	'returns package error code %s from asynchronous installation',
	async (code) => {
		if (!isGamePackageErrorCode(code)) {
			throw Error('Unknown shared error code');
		}
		const error = new GamePackageError(code);
		execute.mockRejectedValueOnce(error);
		const response = await POST(event('http://localhost', '{"kind":"install"}'));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: error.message, errorCode: code });
	}
);
it('does not treat an ordinary error message as a package error code', async () => {
	execute.mockImplementationOnce(() => {
		throw Error('staleAcknowledgement');
	});
	const response = await POST(event('http://localhost'));
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: '게임 데이터를 저장하거나 읽을 수 없어요.' });
});
it('uses an explicitly configured public origin behind a proxy', async () => {
	vi.stubEnv('HELIA_ORIGIN', 'http://127.0.0.1:3000');
	expect((await POST(event('http://127.0.0.1:3000'))).status).toBe(200);
	expect((await POST(event('http://foreign'))).status).toBe(403);
});
