import type Database from 'better-sqlite3';

import { createHash, randomUUID } from 'node:crypto';

import { parseGame, type Game } from '#lib/games/model.js';
import { canonicalReleaseContent, gameReleaseContent } from '#lib/games/release-content.js';
import { validateGameReleaseContent } from '#lib/games/versioning-validation.js';
import {
	originalGameId,
	type GameReleaseContent,
	type GameReleaseSummary,
	type GameVersioning
} from '#lib/games/versioning.js';
import releaseSchema from '#lib/storage/game-releases.sql?raw';
import { CONFLICT, type StorageReply, type StorageRequest } from '#lib/storage/protocol.js';

type ReleaseRequest = Extract<StorageRequest, { kind: 'versioning' }>;
type ContentRequest = Exclude<ReleaseRequest, { action: 'getRelease' }>;
type SavedGame = { value: string; version: number };
type ReleaseRow = GameReleaseSummary & { content?: string };
const summaryColumns = `id, original_game_id AS originalGameId, content_version AS contentVersion,
 content_hash AS contentHash, created_at AS createdAt`;

function releaseContent(db: Database.Database, game: Game) {
	originalGameId(game.originalGameId);
	const content = gameReleaseContent(game, (reference) => {
		const blob = db
			.prepare('SELECT value FROM blobs WHERE game_id=? AND id=?')
			.get(game.id, reference.slice(12)) as { value: string } | undefined;
		if (!blob) {
			throw Error('Release asset unavailable');
		}
		return (JSON.parse(blob.value) as { data: string }).data;
	});
	validateGameReleaseContent(content);
	return {
		content,
		contentHash: createHash('sha256').update(canonicalReleaseContent(content)).digest('hex')
	};
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
	const previous = db.prepare('SELECT value FROM games WHERE id=?').get(gameId) as
		{ value: string } | undefined;
	const prior = previous ? parseGame(JSON.parse(previous.value)) : undefined;
	const saved = prior?.originalGameId;
	if (saved && game.originalGameId && saved !== game.originalGameId) {
		throw Error('Original game identity is immutable');
	}
	// Normal writes cannot add, change or remove host-owned package provenance.
	const { installedFrom: _untrusted, ...content } = game;
	void _untrusted;
	return {
		...content,
		originalGameId: originalGameId(saved ?? game.originalGameId ?? randomUUID()),
		...(prior?.installedFrom === undefined ? {} : { installedFrom: prior.installedFrom })
	};
}

class GameReleases {
	private game;
	private content: GameReleaseContent;
	private contentHash: string;
	constructor(
		private db: Database.Database,
		private request: ContentRequest,
		private saved: SavedGame
	) {
		this.game = parseGame(JSON.parse(saved.value));
		const current = releaseContent(db, this.game);
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

/** Called inside the host's IMMEDIATE transaction: digest, duplicate check and selection are atomic. */
export function gameReleases(db: Database.Database, request: ReleaseRequest): StorageReply {
	const saved = db.prepare('SELECT value, version FROM games WHERE id=?').get(request.gameId) as
		SavedGame | undefined;
	if (!saved) {
		throw Error('Game not found');
	}
	if (request.action === 'getRelease') {
		const row = db
			.prepare(`SELECT ${summaryColumns}, content FROM game_releases WHERE game_id=? AND id=?`)
			.get(request.gameId, request.releaseId) as ReleaseRow | undefined;
		if (!row?.content) {
			throw Error('Game release not found');
		}
		return {
			version: saved.version,
			records: [],
			release: { ...row, content: JSON.parse(row.content) as GameReleaseContent }
		};
	}
	return new GameReleases(db, request, saved).execute();
}
