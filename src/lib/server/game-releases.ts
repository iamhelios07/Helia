import type Database from 'better-sqlite3';

import { createHash, randomUUID } from 'node:crypto';

import { parseGame, type Game } from '#lib/games/model.js';
import { requirePackage } from '#lib/games/package/limits.js';
import {
	canonicalReleaseContent,
	gameReleaseContent,
	hashGameReleaseContentStream
} from '#lib/games/release-content.js';
import { validateResourceListBudget } from '#lib/games/resources.js';
import { validateGameReleaseContent } from '#lib/games/versioning-validation.js';
import {
	originalGameId,
	type GameReleaseAsset,
	type GameReleaseContent,
	type GameReleaseSummary,
	type GameVersioning
} from '#lib/games/versioning.js';
import releaseSchema from '#lib/storage/game-releases.sql?raw';
import { CONFLICT, type StorageReply, type StorageRequest } from '#lib/storage/protocol.js';

import { guardGameContent, guardGameEdit } from './game-edit-lock.js';
import { deadline } from './media-lifetime.js';
import { assertOwnedResources, ownedBlob } from './media-references.js';
import { RuntimeContent } from './runtime-content.js';

type ReleaseRequest = Extract<StorageRequest, { kind: 'versioning' }>;
type ContentRequest = Exclude<ReleaseRequest, { action: 'getRelease' | 'verifyRelease' }>;
type SavedGame = { value: string; version: number };
type ReleaseRow = GameReleaseSummary & { content?: string };
type ReleaseDigest = { content: GameReleaseContent; contentHash: string };
const summaryColumns = `id, original_game_id AS originalGameId, content_version AS contentVersion,
 content_hash AS contentHash, created_at AS createdAt`;

function readSaved(db: Database.Database, gameId: string): SavedGame {
	const saved = db.prepare('SELECT value, version FROM games WHERE id=?').get(gameId) as
		SavedGame | undefined;
	if (!saved) {
		throw Error('Game not found');
	}
	return saved;
}

/** Stored content keeps v2 references and resolves legacy v1 references to their inline bytes. */
function storedReleaseContent(db: Database.Database, game: Game): GameReleaseContent {
	originalGameId(game.originalGameId);
	assertOwnedResources(db, game.id, game.resources ?? {});
	const content = gameReleaseContent(game, (reference) => {
		const blob = ownedBlob(db, game.id, reference.slice(12));
		return blob.schemaVersion === 2 ? reference : blob.data;
	});
	validateGameReleaseContent(content, { write: false });
	return content;
}

function releaseReferences(content: GameReleaseContent): string[] {
	return [
		...new Set(
			Object.values(content.resources ?? {})
				.map((asset) => asset.data)
				.filter((data) => data.startsWith('helia-asset:'))
				.map((data) => data.slice(12))
		)
	];
}

function inlineDigest(content: GameReleaseContent): string {
	return createHash('sha256').update(canonicalReleaseContent(content)).digest('hex');
}

/** Stream the canonical digest outside any write transaction, under read leases (§2.8, §7.3). */
async function streamReleaseDigest(
	db: Database.Database,
	gameId: string,
	content: GameReleaseContent
): Promise<string> {
	const runtime = new RuntimeContent(db);
	const objects = new Map<string, string>();
	for (const blobId of releaseReferences(content)) {
		const media = runtime.openMedia(gameId, blobId);
		requirePackage(media && media.objectId, 'missingAsset');
		objects.set(media.objectId, blobId);
	}
	const leaseIds: string[] = [];
	const insertLease = db.prepare(
		"INSERT INTO media_leases(id,game_id,object_id,kind,expires_at) VALUES(?,?,?,'read',?)"
	);
	for (const objectId of objects.keys()) {
		const id = randomUUID();
		insertLease.run(id, gameId, objectId, deadline(3));
		leaseIds.push(id);
	}
	try {
		return await hashGameReleaseContentStream(content, (reference) => {
			const media = runtime.openMedia(gameId, reference.slice(12));
			requirePackage(media, 'missingAsset');
			return media.read();
		});
	} finally {
		const remove = db.prepare('DELETE FROM media_leases WHERE id=?');
		for (const id of leaseIds) {
			remove.run(id);
		}
	}
}

