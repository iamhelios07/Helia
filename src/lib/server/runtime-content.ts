import type Database from 'better-sqlite3';

import { createHash } from 'node:crypto';

import { MEDIA_MIMES } from '#lib/games/resources.js';
import { parseBlob } from '#lib/storage/protocol.js';
import schema from '#lib/storage/runtime-content.sql?raw';

export const RUNTIME_SCHEMA = schema;
export const runtimeHash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Game-owned blob ID for runtime media. `blobs.id` is a global primary key, so the ID must
 * include the game. It matches `contentHash([gameId, data])` and the desktop host.
 * The media URL hash (`runtimeHash(data)`) stays game-independent.
 */
export const runtimeBlobId = (gameId: string, data: string) => runtimeHash([gameId, data]);

export interface OpenMedia {
	mime: string;
	size: number;
	etag: string;
	/** Resolved once at open time. Null for the existing inline v1 path. */
	objectId: string | null;
	/** Byte interval [start, end); omitted bounds read the entire media. */
	read(start?: number, end?: number): ReadableStream<Uint8Array>;
}

interface MediaObject {
	id: string;
	size: number;
	chunk_size: number;
}

/** Each pull loads exactly one chunk, using the already resolved object ID. */
function mediaStream(
	db: Database.Database,
	object: MediaObject,
	start: number,
	end: number
): ReadableStream<Uint8Array> {
	let offset = start;
	const select = db.prepare('SELECT data FROM media_chunks WHERE object_id=? AND idx=?');
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (offset === end) {
					controller.close();
					return;
				}
				const index = Math.floor(offset / object.chunk_size);
				const chunk = select.get(object.id, index) as { data: Buffer } | undefined;
				const chunkStart = index * object.chunk_size;
				const expected = Math.min(object.chunk_size, object.size - chunkStart);
				if (!chunk || chunk.data.byteLength !== expected) {
					throw Error('Invalid media chunk');
				}
				const bytes = chunk.data.subarray(
					offset - chunkStart,
					Math.min(expected, end - chunkStart)
				);
				offset += bytes.byteLength;
				controller.enqueue(bytes);
				if (offset === end) {
					controller.close();
				}
			}
		},
		{ highWaterMark: 0 }
	);
}

function mediaRange(size: number, start: number, end: number): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start > end ||
		end > size
	) {
		throw Error('Invalid media range');
	}
}

