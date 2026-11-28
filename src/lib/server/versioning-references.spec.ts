import type Database from 'better-sqlite3';

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createEditorDraft, editorContent } from '#lib/games/editor.js';
import { encodeGamePackage } from '#lib/games/package/codec.js';
import { GamePackageError } from '#lib/games/package/limits.js';
import { hashGameReleaseContent } from '#lib/games/release-content.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { MediaIdentity } from '#lib/storage/media-identity.js';
import { CONFLICT, storedRecord } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { RuntimeContent } from './runtime-content.js';
import { openStorage } from './sqlite.js';
import { storageAsset, storageSyncAsync } from './storage-sync.js';

let directory: string;
let store: ReturnType<typeof openStorage>;
let repo: ReturnType<typeof createGameRepository>;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-version-references-'));
	store = openStorage(join(directory, 'game.sqlite'));
	repo = createGameRepository(
		synchronizedStorage(
			async (request) => structuredClone(await storageSyncAsync(store, request)),
			async (gameId, hash) => {
				const asset = storageAsset(store, gameId, hash);
				if (!asset) {
					throw Error('Missing media');
				}
				return asset.data;
			}
		)
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

const chunkSize = 1024 * 1024;
/** Seed a ready v2 object plus its owning blob, mirroring the runtime-content media fixtures. */
function seedMedia(db: Database.Database, gameId: string, bytes: Uint8Array, mime = 'image/png') {
	const identity = new MediaIdentity(gameId, mime).update(bytes).digest();
	const objectId = `object-${identity.blobId}`;
	db.prepare(
		"INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?,?,'ready',?,?,?,?,?)"
	).run(objectId, gameId, bytes.length, chunkSize, identity.raw, identity.crc, '2026-11-28');
	const insert = db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)');
	for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index++) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		insert.run(objectId, index, createHash('sha256').update(chunk).digest('hex'), chunk);
	}
	const blob = {
		schemaVersion: 2,
		id: identity.blobId,
		gameId,
		mime,
		object: identity.raw,
		size: bytes.length
	};
	db.prepare('INSERT OR REPLACE INTO blobs VALUES(?,?,?)').run(
		blob.id,
		gameId,
		JSON.stringify(blob)
	);
	for (const hash of [identity.assetHash, identity.blobId]) {
		db.prepare('INSERT OR REPLACE INTO runtime_assets VALUES(?,?,?)').run(gameId, hash, blob.id);
	}
	return { blob, identity };
}

function referenceResource(blobId: string, mime = 'image/png') {
	return { portrait: { name: 'images/portrait.png', mime, data: `helia-asset:${blobId}` } };
}

/** The package error code a synchronous write throws, or undefined when it is accepted. */
function packageCode(fn: () => unknown): string | undefined {
	try {
		fn();
		return undefined;
	} catch (error) {
		return (error as GamePackageError).code;
	}
}

async function referenceGame(bytes: Uint8Array = Uint8Array.from([1, 2, 3])) {
	const game = await repo.createGame({ title: 'Referenced', genre: '', description: '' });
	const { blob, identity } = seedMedia(store.connection, game.id, bytes);
	const base = editorContent(game);
	await repo.applyGameDraft(game.id, {
		baseContent: base,
		content: { ...base, resources: referenceResource(blob.id) }
	});
	return { game, blob, identity, bytes };
}

it('stores a reference release, confirms host asset metadata and verifies the streamed digest', async () => {
	const { game, blob, identity, bytes } = await referenceGame();
	const result = await repo.createGameRelease(game.id, '1.0.0');
	if (result.kind !== 'released' || !result.state.currentRelease) {
		throw Error('Expected release');
	}
	const releaseId = result.state.currentRelease.id;
	const frozen = await repo.getGameRelease(game.id, releaseId);
	// The stored release keeps the reference instead of inline bytes.
	expect(frozen.content.resources?.portrait.data).toBe(`helia-asset:${blob.id}`);
	expect(frozen.assets).toEqual({
		[blob.id]: { mime: 'image/png', size: bytes.length, sha256: identity.raw }
	});
	const verification = await repo.verifyRelease(game.id, releaseId);
	expect(verification.valid).toBe(true);
	expect(verification.contentHash).toBe(result.state.currentRelease.contentHash);
	// Streaming the referenced bytes must equal hashing the same bytes inline.
	const inline = {
		...frozen.content,
		resources: {
			portrait: {
				...frozen.content.resources!.portrait,
				data: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
			}
		}
	};
	expect(await hashGameReleaseContent(inline)).toBe(verification.contentHash);
});

