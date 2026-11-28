import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeContent, runtimeHash } from '#lib/server/runtime-content.js';
import * as sqlite from '#lib/server/sqlite.js';
import { MediaIdentity } from '#lib/storage/media-identity.js';

import { GET } from './+server.js';

const stores: ReturnType<typeof sqlite.openStorage>[] = [];
const chunkSize = 1024 * 1024;
afterEach(() => {
	vi.restoreAllMocks();
	stores.splice(0).forEach((store) => store.close());
});

function fixture(size = 19) {
	const store = sqlite.openStorage(':memory:');
	stores.push(store);
	const db = store.connection;
	db.prepare("INSERT INTO games(id,value) VALUES('one','{}'),('two','{}')").run();
	new RuntimeContent(db);
	const bytes = Buffer.alloc(size);
	for (let index = 0; index < size; index++) {
		bytes[index] = index % 251;
	}
	const identity = new MediaIdentity('one', 'video/mp4').update(bytes).digest();
	db.prepare(
		"INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,created_at) VALUES('object','one','ready',?,?,?,'now')"
	).run(size, chunkSize, identity.raw);
	const insert = db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)');
	for (let offset = 0; offset < size; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		insert.run(
			'object',
			offset / chunkSize,
			createHash('sha256').update(chunk).digest('hex'),
			chunk
		);
	}
	const blob = {
		schemaVersion: 2,
		id: identity.blobId,
		gameId: 'one',
		mime: 'video/mp4',
		object: identity.raw,
		size
	};
	db.prepare('INSERT INTO blobs VALUES(?,?,?)').run(blob.id, 'one', JSON.stringify(blob));
	db.prepare('INSERT INTO runtime_assets VALUES(?,?,?)').run('one', identity.assetHash, blob.id);
	vi.spyOn(sqlite, 'serverStorage').mockReturnValue(store);
	const event = (headers: HeadersInit = {}, signal?: AbortSignal, hash = identity.assetHash) =>
		({
			params: { id: 'one', hash },
			request: new Request(`http://localhost/api/games/one/assets/${hash}`, { headers, signal })
		}) as Parameters<typeof GET>[0];
	return { db, bytes, blob, identity, event };
}

function traceChunkReads(db: ReturnType<typeof sqlite.openStorage>['connection']) {
	const select = db.prepare('SELECT data FROM media_chunks WHERE object_id=? AND idx=?');
	const reads = vi.spyOn(select, 'get');
	const prepare = db.prepare.bind(db);
	vi.spyOn(db, 'prepare').mockImplementation((sql: string) =>
		sql === select.source ? select : prepare(sql)
	);
	return reads;
}

const commonHeaders = (hash: string, mime = 'video/mp4') => ({
	'cache-control': 'private, max-age=31536000, immutable',
	'content-type': mime,
	'cross-origin-resource-policy': 'cross-origin',
	etag: `"${hash}"`,
	'x-content-type-options': 'nosniff'
});

it('streams whole v2 media lazily, with immutable headers and direct blob ID lookup', async () => {
	const f = fixture(chunkSize + 7);
	const reads = traceChunkReads(f.db);
	const response = await GET(f.event({}, undefined, f.blob.id));
	expect(response.status).toBe(200);
	expect(Object.fromEntries(response.headers)).toEqual({
		...commonHeaders(f.blob.id),
		'accept-ranges': 'bytes',
		'content-length': String(f.bytes.length)
	});
	expect(reads).not.toHaveBeenCalled();
	const reader = response.body!.getReader();
	expect((await reader.read()).value).toEqual(f.bytes.subarray(0, chunkSize));
	expect(reads).toHaveBeenCalledExactlyOnceWith('object', 0);
	expect((await reader.read()).value).toEqual(f.bytes.subarray(chunkSize));
	expect((await reader.read()).done).toBe(true);
	expect(reads).toHaveBeenCalledTimes(2);
});

