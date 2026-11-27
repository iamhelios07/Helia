import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { MediaIdentity } from '#lib/storage/media-identity.js';
import migration from '#lib/storage/migrations/0000_initial.sql?raw';
import { parseBlob, parseReply, storedRecord } from '#lib/storage/protocol.js';
import runtimeSchema from '#lib/storage/runtime-content.sql?raw';

import { GET } from '../../routes/api/games/[id]/assets/[hash]/+server.js';
import { RuntimeContent, runtimeBlobId } from './runtime-content.js';
import * as sqlite from './sqlite.js';

const stores: ReturnType<typeof sqlite.openStorage>[] = [];
const directories: string[] = [];
const chunkSize = 1024 * 1024;
afterEach(() => {
	vi.restoreAllMocks();
	stores.splice(0).forEach((store) => store.close());
	directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture(filename = ':memory:') {
	const store = sqlite.openStorage(filename);
	stores.push(store);
	store.connection.prepare("INSERT OR IGNORE INTO games(id,value) VALUES('one','{}')").run();
	store.connection.prepare("INSERT OR IGNORE INTO games(id,value) VALUES('two','{}')").run();
	return { store, db: store.connection, runtime: new RuntimeContent(store.connection) };
}

function seed(db: Database.Database, bytes: Buffer, objectId = 'object-one') {
	const identity = new MediaIdentity('one', 'video/mp4').update(bytes).digest();
	db.prepare(
		"INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?,'one','ready',?,?,?,?,?)"
	).run(objectId, bytes.length, chunkSize, identity.raw, identity.crc, '2026-11-28');
	const insert = db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)');
	for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index++) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		const hash = createHash('sha256').update(chunk).digest('hex');
		insert.run(objectId, index, hash, chunk);
	}
	const blob = {
		schemaVersion: 2,
		id: identity.blobId,
		gameId: 'one',
		mime: 'video/mp4',
		object: identity.raw,
		size: bytes.length
	};
	db.prepare('INSERT OR REPLACE INTO blobs VALUES(?,?,?)').run(
		blob.id,
		'one',
		JSON.stringify(blob)
	);
	for (const hash of [identity.assetHash, identity.blobId]) {
		db.prepare('INSERT OR REPLACE INTO runtime_assets VALUES(?,?,?)').run('one', hash, blob.id);
	}
	return { blob, identity };
}

it('migrates an existing version-1 SQLite database and preserves inline media', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'helia-media-'));
	directories.push(directory);
	const filename = join(directory, 'existing.sqlite');
	const old = new Database(filename);
	old.exec(migration);
	old.exec(runtimeSchema);
	old.pragma('user_version = 1');
	old.prepare("INSERT INTO games(id,value) VALUES('one','{}')").run();
	const data = 'data:image/png;base64,AA==';
	const id = runtimeBlobId('one', data);
	const blob = { schemaVersion: 1, id, gameId: 'one', mime: 'image/png', data };
	old.prepare('INSERT INTO blobs VALUES(?,?,?)').run(id, 'one', JSON.stringify(blob));
	old.prepare('INSERT INTO runtime_assets VALUES(?,?,?)').run('one', id, id);
	old.close();
	const { store, db, runtime } = fixture(filename);
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'media_%' ORDER BY name"
		)
		.all();
	expect(tables).toEqual(
		['media_chunks', 'media_leases', 'media_objects', 'media_uploads'].map((name) => ({ name }))
	);
	expect(db.pragma('user_version', { simple: true })).toBe(1);
	expect(runtime.readAsset('one', id)).toEqual(blob);
	expect(parseBlob(blob)).toEqual(blob);
	const media = runtime.openMedia('one', id)!;
	expect(media.objectId).toBeNull();
	expect(media.size).toBe(1);
	expect(new Uint8Array(await new Response(media.read()).arrayBuffer())).toEqual(
		new Uint8Array([0])
	);
	// Initialization is repeatable on already migrated databases.
	const reopened = sqlite.openStorage(filename);
	stores.push(reopened);
	expect(reopened.connection.prepare('SELECT value FROM blobs WHERE id=?').get(id)).toEqual({
		value: JSON.stringify(blob)
	});
	expect(store.connection.open).toBe(true);
});