it.each(['changed', 'truncated', 'missing'])(
	'detects %s stored v2 bytes during release verification',
	async (damage) => {
		const { game } = await referenceGame();
		const result = await repo.createGameRelease(game.id, '1.0.0');
		if (result.kind !== 'released' || !result.state.currentRelease) {
			throw Error('Expected release');
		}
		if (damage === 'missing') {
			store.connection.prepare('DELETE FROM media_chunks').run();
		} else {
			store.connection
				.prepare('UPDATE media_chunks SET data=?')
				.run(Buffer.from(damage === 'changed' ? [3, 2, 1] : [1, 2]));
		}
		const pending = repo.verifyRelease(game.id, result.state.currentRelease.id);
		if (damage === 'changed') {
			expect(await pending).toMatchObject({ valid: false });
		} else {
			await expect(pending).rejects.toMatchObject({ code: 'missingAsset' });
		}
		expect(store.connection.prepare('SELECT count(*) FROM media_leases').pluck().get()).toBe(0);
	}
);

it('renews all read leases while streaming longer than their original lifetime', async () => {
	const { game, blob } = await referenceGame(new Uint8Array(chunkSize * 4));
	const second = seedMedia(store.connection, game.id, new Uint8Array([7]));
	const current = (await repo.getGameWorkspace(game.id))!.game;
	await repo.applyGameDraft(game.id, {
		baseContent: editorContent(current),
		content: {
			...editorContent(current),
			resources: {
				...referenceResource(blob.id),
				second: { ...referenceResource(second.blob.id).portrait, name: 'images/second.png' }
			}
		}
	});
	let time = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => time);
	const original = RuntimeContent.prototype.openMedia;
	vi.spyOn(RuntimeContent.prototype, 'openMedia').mockImplementation(function (
		this: RuntimeContent,
		gameId,
		hash
	) {
		const media = original.call(this, gameId, hash);
		if (!media) {
			return null;
		}
		const read = media.read;
		return {
			...media,
			read: () => {
				const reader = read().getReader();
				return new ReadableStream(
					{
						async pull(controller) {
							const chunk = await reader.read();
							if (chunk.done) {
								controller.close();
								return;
							}
							time += 61000;
							controller.enqueue(chunk.value);
						}
					},
					{ highWaterMark: 0 }
				);
			}
		};
	});
	store.connection.exec(`CREATE TABLE renewals(expires TEXT);
		CREATE TRIGGER renewed AFTER UPDATE ON media_leases BEGIN
		INSERT INTO renewals VALUES(NEW.expires_at); END;`);
	const result = await repo.createGameRelease(game.id, '1.0.0');
	expect(result.kind).toBe('released');
	expect(store.connection.prepare('SELECT count(*) FROM renewals').pluck().get()).toBe(10);
	expect(store.connection.prepare('SELECT max(expires) FROM renewals').pluck().get()).toBe(
		new Date(time + 180000).toISOString()
	);
});

it('accepts a game reference to a blob introduced by the same commit and rolls back mismatches', async () => {
	const game = await repo.createGame({ title: 'Same request', genre: '', description: '' });
	const blob = {
		schemaVersion: 1,
		id: 'a'.repeat(64),
		gameId: game.id,
		mime: 'image/png',
		data: 'data:image/png;base64,AA=='
	};
	const commit = (mime: string) =>
		store.request({
			kind: 'commit',
			gameId: game.id,
			version: 0,
			deleteSessions: [],
			records: [
				storedRecord('games', { ...game, resources: referenceResource(blob.id, mime) }),
				storedRecord('blobs', blob)
			]
		});
	expect(packageCode(() => commit('video/mp4'))).toBe('mediaType');
	expect(store.connection.prepare('SELECT count(*) FROM blobs').pluck().get()).toBe(0);
	expect(commit('image/png').version).toBe(1);
});