it.each([
	['bytes=0-0', 0, 1],
	['bytes=3-7', 3, 8],
	['bytes=18-18', 18, 19],
	['bytes=18-', 18, 19],
	['bytes=3-', 3, 19],
	['bytes=-4', 15, 19],
	['bytes=-1', 18, 19],
	['bytes=-9999999999999999999999999', 0, 19],
	['bytes=4-9999999999999999999999999', 4, 19],
	['bytes=00003-00007', 3, 8]
])('serves the single range %s with exact bytes and length', async (range, start, end) => {
	const f = fixture();
	const response = await GET(f.event({ range }));
	expect(response.status).toBe(206);
	expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end - 1}/19`);
	expect(response.headers.get('content-length')).toBe(String(end - start));
	expect(response.headers.get('accept-ranges')).toBe('bytes');
	expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(start, end));
});

it.each(['bytes=19-', 'bytes=19-20', 'bytes=9-3', 'bytes=-0', 'bytes=999999999999999999999-'])(
	'returns 416 without reading SQLite chunks for %s',
	async (range) => {
		const f = fixture();
		const reads = traceChunkReads(f.db);
		const response = await GET(f.event({ range }));
		expect(response.status).toBe(416);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
		expect(response.headers.get('content-range')).toBe('bytes */19');
		expect(response.headers.get('content-length')).toBe('0');
		expect(await response.text()).toBe('');
		expect(reads).not.toHaveBeenCalled();
	}
);

it.each(['bytes=0-1,4-5', 'items=0-1', 'bytes=bad', 'bytes=-', 'bytes=1.5-3'])(
	'ignores unsupported or malformed Range %s and sends the whole media',
	async (range) => {
		const f = fixture();
		const response = await GET(f.event({ range }));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-range')).toBeNull();
		expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
	}
);

it.each(['match', 'other', 'weak', 'date'])(
	'honors If-Range only for a matching strong ETag: %s',
	async (kind) => {
		const f = fixture();
		const validators: Record<string, string> = {
			match: `"${f.identity.assetHash}"`,
			other: '"other"',
			weak: `W/"${f.identity.assetHash}"`,
			date: 'Fri, 27 Nov 2026 00:00:00 GMT'
		};
		const response = await GET(f.event({ range: 'bytes=1-2', 'if-range': validators[kind] }));
		expect(response.status).toBe(kind === 'match' ? 206 : 200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			kind === 'match' ? f.bytes.subarray(1, 3) : f.bytes
		);
	}
);

it('checks If-None-Match before Range and returns 304 without reading chunks', async () => {
	const f = fixture();
	const reads = traceChunkReads(f.db);
	const response = await GET(
		f.event({ 'if-none-match': `"${f.identity.assetHash}"`, range: 'bytes=999-' })
	);
	expect(response.status).toBe(304);
	expect(Object.fromEntries(response.headers)).toEqual({
		...commonHeaders(f.identity.assetHash),
		'accept-ranges': 'bytes'
	});
	expect(response.body).toBeNull();
	expect(reads).not.toHaveBeenCalled();
	const different = await GET(f.event({ 'if-none-match': '"different"', range: 'bytes=0-0' }));
	expect(different.status).toBe(206);
	await different.body!.cancel();
});

it('reads a range crossing the 1 MiB boundary, without querying unrelated chunks', async () => {
	const f = fixture(chunkSize * 2 + 7);
	const reads = traceChunkReads(f.db);
	const start = chunkSize - 2;
	const end = chunkSize + 3;
	const response = await GET(f.event({ range: `bytes=${start}-${end - 1}` }));
	expect(response.status).toBe(206);
	expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(start, end));
	expect(reads.mock.calls).toEqual([
		['object', 0],
		['object', 1]
	]);
});

it('stops DB reads when the response body is canceled', async () => {
	const f = fixture(chunkSize * 2 + 7);
	const reads = traceChunkReads(f.db);
	const response = await GET(f.event());
	const reader = response.body!.getReader();
	await reader.read();
	await reader.cancel('disconnected');
	expect((await reader.read()).done).toBe(true);
	expect(reads).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
	'cancels DB reading on request abort (already aborted: %s)',
	async (already) => {
		const f = fixture(chunkSize * 2 + 7);
		const reads = traceChunkReads(f.db);
		const abort = new AbortController();
		if (already) {
			abort.abort();
		}
		const response = await GET(f.event({}, abort.signal));
		const reader = response.body!.getReader();
		if (!already) {
			await reader.read();
			abort.abort();
		}
		await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
		expect(reads).toHaveBeenCalledTimes(already ? 0 : 1);
	}
);

it('errors the response stream if a chunk disappears rather than reporting a complete body', async () => {
	const f = fixture(chunkSize + 7);
	const response = await GET(f.event());
	f.db.prepare("DELETE FROM media_chunks WHERE object_id='object' AND idx=1").run();
	const reader = response.body!.getReader();
	expect((await reader.read()).value).toHaveLength(chunkSize);
	await expect(reader.read()).rejects.toThrow('Invalid media chunk');
});

it('preserves exact v1 bytes and headers, ignoring Range and If-Range', async () => {
	const f = fixture();
	const data = 'data:image/png;base64,AAEC/w==';
	const runtime = new RuntimeContent(f.db);
	const id = runtime.asset('one', 'image/png', data);
	const openMedia = vi.spyOn(RuntimeContent.prototype, 'openMedia');
	for (const hash of [id, runtimeHash(data)]) {
		const response = await GET(
			f.event({ range: 'bytes=1-2', 'if-range': `"${hash}"` }, undefined, hash)
		);
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toEqual(commonHeaders(hash, 'image/png'));
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
		const cached = await GET(f.event({ 'if-none-match': `"${hash}"` }, undefined, hash));
		expect(cached.status).toBe(304);
		expect(Object.fromEntries(cached.headers)).toEqual(commonHeaders(hash, 'image/png'));
	}
	expect(openMedia).not.toHaveBeenCalled();
});

it.each([
	{ schemaVersion: undefined, mime: 'image/png' },
	{ schemaVersion: 1, mime: 'application/octet-stream' }
])('preserves aliased v1 $mime bytes and headers with schema $schemaVersion', async (metadata) => {
	const f = fixture();
	const data = `data:${metadata.mime};base64,AAEC/w==`;
	const hash = runtimeHash(data);
	const blob = { ...metadata, id: runtimeHash(['one', data]), gameId: 'one', data };
	f.db.prepare('INSERT INTO blobs VALUES(?,?,?)').run(blob.id, 'one', JSON.stringify(blob));
	f.db.prepare('INSERT INTO runtime_assets VALUES(?,?,?)').run('one', hash, blob.id);
	const openMedia = vi.spyOn(RuntimeContent.prototype, 'openMedia');
	const response = await GET(f.event({ range: 'bytes=1-2' }, undefined, hash));
	expect(response.status).toBe(200);
	expect(Object.fromEntries(response.headers)).toEqual(commonHeaders(hash, metadata.mime));
	expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
	expect(openMedia).not.toHaveBeenCalled();
});

it('preserves the inline game resource fallback with its existing v1 response', async () => {
	const f = fixture();
	const data = 'data:image/png;base64,AA==';
	f.db
		.prepare("UPDATE games SET value=? WHERE id='one'")
		.run(JSON.stringify({ resources: { icon: { name: 'icon.png', mime: 'image/png', data } } }));
	const hash = runtimeHash(data);
	const response = await GET(f.event({}, undefined, hash));
	expect(response.status).toBe(200);
	expect(Object.fromEntries(response.headers)).toEqual(commonHeaders(hash, 'image/png'));
	expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0]));
});

it('finds unindexed v1 blobs even when v2 blobs precede them in the legacy fallback', async () => {
	const f = fixture();
	const data = 'data:image/png;base64,AQI=';
	new RuntimeContent(f.db).asset('one', 'image/png', data);
	f.db.prepare('DELETE FROM runtime_assets').run();
	const hash = runtimeHash(data);
	const response = await GET(f.event({}, undefined, hash));
	expect(response.status).toBe(200);
	expect(Object.fromEntries(response.headers)).toEqual(commonHeaders(hash, 'image/png'));
	expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2]));
});

it('rejects invalid fingerprints and never serves media from another game', async () => {
	const f = fixture();
	expect((await GET(f.event({}, undefined, 'bad'))).status).toBe(400);
	const other = f.event();
	other.params.id = 'two';
	expect((await GET(other)).status).toBe(404);
});

it('returns 404 for missing media in a game containing v2 blobs', async () => {
	const f = fixture();
	expect((await GET(f.event({}, undefined, 'a'.repeat(64)))).status).toBe(404);
	f.db.prepare("UPDATE media_objects SET state='deleting'").run();
	expect((await GET(f.event())).status).toBe(404);
});

it.each(['blob', 'object'])(
	'returns 400 for corrupt v2 %s metadata without reading chunks',
	async (kind) => {
		const f = fixture();
		if (kind === 'blob') {
			f.db
				.prepare('UPDATE blobs SET value=? WHERE id=?')
				.run(JSON.stringify({ ...f.blob, size: 0 }), f.blob.id);
		} else {
			f.db.prepare("UPDATE media_objects SET size=size+1 WHERE id='object'").run();
		}
		const reads = traceChunkReads(f.db);
		const response = await GET(f.event());
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('');
		expect(reads).not.toHaveBeenCalled();
	}
);