it.each([1, chunkSize, chunkSize + 1, chunkSize * 2 + 3])(
	'streams v2 media of %i bytes in ordered SQLite chunks',
	async (size) => {
		const { db, runtime } = fixture();
		const bytes = Buffer.alloc(size);
		for (let index = 0; index < size; index++) {
			bytes[index] = index % 251;
		}
		const { blob, identity } = seed(db, bytes);
		expect(storedRecord('blobs', blob).value).toEqual(blob);
		expect(
			parseReply({ version: 0, records: [storedRecord('blobs', blob)] }).records[0].value
		).toEqual(blob);
		const media = runtime.openMedia('one', identity.assetHash)!;
		expect(media).toMatchObject({ mime: 'video/mp4', size, objectId: 'object-one' });
		const reader = media.read().getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const item = await reader.read();
			if (item.done) {
				break;
			}
			chunks.push(item.value);
		}
		expect(chunks.map((chunk) => chunk.byteLength)).toEqual(
			Array.from({ length: Math.ceil(size / chunkSize) }, (_, index) =>
				Math.min(chunkSize, size - index * chunkSize)
			)
		);
		expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
		expect(runtime.openMedia('two', blob.id)).toBeNull();
	}
);

it('pins the object at open time across ready-object replacement and game purge', async () => {
	const { store, db, runtime } = fixture();
	const bytes = Buffer.alloc(chunkSize + 3, 17);
	const { blob } = seed(db, bytes);
	const opened = runtime.openMedia('one', blob.id)!;
	db.prepare("UPDATE media_objects SET state='deleting' WHERE id='object-one'").run();
	seed(db, bytes, 'replacement');
	expect(runtime.openMedia('one', blob.id)!.objectId).toBe('replacement');
	db.prepare(
		"INSERT INTO media_uploads(id,scope,purpose,mime,size,chunk_size,chunk_count,object_id,state,created_at,expires_at) VALUES('upload','one','edit','video/mp4',1,1,1,'replacement','receiving','now','later')"
	).run();
	db.prepare("INSERT INTO media_leases VALUES('read','one','object-one','read','later')").run();
	db.prepare("UPDATE games SET value=? WHERE id='one'").run(
		JSON.stringify({ trashedAt: '2026-11-28' })
	);
	expect(store.request({ kind: 'purge', gameId: 'one' }).records).toEqual([]);
	expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
	expect(db.prepare("SELECT id FROM blobs WHERE game_id='one'").all()).toEqual([]);
	expect(runtime.openMedia('one', blob.id)).toBeNull();
	expect(Buffer.from(await new Response(opened.read()).arrayBuffer()).equals(bytes)).toBe(true);
	expect(db.prepare("SELECT id FROM media_objects WHERE game_id='one'").all()).toHaveLength(2);
});

it('loads chunks lazily and rejects missing or malformed chunks without returning truncated bytes', async () => {
	const { db, runtime } = fixture();
	const { blob } = seed(db, Buffer.alloc(chunkSize + 1, 9));
	const reader = runtime.openMedia('one', blob.id)!.read().getReader();
	db.prepare("DELETE FROM media_chunks WHERE object_id='object-one' AND idx=1").run();
	expect((await reader.read()).value).toHaveLength(chunkSize);
	await expect(reader.read()).rejects.toThrow('Invalid media chunk');
	db.prepare("UPDATE media_chunks SET data=x'01' WHERE object_id='object-one' AND idx=0").run();
	await expect(runtime.openMedia('one', blob.id)!.read().getReader().read()).rejects.toThrow(
		'Invalid media chunk'
	);
});

it('reads byte ranges across chunk boundaries without loading unrelated chunks', async () => {
	const { db, runtime } = fixture();
	const bytes = Buffer.alloc(chunkSize * 2 + 3, 23);
	const { blob } = seed(db, bytes);
	const media = runtime.openMedia('one', blob.id)!;
	expect(media.etag).toBe(`"${blob.id}"`);
	for (const [start, end] of [
		[0, 1],
		[chunkSize - 1, chunkSize + 1],
		[bytes.length - 1, bytes.length],
		[0, 0]
	]) {
		const actual = Buffer.from(await new Response(media.read(start, end)).arrayBuffer());
		expect(actual.equals(bytes.subarray(start, end))).toBe(true);
	}
	for (const [start, end] of [
		[-1, 1],
		[2, 1],
		[0, bytes.length + 1],
		[0.5, 1]
	]) {
		expect(() => media.read(start, end)).toThrow('Invalid media range');
	}
	db.prepare("DELETE FROM media_chunks WHERE object_id='object-one' AND idx<>1").run();
	const actual = Buffer.from(
		await new Response(media.read(chunkSize, chunkSize + 2)).arrayBuffer()
	);
	expect(actual.equals(bytes.subarray(chunkSize, chunkSize + 2))).toBe(true);
});