it('rejects missing, foreign and MIME-mismatched references at the commit boundary', async () => {
	const game = await repo.createGame({ title: 'Owner', genre: '', description: '' });
	const other = await repo.createGame({ title: 'Other', genre: '', description: '' });
	const { blob } = seedMedia(store.connection, other.id, Uint8Array.from([1]));
	const commit = (resources: Record<string, unknown>) => {
		const reply = store.request({ kind: 'read', gameId: game.id });
		const current = reply.records.find((row) => row.table === 'games')!.value as Record<
			string,
			unknown
		>;
		return () =>
			store.request({
				kind: 'commit',
				gameId: game.id,
				version: reply.version,
				records: [storedRecord('games', { ...current, resources })],
				deleteSessions: []
			});
	};
	const code = packageCode;
	// Missing blob.
	expect(code(commit(referenceResource('0'.repeat(64))))).toBe('missingAsset');
	// A blob owned by another installation is not visible to this game.
	expect(code(commit(referenceResource(blob.id)))).toBe('missingAsset');
	// Same-game blob but a declared MIME that does not match.
	const owned = seedMedia(store.connection, game.id, Uint8Array.from([1]));
	expect(code(commit(referenceResource(owned.blob.id, 'video/mp4')))).toBe('mediaType');
	// The matching reference is accepted.
	expect(code(commit(referenceResource(owned.blob.id)))).toBeUndefined();
});

it('rejects unowned references saved in editor drafts', async () => {
	const game = await repo.createGame({ title: 'Draft', genre: '', description: '' });
	const draft = createEditorDraft(game);
	draft.documents.assets = JSON.stringify(referenceResource('0'.repeat(64)));
	expect(packageCode(() => editorDraftStorage(store.connection).write(game.id, draft, 0))).toBe(
		'missingAsset'
	);
	// A same-game reference with a matching MIME is accepted.
	const owned = seedMedia(store.connection, game.id, Uint8Array.from([1]));
	draft.documents.assets = JSON.stringify(referenceResource(owned.blob.id));
	expect(
		packageCode(() => editorDraftStorage(store.connection).write(game.id, draft, 0))
	).toBeUndefined();
});

it('rejects v1 export of a reference release with the pending-format guidance', async () => {
	const { game } = await referenceGame();
	const result = await repo.createGameRelease(game.id, '1.0.0');
	if (result.kind !== 'released' || !result.state.currentRelease) {
		throw Error('Expected release');
	}
	const frozen = await repo.getGameRelease(game.id, result.state.currentRelease.id);
	await expect(encodeGamePackage({ ...frozen })).rejects.toMatchObject({
		code: 'exportFormatPending',
		message: '이 버전은 새 내보내기 형식이 준비된 뒤 내보낼 수 있어요.'
	});
});

it('requires a fresh content confirmation for reference releases and reports version conflicts', async () => {
	const { game } = await referenceGame();
	await expect(
		repo.createGameRelease(game.id, '1.0.0', { expectedContentHash: '0'.repeat(64) })
	).rejects.toThrow(CONFLICT);
	const first = await repo.createGameRelease(game.id, '1.0.0');
	expect(first.kind).toBe('released');
	await repo.updateGame(game.id, { title: 'Changed', genre: '', description: '' });
	const conflict = await repo.createGameRelease(game.id, '1.0.0');
	if (conflict.kind !== 'conflict') {
		throw Error('Expected version conflict');
	}
	await repo.updateGame(game.id, { title: 'Changed again', genre: '', description: '' });
	await expect(
		repo.createGameRelease(game.id, '1.0.0', {
			ignoreConflict: true,
			expectedContentHash: conflict.incomingHash
		})
	).rejects.toThrow(CONFLICT);
	const next = await repo.createGameRelease(game.id, '1.0.0');
	if (next.kind !== 'conflict') {
		throw Error('Expected updated conflict');
	}
	const kept = await repo.createGameRelease(game.id, '1.0.0', {
		ignoreConflict: true,
		expectedContentHash: next.incomingHash
	});
	expect(kept.kind).toBe('released');
});
