import type Database from 'better-sqlite3';

import { createHash } from 'node:crypto';

import schema from '#lib/storage/runtime-content.sql?raw';

export const RUNTIME_SCHEMA = schema;
export const runtimeHash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class RuntimeContent {
	constructor(private db: Database.Database) {
		db.exec(RUNTIME_SCHEMA);
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
		const blobId = existing?.id ?? hash;
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
}