it('rejects invalid v2 metadata and resolves only same-game ready objects of the declared size', () => {
	const { db, runtime } = fixture();
	const { blob } = seed(db, Buffer.from([1, 2]));
	db.prepare('DELETE FROM runtime_assets').run();
	expect(runtime.openMedia('one', blob.id)!.objectId).toBe('object-one');
	for (const size of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2']) {
		expect(() => parseBlob({ ...blob, size })).toThrow();
	}
	for (const object of ['a'.repeat(63), 'A'.repeat(64), null]) {
		expect(() => parseBlob({ ...blob, object })).toThrow();
	}
	expect(() => parseBlob({ ...blob, mime: 'text/html' })).toThrow();
	db.prepare("UPDATE media_objects SET game_id='two'").run();
	expect(runtime.openMedia('one', blob.id)).toBeNull();
	db.prepare("UPDATE media_objects SET game_id='one',state='verified'").run();
	expect(runtime.openMedia('one', blob.id)).toBeNull();
	db.prepare("UPDATE media_objects SET state='ready',size=3").run();
	expect(() => runtime.openMedia('one', blob.id)).toThrow('Invalid media object');
});

it.each([1, 2])('rejects unsupported MIME when opening v%i media', (schemaVersion) => {
	const { db, runtime } = fixture();
	const { blob } = seed(db, Buffer.from([1]));
	const unsafe = {
		...blob,
		schemaVersion,
		mime: 'text/html',
		data: 'data:text/html;base64,AA=='
	};
	db.prepare('UPDATE blobs SET value=? WHERE id=?').run(JSON.stringify(unsafe), blob.id);
	expect(() => runtime.openMedia('one', blob.id)).toThrow();
});

it('rejects media objects with chunks larger than 1 MiB at open time', () => {
	const { db, runtime } = fixture();
	const { blob } = seed(db, Buffer.from([1]));
	db.prepare('UPDATE media_objects SET chunk_size=?').run(chunkSize + 1);
	expect(() => runtime.openMedia('one', blob.id)).toThrow('Invalid media object');
});

it('prepares the chunk query once per stream', async () => {
	const { db, runtime } = fixture();
	const { blob } = seed(db, Buffer.alloc(chunkSize + 1, 9));
	const media = runtime.openMedia('one', blob.id)!;
	const prepare = vi.spyOn(db, 'prepare');
	const stream = media.read();
	expect(prepare).toHaveBeenCalledExactlyOnceWith(
		'SELECT data FROM media_chunks WHERE object_id=? AND idx=?'
	);
	expect((await new Response(stream).arrayBuffer()).byteLength).toBe(chunkSize + 1);
	expect(prepare).toHaveBeenCalledTimes(1);
});

it('initializes media tables when opening storage without repeating media DDL in RuntimeContent', () => {
	const { db } = fixture();
	const exec = vi.spyOn(db, 'exec');
	new RuntimeContent(db);
	expect(exec.mock.calls.every(([sql]) => !sql.includes('CREATE TABLE IF NOT EXISTS media_'))).toBe(
		true
	);
	expect(db.prepare('SELECT count(*) AS count FROM media_objects').get()).toEqual({ count: 0 });
});

it('enforces object uniqueness, noncascading ownership and upload lifetime CHECKs', () => {
	const { db } = fixture();
	seed(db, Buffer.from([1]));
	const copy =
		"INSERT INTO media_objects SELECT ?,game_id,?,size,chunk_size,sha256,crc32,created_at FROM media_objects WHERE id='object-one'";
	expect(() => db.prepare(copy).run('duplicate', 'ready')).toThrow(/UNIQUE/);
	expect(() => db.prepare(copy).run('staging', 'staging')).not.toThrow();
	expect(() => db.prepare("DELETE FROM media_objects WHERE id='object-one'").run()).toThrow(
		/FOREIGN KEY/
	);
	const upload = db.prepare(
		"INSERT INTO media_uploads(id,scope,purpose,mime,size,chunk_size,chunk_count,object_id,state,created_at,expires_at) VALUES(?,'one','edit','image/png',1,1,1,?,?,'now','later')"
	);
	expect(() => upload.run('missing', null, 'receiving')).toThrow(/CHECK/);
	expect(() => upload.run('done', 'object-one', 'completed')).toThrow(/CHECK/);
	expect(() => upload.run('active', 'object-one', 'receiving')).not.toThrow();
	expect(() => upload.run('complete', null, 'completed')).not.toThrow();
	expect(() =>
		db
			.prepare("INSERT INTO media_leases VALUES('editor','not-installed',NULL,'editor','later')")
			.run()
	).not.toThrow();
});

it('keeps the current web media response bytes and conditional response unchanged', async () => {
	const { store, runtime } = fixture();
	const id = runtime.asset('one', 'image/png', 'data:image/png;base64,AA==');
	vi.spyOn(sqlite, 'serverStorage').mockReturnValue(store);
	const event = {
		params: { id: 'one', hash: id },
		request: new Request(`http://localhost/api/games/one/assets/${id}`)
	} as Parameters<typeof GET>[0];
	const response = await GET(event);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('image/png');
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0]));
	const conditional = {
		...event,
		request: new Request(event.request.url, { headers: { 'if-none-match': `"${id}"` } })
	};
	expect((await GET(conditional)).status).toBe(304);
});