async function releaseDigest(
	db: Database.Database,
	game: Game,
	content: GameReleaseContent
): Promise<string> {
	return releaseReferences(content).length
		? await streamReleaseDigest(db, game.id, content)
		: inlineDigest(content);
}

function releaseContent(db: Database.Database, game: Game): ReleaseDigest {
	const content = storedReleaseContent(db, game);
	if (releaseReferences(content).length) {
		throw Error('Reference media requires requestAsync for streaming verification');
	}
	return { content, contentHash: inlineDigest(content) };
}

function releaseVersioning(
	game: Game,
	contentHash: string,
	releases: GameReleaseSummary[],
	selectedReleaseId: string | null
): GameVersioning {
	if (releases.length > 10000) {
		throw Error('Release history limit exceeded');
	}
	const currentRelease = releases.find((release) => release.id === selectedReleaseId) ?? null;
	return {
		originalGameId: game.originalGameId!,
		contentHash,
		currentRelease,
		releases,
		modified: currentRelease !== null && currentRelease.contentHash !== contentHash
	};
}

/** Preview supplies a batch-loaded release history while using the normal authoritative digest. */
export function readGameVersioning(
	db: Database.Database,
	game: Game,
	releases: GameReleaseSummary[],
	selectedReleaseId: string | null
): GameVersioning {
	return releaseVersioning(game, releaseContent(db, game).contentHash, releases, selectedReleaseId);
}

/** Reference-bearing working content needs the streaming digest, so preview can await it. */
export async function readGameVersioningAsync(
	db: Database.Database,
	game: Game,
	releases: GameReleaseSummary[],
	selectedReleaseId: string | null
): Promise<GameVersioning> {
	const content = storedReleaseContent(db, game);
	const contentHash = await releaseDigest(db, game, content);
	return releaseVersioning(game, contentHash, releases, selectedReleaseId);
}

/** Additive initialization preserves development databases and independently assigns old games an origin. */
export function initializeGameReleases(db: Database.Database) {
	db.exec(releaseSchema);
	db.transaction(() => {
		const rows = db
			.prepare("SELECT id, value FROM games WHERE json_extract(value, '$.originalGameId') IS NULL")
			.all() as { id: string; value: string }[];
		for (const row of rows) {
			const game = { ...JSON.parse(row.value), originalGameId: randomUUID() };
			db.prepare('UPDATE games SET value=?, version=version+1 WHERE id=?').run(
				JSON.stringify(game),
				row.id
			);
		}
	}).immediate();
}

/** Normal writes cannot reassign a released game's original identity. */
export function preserveOriginalGameId(db: Database.Database, gameId: string, value: unknown) {
	const game = parseGame(value);
	validateResourceListBudget(game.resources ?? {});
	const previous = db.prepare('SELECT value FROM games WHERE id=?').get(gameId) as
		{ value: string } | undefined;
	const prior = previous ? parseGame(JSON.parse(previous.value)) : undefined;
	const saved = prior?.originalGameId;
	guardGameContent(prior, game);
	if (saved && game.originalGameId && saved !== game.originalGameId) {
		throw Error('Original game identity is immutable');
	}
	// Normal writes cannot add, change or remove host-owned package provenance.
	const { installedFrom: _untrusted, editLock: _untrustedLock, ...content } = game;
	void _untrusted;
	void _untrustedLock;
	return {
		...content,
		originalGameId: originalGameId(saved ?? game.originalGameId ?? randomUUID()),
		...(prior?.installedFrom === undefined ? {} : { installedFrom: prior.installedFrom }),
		...(prior?.editLock === undefined ? {} : { editLock: prior.editLock })
	};
}

