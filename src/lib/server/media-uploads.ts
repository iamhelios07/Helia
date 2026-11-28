import type Database from 'better-sqlite3';

import { createHash, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { GamePackageError, requirePackage } from '#lib/games/package/limits.js';
import { MEDIA_MIMES } from '#lib/games/resources.js';
import { DOCUMENT_OPERATION_LIMITS } from '#lib/games/versioning-validation.js';
import { MediaIdentity, type MediaIdentityResult } from '#lib/storage/media-identity.js';
import {
	isMediaHash,
	MEDIA_CHUNK_SIZE,
	DOCUMENT_MIME,
	bodyRefId,
	type DocumentOperation,
	type DocumentUploadResult,
	type EditBlobResult
} from '#lib/storage/media-protocol.js';

import { deadline, endUpload, type MediaLifetime } from './media-lifetime.js';
import { MediaQueue } from './media-queue.js';

const writes = new MediaQueue(8, 4);
const hashes = new MediaQueue(2);
interface Upload {
	id: string;
	scope: string;
	purpose: string;
	mime: string;
	state: string;
	object_id: string | null;
	size: number;
	chunk_size: number;
	chunk_count: number;
	generation: number;
	declared_sha256: string | null;
	operation: string | null;
	expires_at: string;
	result: string | null;
	error: string | null;
}
/** Identifies a verified document session whose bytes a processing request is about to use. */
export interface DocumentClaim {
	id: string;
	game: string;
	operation: DocumentOperation;
	generation: number;
}
export function uploadError(error: unknown) {
	if (error instanceof GamePackageError) {
		return error;
	}
	const code = error && typeof error === 'object' && 'code' in error && error.code;
	if (code === 'SQLITE_FULL' || code === 'ENOSPC') {
		return new GamePackageError('storageFull');
	}
	if (code === 'SQLITE_BUSY') {
		return new GamePackageError('busy');
	}
	if (error && typeof error === 'object' && 'status' in error && error.status === 413) {
		return new GamePackageError('requestLimit');
	}
	return new GamePackageError('format');
}
function spaceAvailable(db: Database.Database, size: number) {
	if (db.memory) {
		return;
	}
	const { bavail, bsize } = statfsSync(dirname(db.name), { bigint: true });
	requirePackage(bavail * bsize >= BigInt(size) + 16n * 1024n * 1024n, 'storageFull');
}
function beginFields(input: unknown) {
	requirePackage(input && typeof input === 'object');
	const { purpose, mime, size, sha256, label, operation } = input as Record<string, unknown>;
	requirePackage(typeof size === 'number' && Number.isSafeInteger(size) && size > 0, 'mediaSize');
	requirePackage(sha256 === undefined || isMediaHash(sha256), 'integrity');
	requirePackage(label === undefined || (typeof label === 'string' && label.length <= 200));
	if (purpose === 'edit') {
		requirePackage(operation === undefined, 'scopeMismatch');
		requirePackage(typeof mime === 'string' && MEDIA_MIMES.has(mime), 'mediaType');
		return { purpose, mime, size, sha256, label, operation: null };
	}
	requirePackage(purpose === 'document', 'scopeMismatch');
	requirePackage(
		operation === 'draftSave' || operation === 'commit' || operation === 'releaseCreate',
		'scopeMismatch'
	);
	requirePackage(mime === DOCUMENT_MIME, 'mediaType');
	requirePackage(BigInt(size) <= DOCUMENT_OPERATION_LIMITS[operation], 'mediaSize');
	return { purpose, mime, size, sha256, label, operation };
}
export class MediaUploads {
	constructor(
		private db: Database.Database,
		private lifetime: MediaLifetime
	) {}
	private transaction<T>(work: () => T) {
		try {
			return this.db.transaction(work).immediate();
		} catch (error) {
			throw uploadError(error);
		}
	}
	private writable(game: string) {
		requirePackage(
			this.db
				.prepare(
					`SELECT 1 FROM games WHERE id=? AND json_extract(value,'$.trashedAt') IS NULL AND COALESCE(json_type(value,'$.editLock'),'false')='false'`
				)
				.get(game),
			'gameNotWritable'
		);
	}
	private checkOwner(u: Upload) {
		if (u.purpose === 'install' || u.purpose === 'package-content') {
			if (u.object_id) {
				requirePackage(
					!this.db.prepare('SELECT 1 FROM games WHERE id=?').get(u.scope),
					'gameNotWritable'
				);
			}
			return;
		}
		this.writable(u.scope);
	}
	private activity(game: string) {
		// Documents keep a fixed deadline, including the ten minutes granted by Finish.
		this.db
			.prepare(
				"UPDATE media_uploads SET expires_at=? WHERE scope=? AND purpose!='document' AND object_id IS NOT NULL AND expires_at>?"
			)
			.run(deadline(10), game, deadline(0));
	}
	private lookup(game: string, id: string, editOnly = true) {
		const u = this.db.prepare('SELECT * FROM media_uploads WHERE id=?').get(id) as
			Upload | undefined;
		if (!u) {
			return;
		}
		requirePackage(u.scope === game, 'scopeMismatch');
		// Chunk/Finish accept edit and document sessions; Status/Cancel accept any purpose,
		// but never publish a non-edit session as an edit blob.
		requirePackage(!editOnly || u.purpose === 'edit' || u.purpose === 'document', 'scopeMismatch');
		if (u.error !== 'gameDeleted') {
			this.checkOwner(u);
		}
		if (u.expires_at <= deadline(0)) {
			if (!u.object_id) {
				return;
			}
			endUpload(this.db, id, 'expired');
			this.lifetime.wake();
			return this.db.prepare('SELECT * FROM media_uploads WHERE id=?').get(id) as Upload;
		}
		return u;
	}
	private session(game: string, id: string) {
		const u = this.lookup(game, id);
		requirePackage(u, 'uploadMissing');
		return u;
	}
	begin(game: string, input: unknown) {
		// The path is authoritative even if a caller also supplies a scope in JSON.
		if (input && typeof input === 'object' && 'gameId' in input) {
			requirePackage(input.gameId === game, 'scopeMismatch');
		}
		const { purpose, mime, size, label, sha256, operation } = beginFields(input);
		spaceAvailable(this.db, size);
		return this.transaction(() => {
			this.writable(game);
			const id = randomUUID(),
				object = randomUUID(),
				now = deadline(0),
				expiresAt = deadline(10);
			const chunkCount = Math.ceil(size / MEDIA_CHUNK_SIZE);
			this.db
				.prepare(
					"INSERT INTO media_objects(id,game_id,state,size,chunk_size,created_at) VALUES(?,?,'staging',?,?,?)"
				)
				.run(object, game, size, MEDIA_CHUNK_SIZE, now);
			this.activity(game);
			this.db
				.prepare(
					`INSERT INTO media_uploads(id,scope,purpose,mime,label,operation,size,chunk_size,chunk_count,object_id,state,declared_sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'receiving',?,?,?)`
				)
				.run(
					id,
					game,
					purpose,
					mime,
					label ?? null,
					operation,
					size,
					MEDIA_CHUNK_SIZE,
					chunkCount,
					object,
					sha256 ?? null,
					now,
					expiresAt
				);
			return { uploadId: id, chunkSize: MEDIA_CHUNK_SIZE, chunkCount, expiresAt };
		});
	}
	private count(u: Upload) {
		return this.db
			.prepare('SELECT count(*) FROM media_chunks WHERE object_id=?')
			.pluck()
			.get(u.object_id) as number;
	}
	status(game: string, id: string) {
		return this.transaction(() => {
			const u = this.lookup(game, id, false);
			requirePackage(u, 'uploadMissing');
			return {
				state: u.state,
				received: u.object_id ? this.count(u) : u.generation,
				expiresAt: u.expires_at,
				...(u.result && { result: JSON.parse(u.result) }),
				...(u.error && { error: u.error })
			};
		});
	}
	private receiving(game: string, id: string, index: number) {
		const u = this.session(game, id);
		requirePackage(u.state === 'receiving', 'uploadState');
		requirePackage(
			Number.isSafeInteger(index) && index >= 0 && index < u.chunk_count,
			'chunkInvalid'
		);
		return u;
	}
	chunk(
		game: string,
		id: string,
		index: number,
		part: { sha256: unknown; read: (limit: number) => Promise<Uint8Array> }
	) {
		return writes.run(game, async () => {
			const u = this.transaction(() => this.receiving(game, id, index));
			const length = Math.min(u.chunk_size, u.size - index * u.chunk_size);
			requirePackage(isMediaHash(part.sha256), 'chunkInvalid');
			const bytes = await part.read(length);
			requirePackage(
				bytes.length === length && createHash('sha256').update(bytes).digest('hex') === part.sha256,
				'chunkInvalid'
			);
			return this.transaction(() => {
				this.receiving(game, id, index);
				const prev = this.db
					.prepare('SELECT sha256 FROM media_chunks WHERE object_id=? AND idx=?')
					.pluck()
					.get(u.object_id, index);
				requirePackage(prev === undefined || prev === part.sha256, 'chunkConflict');
				if (prev === undefined) {
					this.db
						.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)')
						.run(u.object_id, index, part.sha256, bytes);
					this.db.prepare('UPDATE media_uploads SET generation=generation+1 WHERE id=?').run(id);
				}
				this.activity(game);
				return { received: index };
			});
		});
	}
	cancel(game: string, id: string) {
		return this.transaction(() => {
			const u = this.lookup(game, id, false);
			if (u?.state === 'completed' || u?.state === 'consumed') {
				return { alreadyCompleted: JSON.parse(u.result!) };
			}
			if (u?.object_id) {
				endUpload(this.db, id, 'userCancelled');
				this.lifetime.wake();
			}
			return { cancelled: true };
		});
	}
	private finishable(game: string, id: string, sha: unknown) {
		const u = this.session(game, id);
		// A finished edit session is completed; a finished document session is verified with a result.
		if (u.state === 'completed' || (u.state === 'verified' && u.result)) {
			return u;
		}
		requirePackage(u.state !== 'finishing', 'inProgress');
		requirePackage(u.state === 'receiving', 'uploadState');
		requirePackage(
			sha === undefined || (isMediaHash(sha) && (!u.declared_sha256 || u.declared_sha256 === sha)),
			'integrity'
		);
		u.declared_sha256 ??= (sha as string | undefined) ?? null;
		requirePackage(this.count(u) === u.chunk_count, 'uploadIncomplete');
		return u;
	}
	private startHash(game: string, id: string, sha: unknown) {
		const u = this.finishable(game, id, sha);
		if (u.state !== 'completed') {
			this.db
				.prepare("UPDATE media_uploads SET state='finishing', declared_sha256=? WHERE id=?")
				.run(u.declared_sha256, id);
			this.db
				.prepare("INSERT INTO media_leases VALUES(?,?,?,'read',?)")
				.run(id, game, u.object_id, deadline(3));
			this.activity(game);
		}
		return u;
	}
	private async hash(u: Upload) {
		const identity = new MediaIdentity(u.scope, u.mime, () => {
			const hash = createHash('sha256');
			return { update: (bytes) => hash.update(bytes), digest: () => hash.digest('hex') };
		});
		const chunk = this.db
			.prepare(
				`SELECT data FROM media_uploads u JOIN media_chunks c ON c.object_id=u.object_id WHERE u.id=? AND u.state='finishing' AND c.idx=?`
			)
			.pluck();
		let renewed = Date.now();
		for (let i = 0; i < u.chunk_count; i++) {
			await yieldTurn();
			const bytes = chunk.get(u.id, i);
			requirePackage(Buffer.isBuffer(bytes), 'uploadState');
			identity.update(bytes);
			if (Date.now() - renewed >= 60000) {
				this.transaction(() => {
					this.activity(u.scope);
					this.db.prepare('UPDATE media_leases SET expires_at=? WHERE id=?').run(deadline(3), u.id);
				});
				renewed = Date.now();
			}
		}
		const digest = identity.digest();
		requirePackage(!u.declared_sha256 || u.declared_sha256 === digest.raw, 'integrity');
		return digest;
	}
	private publish(u: Upload, digest: MediaIdentityResult): EditBlobResult {
		const current = this.session(u.scope, u.id);
		requirePackage(
			current.state === 'finishing' && current.generation === u.generation,
			'uploadState'
		);
		const { raw, crc, blobId, assetHash } = digest;
		const duplicate = this.db
			.prepare("SELECT 1 FROM media_objects WHERE game_id=? AND sha256=? AND state='ready'")
			.get(u.scope, raw);
		this.db
			.prepare('UPDATE media_objects SET state=?,sha256=?,crc32=? WHERE id=?')
			.run(duplicate ? 'deleting' : 'ready', raw, crc, u.object_id);
		const blob = {
			schemaVersion: 2,
			id: blobId,
			gameId: u.scope,
			mime: u.mime,
			object: raw,
			size: u.size
		};
		this.db
			.prepare('INSERT OR IGNORE INTO blobs(id,game_id,value) VALUES(?,?,?)')
			.run(blobId, u.scope, JSON.stringify(blob));
		const alias = this.db.prepare(
			'INSERT OR IGNORE INTO runtime_assets(game_id,hash,blob_id) VALUES(?,?,?)'
		);
		for (const hash of [assetHash, blobId]) {
			alias.run(u.scope, hash, blobId);
		}
		const result = {
			kind: 'blob' as const,
			blobId,
			sha256: raw,
			size: u.size,
			mime: u.mime,
			assetHash
		};
		this.db
			.prepare(
				"UPDATE media_uploads SET state='completed',object_id=NULL,result=?,expires_at=? WHERE id=?"
			)
			.run(JSON.stringify(result), deadline(60), u.id);
		this.db.prepare('DELETE FROM media_leases WHERE id=?').run(u.id);
		return result;
	}
	/** A document upload only confirms verification; its bytes never become a blob (§3.9). */
	private publishDocument(u: Upload, digest: MediaIdentityResult): DocumentUploadResult {
		const current = this.session(u.scope, u.id);
		requirePackage(
			current.state === 'finishing' && current.generation === u.generation,
			'uploadState'
		);
		this.db
			.prepare("UPDATE media_objects SET state='verified',sha256=?,crc32=? WHERE id=?")
			.run(digest.raw, digest.crc, u.object_id);
		const result: DocumentUploadResult = {
			kind: 'upload',
			ref: `helia-upload:${u.id}`,
			sha256: digest.raw,
			size: u.size,
			mime: u.mime,
			crc32: digest.crc
		};
		// Finish grants ten fixed minutes for processing or retrying this document.
		this.db
			.prepare("UPDATE media_uploads SET state='verified',result=?,expires_at=? WHERE id=?")
			.run(JSON.stringify(result), deadline(10), u.id);
		this.db.prepare('DELETE FROM media_leases WHERE id=?').run(u.id);
		return result;
	}
	private hashFailed(id: string, code: GamePackageError['code']) {
		this.transaction(() => {
			// Do not overwrite a concurrent Cancel, expiry or purge.
			const active = this.db
				.prepare("SELECT 1 FROM media_uploads WHERE id=? AND state='finishing'")
				.get(id);
			if (active) {
				endUpload(this.db, id, code, 'failed');
			}
		});
	}
	async finish(
		game: string,
		id: string,
		sha?: unknown
	): Promise<EditBlobResult | DocumentUploadResult> {
		const before = this.transaction(() => {
			const u = this.finishable(game, id, sha);
			this.activity(game);
			return u;
		});
		if (before.result) {
			return JSON.parse(before.result);
		}
		return hashes.run(game, async () => {
			const u = this.transaction(() => this.startHash(game, id, sha));
			if (u.result) {
				return JSON.parse(u.result);
			}
			try {
				const digest = await this.hash(u).catch((error: unknown) => {
					const failure = uploadError(error);
					this.hashFailed(id, failure.code);
					throw failure;
				});
				// A failed final guard rolls publication back. Do not overwrite the session.
				return this.transaction(() =>
					u.purpose === 'document' ? this.publishDocument(u, digest) : this.publish(u, digest)
				);
			} catch (error) {
				this.transaction(() => this.db.prepare('DELETE FROM media_leases WHERE id=?').run(id));
				throw error;
			} finally {
				this.lifetime.wake();
			}
		});
	}
	/** Reads a verified document body within its operation budget for a processing request. */
	document(
		game: string,
		ref: unknown,
		operation: DocumentOperation
	): { text: string; claim: DocumentClaim } {
		const id = bodyRefId(ref);
		requirePackage(id, 'format');
		const u = this.transaction(() => {
			const s = this.lookup(game, id!, false);
			requirePackage(s, 'uploadMissing');
			requirePackage(s.purpose === 'document' && s.operation === operation, 'scopeMismatch');
			requirePackage(s.state === 'verified', 'uploadState');
			return s;
		});
		const bytes = Buffer.alloc(u.size);
		const chunk = this.db
			.prepare('SELECT data FROM media_chunks WHERE object_id=? AND idx=?')
			.pluck();
		let offset = 0;
		for (let i = 0; i < u.chunk_count; i++) {
			const part = chunk.get(u.object_id, i);
			requirePackage(Buffer.isBuffer(part), 'uploadState');
			bytes.set(part, offset);
			offset += part.length;
		}
		requirePackage(offset === u.size, 'uploadState');
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			throw new GamePackageError('format');
		}
		return { text, claim: { id: u.id, game, operation, generation: u.generation } };
	}
	/** Marks the document consumed and its bytes deleting. The caller holds the write transaction. */
	consumeDocument(claim: DocumentClaim) {
		const row = this.db
			.prepare('SELECT state,generation,object_id,scope,operation FROM media_uploads WHERE id=?')
			.get(claim.id) as
			| {
					state: string;
					generation: number;
					object_id: string | null;
					scope: string;
					operation: string | null;
			  }
			| undefined;
		requirePackage(
			row &&
				row.state === 'verified' &&
				row.generation === claim.generation &&
				row.object_id &&
				row.scope === claim.game &&
				row.operation === claim.operation,
			'uploadState'
		);
		this.db.prepare("UPDATE media_objects SET state='deleting' WHERE id=?").run(row!.object_id);
		this.db
			.prepare("UPDATE media_uploads SET state='consumed',object_id=NULL,expires_at=? WHERE id=?")
			.run(deadline(60), claim.id);
		this.lifetime.wake();
	}
}
