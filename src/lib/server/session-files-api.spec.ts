import { afterEach, expect, it, vi } from 'vitest';

import { FILE_LIMITS } from '#lib/games/files/model.js';
import { createGameRepository } from '#lib/games/repository-core.js';

import {
	DELETE,
	GET,
	POST
} from '../../routes/api/games/[id]/sessions/[sessionId]/files/+server.js';
import { openStorage } from './sqlite.js';

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof openStorage> | undefined
}));
vi.mock('#lib/server/sqlite.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./sqlite.js')>();
	return { ...original, serverStorage: () => state.database! };
});
afterEach(() => {
	state.database?.close();
	state.database = undefined;
});
async function fixture() {
	state.database = openStorage(':memory:');
	const repo = createGameRepository(async (request) => state.database!.request(request));
	const game = await repo.createGame();
	function event(method: string, query = '', body?: BodyInit, origin = 'http://helia.test') {
		const url = new URL(
			`http://helia.test/api/games/${game.id}/sessions/${game.activeSessionId}/files?${query}`
		);
		return {
			url,
			params: { id: game.id, sessionId: game.activeSessionId },
			request: new Request(url, {
				method,
				headers: { origin, 'content-type': 'application/octet-stream' },
				...(body === undefined ? {} : { body })
			})
		} as Parameters<typeof GET>[0];
	}
	return { repo, game, event };
}
it('uses binary uploads and reads while keeping stat/list responses metadata-only', async () => {
	const f = await fixture();
	const response = await POST(f.event('POST', 'name=file.bin', Uint8Array.of(0, 255, 42)));
	expect(response.status).toBe(200);
	const file = await response.json();
	const binary = await GET(f.event('GET', new URLSearchParams({ ref: file.ref }).toString()));
	expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 255, 42]);
	expect(binary.headers.get('content-disposition')).toBe('attachment');
	const stat = await GET(
		f.event('GET', new URLSearchParams({ ref: file.ref, stat: '1' }).toString())
	);
	expect(await stat.json()).toEqual(file);
	const page = await GET(f.event('GET'));
	expect(await page.json()).toEqual({ files: [file], nextCursor: null });
	expect(
		(await DELETE(f.event('DELETE', new URLSearchParams({ ref: file.ref }).toString()))).status
	).toBe(204);
	expect(
		(await GET(f.event('GET', new URLSearchParams({ ref: file.ref }).toString()))).status
	).toBe(404);
});
it('rejects cross-origin writes, oversized uploads and cross-session references', async () => {
	const f = await fixture();
	expect(
		(await POST(f.event('POST', 'name=bad', new Uint8Array(), 'http://other.test'))).status
	).toBe(400);
	expect(
		(await POST(f.event('POST', 'name=large', new Uint8Array(FILE_LIMITS.fileBytes + 1)))).status
	).toBe(400);
	const saved = await (await POST(f.event('POST', 'name=valid', new Uint8Array([1])))).json();
	const other = await f.repo.createSession(f.game.id);
	const request = f.event('GET', new URLSearchParams({ ref: saved.ref }).toString());
	request.params.sessionId = other.id;
	expect((await GET(request)).status).toBe(404);
	expect((await GET(f.event('GET', 'limit=101'))).status).toBe(400);
});
