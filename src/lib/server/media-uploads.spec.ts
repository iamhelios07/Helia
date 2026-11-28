import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { MediaIdentity } from '#lib/storage/media-identity.js';
import { MEDIA_CHUNK_SIZE as C } from '#lib/storage/media-protocol.js';

import { MediaQueue } from './media-queue.js';
import { RuntimeContent } from './runtime-content.js';
import { openStorage } from './sqlite.js';

const stores: ReturnType<typeof openStorage>[] = [];
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const store of stores.splice(0)) {
		if (store.connection.open) {
			store.close();
		}
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});
function file() {
	const dir = mkdtempSync(join(tmpdir(), 'media-test-'));
	dirs.push(dir);
	return join(dir, 'db.sqlite');
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(path = ':memory:') {
	const store = openStorage(path);
	stores.push(store);
	const { uploads, connection: db, mediaLifetime: life } = store;
	db.exec("INSERT OR IGNORE INTO games(id,value) VALUES('g','{}'),('other','{}')");
	const begin = (size = 1, extra = {}) =>
		uploads.begin('g', { purpose: 'edit', mime: 'image/png', size, ...extra }).uploadId;
	const put = (id: string, index: number, bytes: Uint8Array, sha256 = hash(bytes)) =>
		uploads.chunk('g', id, index, { sha256, read: async () => bytes });
	const finish = async (id: string, sha?: string) => {
		const result = await uploads.finish('g', id, sha);
		if (result.kind !== 'blob') {
			throw Error('expected an edit blob result');
		}
		return result;
	};
	const status = (id: string) => uploads.status('g', id);
	const count = (table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
	const drain = () => {
		while (life.step()) {
			/* one bounded transaction at a time */
		}
	};
	return { store, db, begin, put, finish, status, count, drain, uploads, life };
}
const one = Buffer.from([1]);
it('hashes ordered boundary chunks once, accepts identical retries and replays the completed result', async () => {
	const f = fixture(),
		bytes = Buffer.alloc(C + 2, 17),
		id = f.begin(bytes.length, { sha256: hash(bytes) });
	expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
	await f.put(id, 1, bytes.subarray(C));
	await expect(f.finish(id)).rejects.toMatchObject({ code: 'uploadIncomplete' });
	await expect(f.put(id, 1, one)).rejects.toMatchObject({ code: 'chunkInvalid' });
	await expect(f.put(id, 1, bytes.subarray(C), '0'.repeat(64))).rejects.toMatchObject({
		code: 'chunkInvalid'
	});
	await expect(f.put(id, 1, Buffer.alloc(2))).rejects.toMatchObject({ code: 'chunkConflict' });
	await f.put(id, 0, bytes.subarray(0, C));
	await f.put(id, 0, bytes.subarray(0, C));
	expect(f.status(id)).toMatchObject({ state: 'receiving', received: 2 });
	const work = f.finish(id);
	await Promise.resolve();
	await expect(f.finish(id)).rejects.toMatchObject({ code: 'inProgress' });
	const result = await work;
	expect(result.sha256).toBe(hash(bytes));
	const data = 'data:image/png;base64,' + bytes.toString('base64');
	expect(result.blobId).toBe(hash(Buffer.from(JSON.stringify(['g', data]))));
	expect(result.assetHash).toBe(hash(Buffer.from(JSON.stringify(data))));
	expect(f.uploads.cancel('g', id)).toEqual({ alreadyCompleted: result });
	const duplicate = f.begin(bytes.length);
	await f.put(duplicate, 0, bytes.subarray(0, C));
	await f.put(duplicate, 1, bytes.subarray(C));
	expect(await f.finish(duplicate)).toEqual(result);
	f.drain();
	expect(f.count('media_objects')).toBe(1);
	expect(f.count('blobs')).toBe(1);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 59 * 60000);
	expect(await f.finish(id)).toEqual(result);
	expect(f.status(id).result).toEqual(result);
	vi.setSystemTime(Date.now() + 61000);
	f.life.expire();
	f.drain();
	expect(f.count('media_uploads')).toBe(0);
	expect(f.count('media_chunks')).toBe(2);
	expect(f.count('blobs')).toBe(1);
});
it('guards purpose, scope, safe sizes and editing permission for every operation', async () => {
	const f = fixture(),
		id = f.begin();
	expect(() => f.begin(1, { purpose: 'install' })).toThrow(
		expect.objectContaining({ code: 'scopeMismatch' })
	);
	expect(() => f.begin(1, { mime: 'text/html' })).toThrow(
		expect.objectContaining({ code: 'mediaType' })
	);
	for (const size of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() => f.begin(size)).toThrow(expect.objectContaining({ code: 'mediaSize' }));
	}
	expect(() => f.uploads.cancel('other', id)).toThrow(
		expect.objectContaining({ code: 'scopeMismatch' })
	);
	f.db.exec("UPDATE media_uploads SET purpose='install'");
	await expect(f.finish(id)).rejects.toMatchObject({ code: 'scopeMismatch' });
	f.db.exec(`UPDATE media_uploads SET purpose='edit'; UPDATE games SET value='{"editLock":true}'`);
	for (const op of [() => f.begin(), () => f.status(id), () => f.uploads.cancel('g', id)]) {
		expect(op).toThrow(expect.objectContaining({ code: 'gameNotWritable' }));
	}
	await expect(f.put(id, 0, one)).rejects.toMatchObject({ code: 'gameNotWritable' });
	await expect(f.finish(id)).rejects.toMatchObject({ code: 'gameNotWritable' });
});
it('rejects conflicting declarations before hashing and detaches bytes after failed verification', async () => {
	const f = fixture(),
		id = f.begin(1, { sha256: '0'.repeat(64) });
	await f.put(id, 0, one);
	await expect(f.finish(id, hash(one))).rejects.toMatchObject({ code: 'integrity' });
	expect(f.status(id).state).toBe('receiving');
	expect(f.count('media_leases')).toBe(0);
	await expect(f.finish(id)).rejects.toMatchObject({ code: 'integrity' });
	expect(f.status(id)).toMatchObject({ state: 'failed', error: 'integrity' });
	f.drain();
	expect(f.count('media_chunks')).toBe(0);
	expect(f.count('media_objects')).toBe(0);
});
it('returns storageFull on real SQLITE_FULL without advancing the session', async () => {
	const f = fixture(),
		id = f.begin(C);
	const pages = f.db.pragma('page_count', { simple: true });
	f.db.pragma(`max_page_count=${pages}`);
	await expect(f.put(id, 0, Buffer.alloc(C))).rejects.toMatchObject({ code: 'storageFull' });
	expect(f.status(id).received).toBe(0);
});
it('cancels each active state, interrupting a running Finish before it can publish', async () => {
	const f = fixture();
	for (const state of ['receiving', 'verified', 'finishing']) {
		const id = f.begin();
		await f.put(id, 0, one);
		let work: Promise<unknown> | undefined;
		if (state === 'verified') {
			f.db.prepare("UPDATE media_uploads SET state='verified' WHERE id=?").run(id);
		}
		if (state === 'finishing') {
			work = f.finish(id);
			await Promise.resolve();
		}
		expect(f.status(id).state).toBe(state);
		expect(f.uploads.cancel('g', id)).toEqual({ cancelled: true });
		if (work) {
			await expect(work).rejects.toMatchObject({ code: 'uploadState' });
		}
		expect(f.status(id)).toMatchObject({ state: 'cancelled', error: 'userCancelled' });
	}
	f.drain();
	expect(f.count('media_leases')).toBe(0);
	expect(f.count('blobs')).toBe(0);
	expect(f.count('media_objects')).toBe(0);
});
it.each(['purge', 'trash', 'editLock'])(
	'rechecks %s at publication after reading the last chunk',
	async (change) => {
		const f = fixture(),
			id = f.begin();
		await f.put(id, 0, one);
		const object = f.db.prepare('SELECT object_id FROM media_uploads').pluck().get();
		const digest = MediaIdentity.prototype.digest;
		vi.spyOn(MediaIdentity.prototype, 'digest').mockImplementationOnce(function (
			this: MediaIdentity
		) {
			const value = change === 'editLock' ? { editLock: true } : { trashedAt: 'today' };
			f.db.prepare('UPDATE games SET value=? WHERE id=?').run(JSON.stringify(value), 'g');
			if (change === 'purge') {
				f.store.request({ kind: 'purge', gameId: 'g' });
			}
			return digest.call(this);
		});
		const purged = change === 'purge';
		await expect(f.finish(id)).rejects.toMatchObject({
			code: purged ? 'uploadState' : 'gameNotWritable'
		});
		expect(f.db.prepare('SELECT state,object_id,error,result FROM media_uploads').get()).toEqual({
			state: purged ? 'cancelled' : 'finishing',
			object_id: purged ? null : object,
			error: purged ? 'gameDeleted' : null,
			result: null
		});
		expect(f.db.prepare('SELECT state FROM media_objects WHERE id=?').pluck().get(object)).toBe(
			purged ? 'deleting' : 'staging'
		);
		for (const table of ['blobs', 'runtime_assets', 'media_leases']) {
			expect(f.count(table)).toBe(0);
		}
		f.drain();
		expect(f.count('media_chunks')).toBe(purged ? 0 : 1);
	}
);
it('renews the scope and read lease at 60 seconds while Finish is between chunks', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const f = fixture(),
		sibling = f.begin(),
		id = f.begin(C + 1);
	await f.put(id, 0, Buffer.alloc(C));
	await f.put(id, 1, one);
	const work = f.finish(id);
	await Promise.resolve(); // Hash has claimed its lease and yielded before the first read.
	const lease = () =>
		f.db.prepare('SELECT expires_at FROM media_leases WHERE id=?').pluck().get(id);
	const start = Date.now();
	const time = (minutes: number) => new Date(start + minutes * 60000).toISOString();
	expect(lease()).toBe(time(3));
	expect(f.status(sibling).expiresAt).toBe(time(10));
	vi.setSystemTime(start + 60000);
	await nextTurn();
	expect(lease()).toBe(time(4));
	for (const session of [id, sibling]) {
		expect(f.status(session).expiresAt).toBe(time(11));
	}
	await work;
	expect(lease()).toBeUndefined();
});
it('cancels a verified install session without claiming it as an edit upload', async () => {
	const f = fixture(),
		id = f.begin();
	await f.put(id, 0, one);
	f.db.exec(
		"UPDATE media_objects SET game_id=NULL,state='verified'; UPDATE media_uploads SET scope='future',purpose='install',state='verified'"
	);
	await expect(f.uploads.finish('future', id)).rejects.toMatchObject({ code: 'scopeMismatch' });
	expect(f.uploads.status('future', id).state).toBe('verified');
	expect(f.uploads.cancel('future', id)).toEqual({ cancelled: true });
	f.drain();
	expect(f.count('media_objects')).toBe(0);
});
it('restarts without resuming sessions and sweeps both kinds of orphan', async () => {
	const path = file(),
		f = fixture(path),
		ids = [];
	for (const state of ['receiving', 'verified', 'finishing']) {
		const id = f.begin();
		ids.push(id);
		await f.put(id, 0, one);
		f.db.prepare('UPDATE media_uploads SET state=? WHERE id=?').run(state, id);
	}
	for (const state of ['ready', 'verified', 'staging']) {
		f.db
			.prepare('INSERT INTO media_objects VALUES(?,?,?,?,?,?,?,?)')
			.run(state, state === 'ready' ? 'gone' : 'g', state, 1, 1, 'x', 0, 'now');
	}
	f.store.close();
	const reopened = fixture(path);
	for (const id of ids) {
		expect(reopened.status(id)).toMatchObject({ state: 'cancelled', error: 'restarted' });
	}
	reopened.drain();
	expect(reopened.count('media_objects')).toBe(0);
	expect(reopened.count('media_chunks')).toBe(0);
});
it('renews other verified sessions in the scope, not via Status, and expires stalled hash jobs', () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const f = fixture(),
		verified = f.begin();
	f.db.exec("UPDATE media_uploads SET state='verified'");
	vi.setSystemTime(Date.now() + 9 * 60000);
	const stalled = f.begin();
	f.db.prepare("UPDATE media_uploads SET state='finishing' WHERE id=?").run(stalled);
	vi.setSystemTime(Date.now() + 2 * 60000);
	f.life.expire();
	expect(f.status(verified).state).toBe('verified');
	vi.setSystemTime(Date.now() + 8 * 60000 + 1);
	f.life.expire();
	for (const id of [verified, stalled]) {
		expect(f.status(id)).toMatchObject({ state: 'cancelled', error: 'expired' });
	}
	f.drain();
	expect(f.count('media_objects')).toBe(0);
});
it('purges terminal records first, preserves tombstones and only reclaims unleased bytes', async () => {
	const f = fixture(),
		done = f.begin();
	await f.put(done, 0, one);
	const blob = await f.finish(done);
	const media = new RuntimeContent(f.db).openMedia('g', blob.assetHash)!;
	const active = f.begin(),
		verified = f.begin();
	f.db.prepare("UPDATE media_uploads SET state='verified' WHERE id=?").run(verified);
	f.db
		.prepare(
			"UPDATE media_objects SET state='verified' WHERE id=(SELECT object_id FROM media_uploads WHERE id=?)"
		)
		.run(verified);
	f.db.prepare("INSERT INTO media_leases VALUES('reader','g',?,'read','9999')").run(media.objectId);
	f.db.exec(
		`INSERT INTO media_leases VALUES('editor','g',NULL,'editor','9999');UPDATE games SET value='{"trashedAt":"today"}'`
	);
	f.store.request({ kind: 'purge', gameId: 'g' });
	expect(() => f.status(done)).toThrow(expect.objectContaining({ code: 'uploadMissing' }));
	for (const id of [active, verified]) {
		expect(f.status(id)).toMatchObject({ state: 'cancelled', error: 'gameDeleted' });
	}
	f.drain();
	expect(f.count('media_objects')).toBe(1);
	expect(f.count('media_leases')).toBe(1);
	expect(f.count('blobs')).toBe(0);
	expect(Buffer.from(await new Response(media.read()).arrayBuffer())).toEqual(one);
	f.db.exec('DELETE FROM media_leases');
	f.drain();
	expect(f.count('media_objects')).toBe(0);
	expect(f.count('media_chunks')).toBe(0);
});
it('times out excess chunk readers before buffering and caps the host at eight across games', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	const f = fixture();
	const pending: Promise<unknown>[] = [];
	const gate = Promise.withResolvers<Uint8Array>();
	const read = vi.fn(() => gate.promise);
	const send = (game: string, id: string) =>
		f.uploads.chunk(game, id, 0, { sha256: hash(one), read });
	for (const game of ['g', 'other']) {
		const { uploadId } = f.uploads.begin(game, { purpose: 'edit', mime: 'image/png', size: 1 });
		for (let i = 0; i < 4; i++) {
			pending.push(send(game, uploadId));
		}
		pending.push(expect(send(game, uploadId)).rejects.toMatchObject({ code: 'busy' }));
	}
	await vi.advanceTimersByTimeAsync(29999);
	expect(read).toHaveBeenCalledTimes(8);
	await vi.advanceTimersByTimeAsync(1);
	gate.resolve(one);
	await Promise.all(pending);
	expect(read).toHaveBeenCalledTimes(8);
});

it('queues by available game and global capacity and returns busy on timeout', async () => {
	const queue = new MediaQueue(2, 1, 10);
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const first = queue.run('a', () => gate);
	const blocked = queue.run('a', async () => false);
	const other = queue.run('b', async () => true);
	expect(await other).toBe(true);
	await expect(blocked).rejects.toMatchObject({ code: 'busy' });
	release();
	await first;
	await nextTurn();
});