export class RuntimeContent {
	constructor(private db: Database.Database) {
		db.exec(RUNTIME_SCHEMA);
	}
	/** Index a validated game-owned v2 blob without reading or copying its bytes. */
	alias(gameId: string, blobId: string): string {
		const row = this.db
			.prepare('SELECT value FROM blobs WHERE game_id=? AND id=?')
			.get(gameId, blobId) as { value: string } | undefined;
		const blob = parseBlob(row ? JSON.parse(row.value) : null);
		if (blob.schemaVersion !== 2 || blob.id !== blobId || blob.gameId !== gameId) {
			throw Error('Invalid media alias');
		}
		// Cleanup can remove the row after validation. SELECT avoids recreating a dangling alias;
		// returning the stable id is safe even when the now-removed asset can no longer resolve.
		this.db
			.prepare(
				`INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id)
				SELECT game_id,id,id FROM blobs WHERE game_id=? AND id=?`
			)
			.run(gameId, blob.id);
		return blob.id;
	}
	artifact(gameId: string, kind: 'logic' | 'ui', value: unknown): string {
		const hash = runtimeHash([kind, value]);
		this.db
			.prepare('INSERT OR IGNORE INTO runtime_artifacts (game_id,hash,kind,value) VALUES (?,?,?,?)')
			.run(gameId, hash, kind, JSON.stringify(value));
		return hash;
	}
	asset(gameId: string, mime: string, data: string): string {
		if (/^helia-asset:[a-f0-9]{64}$/.test(data)) {
			return data.slice(12);
		}
		const hash = runtimeHash(data);
		const indexed = this.db
			.prepare('SELECT blob_id FROM runtime_assets WHERE game_id=? AND hash=?')
			.get(gameId, hash) as { blob_id: string } | undefined;
		if (indexed) {
			this.db
				.prepare('INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id) VALUES (?,?,?)')
				.run(gameId, indexed.blob_id, indexed.blob_id);
			return indexed.blob_id;
		}
		if (!data.startsWith(`data:${mime};base64,`)) {
			throw Error('Invalid runtime asset');
		}
		const existing = this.db
			.prepare("SELECT id FROM blobs WHERE game_id=? AND json_extract(value,'$.data')=?")
			.get(gameId, data) as { id: string } | undefined;
		const blobId = existing?.id ?? runtimeBlobId(gameId, data);
		if (!existing) {
			this.db
				.prepare('INSERT OR IGNORE INTO blobs (id,game_id,value) VALUES (?,?,?)')
				.run(blobId, gameId, JSON.stringify({ schemaVersion: 1, id: blobId, gameId, mime, data }));
		}
		this.db
			.prepare('INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id) VALUES (?,?,?)')
			.run(gameId, hash, blobId);
		this.db
			.prepare('INSERT OR IGNORE INTO runtime_assets (game_id,hash,blob_id) VALUES (?,?,?)')
			.run(gameId, blobId, blobId);
		return blobId;
	}
	readArtifact(gameId: string, hash: string): unknown | null {
		const row = this.db
			.prepare('SELECT value FROM runtime_artifacts WHERE game_id=? AND hash=?')
			.get(gameId, hash) as { value: string } | undefined;
		return row ? JSON.parse(row.value) : null;
	}
	readAsset(gameId: string, hash: string): { mime: string; data: string } | null {
		const row = this.db
			.prepare(
				'SELECT b.value FROM runtime_assets a JOIN blobs b ON b.game_id=a.game_id AND b.id=a.blob_id WHERE a.game_id=? AND a.hash=?'
			)
			.get(gameId, hash) as { value: string } | undefined;
		return row ? (JSON.parse(row.value) as { mime: string; data: string }) : null;
	}
	/** Check the version without loading inline v1 data into JavaScript or decoding it. */
	isV2Media(gameId: string, hash: string): boolean {
		const row = this.db
			.prepare(
				"SELECT json_extract(value,'$.schemaVersion') AS version FROM blobs WHERE game_id=? AND id=COALESCE((SELECT blob_id FROM runtime_assets WHERE game_id=? AND hash=?),?)"
			)
			.get(gameId, gameId, hash, hash) as { version: unknown } | undefined;
		return row?.version === 2;
	}
	/** Resolve a runtime alias or blob ID without materializing v2 bytes. */
	openMedia(gameId: string, hash: string): OpenMedia | null {
		const row = this.db
			.prepare(
				'SELECT value FROM blobs WHERE game_id=? AND id=COALESCE((SELECT blob_id FROM runtime_assets WHERE game_id=? AND hash=?),?)'
			)
			.get(gameId, gameId, hash, hash) as { value: string } | undefined;
		if (!row) {
			return null;
		}
		const blob = parseBlob(JSON.parse(row.value));
		if (blob.gameId !== gameId) {
			throw Error('Invalid media owner');
		}
		if (!MEDIA_MIMES.has(blob.mime)) {
			throw Error('Invalid media MIME');
		}
		if (blob.schemaVersion === 1) {
			// Preserve the existing inline lookup and response decoding path.
			const asset = this.readAsset(gameId, hash) ?? blob;
			const bytes = Buffer.from(asset.data.slice(asset.data.indexOf(',') + 1), 'base64');
			return {
				mime: asset.mime,
				size: bytes.byteLength,
				etag: `"${hash}"`,
				objectId: null,
				read(start = 0, end = bytes.byteLength) {
					mediaRange(bytes.byteLength, start, end);
					return new ReadableStream({
						start(controller) {
							if (start < end) {
								controller.enqueue(bytes.subarray(start, end));
							}
							controller.close();
						}
					});
				}
			};
		}
		const object = this.db
			.prepare(
				"SELECT id,size,chunk_size FROM media_objects WHERE game_id=? AND sha256=? AND state='ready'"
			)
			.get(gameId, blob.object) as MediaObject | undefined;
		if (!object) {
			return null;
		}
		if (
			object.size !== blob.size ||
			!Number.isSafeInteger(object.chunk_size) ||
			object.chunk_size <= 0 ||
			object.chunk_size > 1024 * 1024
		) {
			throw Error('Invalid media object');
		}
		return {
			mime: blob.mime,
			size: blob.size,
			etag: `"${hash}"`,
			objectId: object.id,
			read: (start = 0, end = blob.size) => {
				mediaRange(blob.size, start, end);
				return mediaStream(this.db, object, start, end);
			}
		};
	}
}