/** Host-confirmed {mime, size, sha256} for every reference kept in a stored release. */
function releaseAssets(
	db: Database.Database,
	gameId: string,
	content: GameReleaseContent
): Record<string, GameReleaseAsset> | undefined {
	const references = releaseReferences(content);
	if (!references.length) {
		return undefined;
	}
	const assets: Record<string, GameReleaseAsset> = {};
	for (const blobId of references) {
		const blob = ownedBlob(db, gameId, blobId);
		requirePackage(blob.schemaVersion === 2, 'missingAsset');
		assets[blobId] = { mime: blob.mime, size: blob.size, sha256: blob.object };
	}
	return assets;
}

function getReleaseReply(
	db: Database.Database,
	saved: SavedGame,
	request: Extract<ReleaseRequest, { action: 'getRelease' }>
): StorageReply {
	const row = db
		.prepare(`SELECT ${summaryColumns}, content FROM game_releases WHERE game_id=? AND id=?`)
		.get(request.gameId, request.releaseId) as ReleaseRow | undefined;
	if (!row?.content) {
		throw Error('Game release not found');
	}
	const content = JSON.parse(row.content) as GameReleaseContent;
	const assets = releaseAssets(db, request.gameId, content);
	return {
		version: saved.version,
		records: [],
		release: { ...row, content, ...(assets === undefined ? {} : { assets }) }
	};
}

class GameReleases {
	private game;
	private content: GameReleaseContent;
	private contentHash: string;
	constructor(
		private db: Database.Database,
		private request: ContentRequest,
		private saved: SavedGame,
		current: ReleaseDigest
	) {
		this.game = parseGame(JSON.parse(saved.value));
		this.content = current.content;
		this.contentHash = current.contentHash;
	}
	private summaries(): GameReleaseSummary[] {
		const releases = this.db
			.prepare(`SELECT ${summaryColumns} FROM game_releases WHERE game_id=? ORDER BY rowid`)
			.all(this.game.id) as ReleaseRow[];
		if (releases.length > 10000) {
			throw Error('Release history limit exceeded');
		}
		return releases;
	}
	private state(): GameVersioning {
		const releases = this.summaries();
		const selection = this.db
			.prepare('SELECT release_id FROM game_release_selection WHERE game_id=?')
			.get(this.game.id) as { release_id: string } | undefined;
		return releaseVersioning(this.game, this.contentHash, releases, selection?.release_id ?? null);
	}
	private release(request: Extract<ReleaseRequest, { action: 'release' }>): StorageReply {
		validateResourceListBudget(this.game.resources ?? {});
		if (this.game.trashedAt) {
			throw Error('Cannot release a trashed game');
		}
		if (
			request.expectedContentHash !== undefined &&
			request.expectedContentHash !== this.contentHash
		) {
			throw Error(CONFLICT);
		}
		let release = this.summaries().find(
			(row) => row.contentVersion === request.contentVersion && row.contentHash === this.contentHash
		);
		const known = this.db
			.prepare(
				`SELECT DISTINCT content_hash FROM game_releases r JOIN games g ON g.id=r.game_id
 WHERE r.original_game_id=? AND r.content_version=? AND json_extract(g.value, '$.trashedAt') IS NULL`
			)
			.all(this.game.originalGameId, request.contentVersion) as { content_hash: string }[];
		const existingHashes = known
			.map((row) => row.content_hash)
			.filter((hash) => hash !== this.contentHash)
			.sort();
		if (existingHashes.length > 10000) {
			throw Error('Release conflict limit exceeded');
		}
		if (!release && existingHashes.length && !request.ignoreConflict) {
			return this.reply({
				releaseResult: {
					kind: 'conflict',
					contentVersion: request.contentVersion,
					existingHashes,
					incomingHash: this.contentHash
				}
			});
		}
		if (!release) {
			if (this.summaries().length >= 10000) {
				throw Error('Release history limit exceeded');
			}
			release = {
				id: randomUUID(),
				originalGameId: this.game.originalGameId!,
				contentVersion: request.contentVersion,
				contentHash: this.contentHash,
				createdAt: new Date().toISOString()
			};
			this.db
				.prepare(
					'INSERT INTO game_releases(id,game_id,original_game_id,content_version,content_hash,created_at,content) VALUES (?,?,?,?,?,?,?)'
				)
				.run(
					release.id,
					this.game.id,
					release.originalGameId,
					release.contentVersion,
					release.contentHash,
					release.createdAt,
					JSON.stringify(this.content)
				);
		}
		this.db
			.prepare(
				'INSERT INTO game_release_selection(game_id,release_id) VALUES (?,?) ON CONFLICT(game_id) DO UPDATE SET release_id=excluded.release_id'
			)
			.run(this.game.id, release.id);
		return this.reply({ releaseResult: { kind: 'released', state: this.state() } });
	}
	private reply(extra: Partial<StorageReply>): StorageReply {
		return { version: this.saved.version, records: [], ...extra };
	}
	execute(): StorageReply {
		if (this.request.action === 'read') {
			return this.reply({ versioning: this.state() });
		}
		return this.release(this.request);
	}
}

