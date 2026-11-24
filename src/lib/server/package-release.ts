import type Database from 'better-sqlite3';

import { randomUUID } from 'node:crypto';

import type { GameReleaseContent, GameReleaseSummary } from '#lib/games/versioning.js';
import type {
	ConflictAcknowledgement,
	InstallResult,
	PackageVersionSelection
} from '#lib/storage/install.js';

import { GamePackageError, requirePackage } from '#lib/games/package/limits.js';
import { effectiveContentVersion, parseExistingHashes } from '#lib/storage/install.js';

/** Query only active installations, including all their frozen releases. */
export function packageConflictHashes(
	db: Database.Database,
	identity: { originalGameId: string; contentVersion: string },
	incomingHash?: string
): string[] {
	const rows = db
		.prepare(
			`SELECT DISTINCT r.content_hash AS hash
		FROM game_releases r JOIN games g ON g.id=r.game_id
		WHERE r.original_game_id=? AND r.content_version=?
		AND json_extract(g.value, '$.trashedAt') IS NULL
		AND (? IS NULL OR r.content_hash<>?) ORDER BY r.content_hash LIMIT 10001`
		)
		.all(
			identity.originalGameId,
			identity.contentVersion,
			incomingHash ?? null,
			incomingHash ?? null
		) as { hash: string }[];
	requirePackage(rows.length <= 10000, 'limit');
	return parseExistingHashes(
		rows.map((row) => row.hash),
		incomingHash
	);
}

/** Pure install/upgrade decision. Binding is checked even when K is empty. */
export function packageConflictDecision(
	actual: ConflictAcknowledgement,
	acknowledgement?: ConflictAcknowledgement
): Extract<InstallResult, { kind: 'conflict' }> | null {
	const bound =
		!acknowledgement ||
		(acknowledgement.originalGameId === actual.originalGameId &&
			acknowledgement.contentVersion === actual.contentVersion &&
			acknowledgement.incomingHash === actual.incomingHash);
	if (!bound && actual.existingHashes.length === 0) {
		throw new GamePackageError('staleAcknowledgement');
	}
	if (bound && actual.existingHashes.length === 0) {
		return null;
	}
	if (
		bound &&
		acknowledgement &&
		JSON.stringify(acknowledgement.existingHashes) === JSON.stringify(actual.existingHashes)
	) {
		return null;
	}
	return { kind: 'conflict', ...actual };
}

export function packageReleaseTimestamp(request: PackageVersionSelection, now: string): string {
	return effectiveContentVersion(request) === request.release.contentVersion
		? request.release.createdAt
		: now;
}

/** Called inside an IMMEDIATE transaction by install and, later, upgrade. */
export function storePackageRelease(
	db: Database.Database,
	request: PackageVersionSelection & { gameId: string },
	content: GameReleaseContent,
	now: string
): GameReleaseSummary {
	const version = effectiveContentVersion(request);
	const existing = db
		.prepare(
			`SELECT id, original_game_id AS originalGameId,
		content_version AS contentVersion, content_hash AS contentHash, created_at AS createdAt
		FROM game_releases WHERE game_id=? AND content_version=? AND content_hash=?`
		)
		.get(request.gameId, version, request.release.contentHash) as GameReleaseSummary | undefined;
	if (existing) {
		requirePackage(existing.originalGameId === request.release.originalGameId);
		return existing;
	}
	const count = db
		.prepare('SELECT count(*) FROM game_releases WHERE game_id=?')
		.pluck()
		.get(request.gameId) as number;
	requirePackage(count < 10000, 'limit');
	const release: GameReleaseSummary = {
		id: randomUUID(),
		originalGameId: request.release.originalGameId,
		contentVersion: version,
		contentHash: request.release.contentHash,
		createdAt: packageReleaseTimestamp(request, now)
	};
	db.prepare(
		`INSERT INTO game_releases
		(id,game_id,original_game_id,content_version,content_hash,created_at,content)
		VALUES (?,?,?,?,?,?,?)`
	).run(
		release.id,
		request.gameId,
		release.originalGameId,
		release.contentVersion,
		release.contentHash,
		release.createdAt,
		JSON.stringify(content)
	);
	return release;
}

export function selectPackageRelease(
	db: Database.Database,
	gameId: string,
	releaseId: string
): void {
	db.prepare(
		`INSERT INTO game_release_selection(game_id,release_id) VALUES (?,?)
		ON CONFLICT(game_id) DO UPDATE SET release_id=excluded.release_id`
	).run(gameId, releaseId);
}
