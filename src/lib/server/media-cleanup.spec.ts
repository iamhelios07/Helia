import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEditorDraft, editorContent } from '#lib/games/editor.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
import { storageSyncAsync } from './storage-sync.js';

let directory: string;
let store: ReturnType<typeof openStorage>;
beforeEach(() => {
	directory = mkdtempSync(join(process.cwd(), 'cleanup-test-'));
	store = openStorage(join(directory, 'storage.sqlite'));
	expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
});
afterEach(() => {
	vi.useRealTimers();
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

const db = () => store.connection;
const transport = synchronizedStorage(
	(input) => storageSyncAsync(store, input),
	async () => {
		throw Error('Unexpected asset hydration');
	}
);
const clean = async () => (await transport({ kind: 'cleanStorage' })).storageCleanup;
const count = (table: string) => db().prepare(`SELECT count(*) FROM ${table}`).pluck().get();
const blobExists = (id: string) =>
	db().prepare('SELECT 1 FROM blobs WHERE id=?').pluck().get(id) === 1;
const objectState = (id: string) =>
	db().prepare('SELECT state FROM media_objects WHERE id=?').pluck().get(id);
const resources = (id: string) => ({
	image: { name: 'image.png', mime: 'image/png', data: `helia-asset:${id}` }
});
const gameRow = (game: string, value: object = {}) =>
	db().prepare('INSERT INTO games(id,value) VALUES(?,?)').run(game, JSON.stringify(value));
const draftRow = (game: string, text: string) =>
	db().prepare('INSERT INTO editor_drafts VALUES(?,1,?)').run(game, text);
const noFiles = {
	cleanedFiles: 0,
	removedBlobs: 0,
	queuedObjects: 0,
	reclaimableBytes: '0',
	skippedEditing: 0,
	skippedUnreadable: 0,
	skippedFailed: 0
};

async function upload(game: string, mime = 'image/png', seed = 1) {
	const bytes = Buffer.from([seed, 2, 3]);
	const { uploadId } = store.uploads.begin(game, { purpose: 'edit', mime, size: bytes.length });
	await store.uploads.chunk(game, uploadId, 0, {
		sha256: createHash('sha256').update(bytes).digest('hex'),
		read: async () => bytes
	});
	const result = await store.uploads.finish(game, uploadId);
	if (result.kind !== 'blob') {
		throw Error('Expected completed edit upload');
	}
	return { ...result, uploadId };
}

const rootFixtures = {
	game: (id: string) =>
		db()
			.prepare("UPDATE games SET value=? WHERE id='g'")
			.run(JSON.stringify({ resources: resources(id) })),
	baseContent: (id: string) =>
		draftRow(
			'g',
			JSON.stringify({ baseContent: { resources: resources(id) }, documents: { assets: '{}' } })
		),
	assets: (id: string) =>
		draftRow(
			'g',
			JSON.stringify({ baseContent: {}, documents: { assets: JSON.stringify(resources(id)) } })
		),
	snapshot: (id: string) =>
		db()
			.prepare("INSERT INTO snapshot_resources VALUES('s','g','snapshot',?)")
			.run(JSON.stringify({ blobId: id })),
	release: (id: string) =>
		db()
			.prepare("INSERT INTO game_releases VALUES('r','g','g','1.0.0','digest','today',?)")
			.run(JSON.stringify({ resources: resources(id) }))
};
it.each(Object.entries(rootFixtures))('keeps the blob rooted only by %s', async (_, root) => {
	gameRow('g');
	const kept = await upload('g');
	const unused = await upload('g', 'image/png', 4);
	db().exec("UPDATE media_uploads SET expires_at='2000'");
	root(kept.blobId);
	expect(await clean()).toEqual({
		...noFiles,
		cleanedFiles: 1,
		removedBlobs: 1,
		queuedObjects: 1,
		reclaimableBytes: '3'
	});
	expect(blobExists(kept.blobId)).toBe(true);
	expect(blobExists(unused.blobId)).toBe(false);
	expect(count('runtime_assets')).toBe(2);
});

it('skips malformed, unknown and editing games independently and rolls back aliases on a failed sweep', async () => {
	for (const id of [
		'a-draft',
		'b-assets',
		'c-scheme',
		'd-edit',
		'e-failure',
		'f-good',
		'g-invalid'
	]) {
		gameRow(id);
		await upload(id);
	}
	draftRow('a-draft', '{');
	draftRow('b-assets', JSON.stringify({ baseContent: {}, documents: { assets: '{' } }));
	db()
		.prepare("UPDATE games SET value=? WHERE id='c-scheme'")
		.run(JSON.stringify({ resources: resources('unknown-id') }));
	db().exec(`UPDATE media_uploads SET expires_at='2000';
		CREATE TRIGGER stop_delete BEFORE UPDATE ON media_objects WHEN OLD.game_id='e-failure'
		BEGIN SELECT RAISE(ABORT, 'fixture failure after deleting aliases and blobs'); END;
		PRAGMA ignore_check_constraints=ON;
		UPDATE games SET value='{' WHERE id='g-invalid';
		PRAGMA ignore_check_constraints=OFF;`);
	store.close();
	store = openStorage(join(directory, 'storage.sqlite'));
	const lease = { kind: 'editorLease', gameId: 'd-edit', leaseId: 'e'.repeat(32) } as const;
	await transport({ ...lease, action: 'renew' });
	expect(await clean()).toMatchObject({
		skippedEditing: 1,
		skippedUnreadable: 4,
		skippedFailed: 1,
		removedBlobs: 1
	});
	expect(db().prepare('SELECT game_id FROM blobs ORDER BY game_id').pluck().all()).toEqual([
		'a-draft',
		'b-assets',
		'c-scheme',
		'd-edit',
		'e-failure',
		'g-invalid'
	]);
	expect(count('runtime_assets')).toBe(12);
	await transport({ ...lease, action: 'release' });
	expect(await clean()).toMatchObject({
		skippedEditing: 0,
		skippedUnreadable: 4,
		skippedFailed: 1,
		removedBlobs: 1
	});
});

it('keeps a shared object, a read-leased object, and v1; releases bytes only on a later manual run', async () => {
	gameRow('g');
	const kept = await upload('g');
	const otherMime = await upload('g', 'image/jpeg');
	const read = await upload('g', 'image/png', 5);
	const readId = db()
		.prepare("SELECT id FROM media_objects WHERE sha256=? AND state='ready'")
		.pluck()
		.get(read.sha256) as string;
	db().prepare("INSERT INTO media_leases VALUES('read','g',?,'read','9999')").run(readId);
	rootFixtures.game(kept.blobId);
	db().exec(`UPDATE media_uploads SET expires_at='2000';
		INSERT INTO blobs VALUES('legacy','g','{"schemaVersion":1}');
		INSERT INTO runtime_assets VALUES('g','legacy','legacy');`);
	expect(await clean()).toEqual({ ...noFiles, cleanedFiles: 2, removedBlobs: 2 });
	expect(blobExists(otherMime.blobId)).toBe(false);
	expect(blobExists(read.blobId)).toBe(false);
	expect(blobExists(kept.blobId)).toBe(true);
	expect(blobExists('legacy')).toBe(true);
	expect(count('runtime_assets')).toBe(3);
	expect(objectState(readId)).toBe('ready');
	db().exec("UPDATE media_leases SET expires_at='2000'");
	store.mediaLifetime.expire();
	expect(objectState(readId)).toBe('ready');
	expect(await clean()).toEqual({
		...noFiles,
		cleanedFiles: 1,
		queuedObjects: 1,
		reclaimableBytes: '3'
	});
});

it('preserves a real completed result for one hour and never sweeps on save, Apply, release, restart or a timer tick', async () => {
	const repo = createGameRepository(transport);
	const game = await repo.createGame({ title: 'Media cleanup', genre: '', description: '' });
	const media = await upload(game.id);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 59 * 60000);
	expect(await clean()).toEqual(noFiles);
	expect(store.uploads.status(game.id, media.uploadId).result).toMatchObject({
		blobId: media.blobId
	});
	vi.setSystemTime(Date.now() + 61000);
	store.mediaLifetime.expire();
	expect(count('media_uploads')).toBe(0);
	const draft = createEditorDraft(game);
	const base = editorContent(game);
	editorDraftStorage(db()).write(game.id, draft, 0);
	expect(blobExists(media.blobId)).toBe(true);
	await repo.applyGameDraft(game.id, { baseContent: base, content: { ...base, title: 'Edited' } });
	expect(blobExists(media.blobId)).toBe(true);
	await repo.createGameRelease(game.id, '1.0.0');
	expect(blobExists(media.blobId)).toBe(true);
	store.close();
	store = openStorage(join(directory, 'storage.sqlite'));
	expect(blobExists(media.blobId)).toBe(true);
	expect(await clean()).toMatchObject({ removedBlobs: 1, queuedObjects: 1, reclaimableBytes: '3' });
	await vi.waitFor(() => expect(count('media_objects')).toBe(0));
	expect(count('media_chunks')).toBe(0);
	expect(count('runtime_assets')).toBe(0);
});

it('queues large objects without touching chunks in the sweep and allows writes between 32-chunk transactions', async () => {
	gameRow('g');
	const bytes = 65 * 1024 * 1024;
	db()
		.exec(`INSERT INTO media_objects VALUES('large','g','ready',${bytes},1048576,'hash',0,'today');
		WITH RECURSIVE idx(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM idx WHERE i<64)
		INSERT INTO media_chunks SELECT 'large',i,'hash',zeroblob(1048576) FROM idx;`);
	store.mediaLifetime.close(); // Cancel the startup wake; only the manual request wakes this queue.
	const wake = vi.spyOn(store.mediaLifetime, 'wake').mockImplementation(() => {});
	expect(await clean()).toMatchObject({
		cleanedFiles: 1,
		queuedObjects: 1,
		reclaimableBytes: String(bytes)
	});
	expect(wake).toHaveBeenCalledOnce();
	expect(count('media_chunks')).toBe(65);
	const start = performance.now();
	expect(store.mediaLifetime.step()).toBe(true);
	const writer = openStorage(join(directory, 'storage.sqlite'));
	try {
		writer.connection.exec("INSERT INTO games(id,value) VALUES('interleaved','{}')");
	} finally {
		writer.close();
	}
	expect(count('media_chunks')).toBe(33);
	expect(performance.now() - start).toBeLessThan(4000);
	expect(store.mediaLifetime.step()).toBe(true);
	expect(count('media_chunks')).toBe(1);
	expect(store.mediaLifetime.step()).toBe(true);
	expect(count('media_objects')).toBe(0);
});

it('renews per-editor leases for 15 minutes and never releases a different tab, game or read lease', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	gameRow('g');
	gameRow('other');
	const lease = { kind: 'editorLease', gameId: 'g', leaseId: 'a'.repeat(32) } as const;
	await transport({ ...lease, action: 'renew' });
	const expires = () =>
		db()
			.prepare('SELECT expires_at FROM media_leases WHERE id=? AND object_id IS NULL')
			.pluck()
			.get('editor:' + lease.leaseId);
	expect(expires()).toBe(new Date(Date.now() + 15 * 60000).toISOString());
	vi.setSystemTime(Date.now() + 5 * 60000);
	await transport({ ...lease, action: 'renew' });
	expect(expires()).toBe(new Date(Date.now() + 15 * 60000).toISOString());
	await transport({ ...lease, gameId: 'other', action: 'release' });
	await expect(transport({ ...lease, gameId: 'other', action: 'renew' })).rejects.toThrow();
	await transport({ ...lease, leaseId: 'b'.repeat(32), action: 'renew' });
	db().exec("INSERT INTO media_leases VALUES('reader','g','object','read','9999')");
	await transport({ ...lease, action: 'release' });
	expect(count('media_leases')).toBe(2);
	expect(await clean()).toMatchObject({ skippedEditing: 1 });
	vi.setSystemTime(Date.now() + 15 * 60000);
	expect(await clean()).toMatchObject({ skippedEditing: 0 });
});