/** Called inside the host's IMMEDIATE transaction for inline content: digest and selection are atomic. */
export function gameReleases(db: Database.Database, request: ReleaseRequest): StorageReply {
	if (request.action === 'release') {
		guardGameEdit(db, request.gameId, 'release');
	}
	const saved = readSaved(db, request.gameId);
	if (request.action === 'getRelease') {
		return getReleaseReply(db, saved, request);
	}
	if (request.action === 'verifyRelease') {
		throw Error('verifyRelease requires requestAsync for streaming verification');
	}
	const current = releaseContent(db, parseGame(JSON.parse(saved.value)));
	return new GameReleases(db, request, saved, current).execute();
}

/**
 * Reference-bearing releases hash outside the write lock (§2.8): read content under a
 * lease, stream the digest, then re-check the version and ownership in a short IMMEDIATE.
 */
export async function gameReleasesAsync(
	db: Database.Database,
	request: ReleaseRequest
): Promise<StorageReply> {
	if (request.action === 'getRelease') {
		return gameReleases(db, request);
	}
	if (request.action === 'verifyRelease') {
		return verifyRelease(db, request);
	}
	const saved = readSaved(db, request.gameId);
	const game = parseGame(JSON.parse(saved.value));
	const content = storedReleaseContent(db, game);
	const contentHash = await releaseDigest(db, game, content);
	const current = { content, contentHash };
	if (request.action === 'read') {
		return db.transaction(() =>
			new GameReleases(db, request, readSaved(db, request.gameId), current).execute()
		)();
	}
	return db
		.transaction(() => {
			const fresh = readSaved(db, request.gameId);
			if (fresh.version !== saved.version) {
				throw Error(CONFLICT);
			}
			guardGameEdit(db, request.gameId, 'release');
			assertOwnedResources(db, game.id, game.resources ?? {});
			return new GameReleases(db, request, fresh, current).execute();
		})
		.immediate();
}

/** Recompute a stored release digest on the host; the client never hashes reference bytes. */
async function verifyRelease(
	db: Database.Database,
	request: Extract<ReleaseRequest, { action: 'verifyRelease' }>
): Promise<StorageReply> {
	const saved = readSaved(db, request.gameId);
	const row = db
		.prepare(
			'SELECT content, content_hash AS contentHash FROM game_releases WHERE game_id=? AND id=?'
		)
		.get(request.gameId, request.releaseId) as { content: string; contentHash: string } | undefined;
	if (!row) {
		throw Error('Game release not found');
	}
	const content = JSON.parse(row.content) as GameReleaseContent;
	const contentHash = await releaseDigest(db, parseGame(JSON.parse(saved.value)), content);
	requirePackage(contentHash === row.contentHash, 'integrity');
	return { version: saved.version, records: [], releaseVerification: { contentHash } };
}
