import type Database from 'better-sqlite3';

import type { GameReleaseSummary } from '#lib/games/versioning.js';
import type { InstallRequest, InstallPreviewRequest } from '#lib/storage/install.js';
import type { StorageReply } from '#lib/storage/protocol.js';

import { parseGame, parseSession } from '#lib/games/model.js';
import { requirePackage } from '#lib/games/package/limits.js';
import { verifyReleaseContent } from '#lib/games/package/verify.js';
import { effectiveContentVersion, packageInstalledFrom } from '#lib/storage/install.js';

import { gameReleases, readGameVersioning } from './game-releases.js';
import {
	packageConflictDecision,
	packageConflictHashes,
	selectPackageRelease,
	storePackageRelease
} from './package-release.js';

export type PreparedInstall = Awaited<ReturnType<typeof prepareInstall>>;

/** No DB state is read before the synchronous transaction begins. */
export async function prepareInstall(request: InstallRequest) {
	const now = new Date().toISOString();
	const verified = await verifyReleaseContent(request.release, {
		gameId: request.gameId,
		sessionId: request.sessionId,
		now
	});
	const game = parseGame({
		...verified.content,
		scripts: verified.content.scripts ?? {},
		schemaVersion: 2,
		id: request.gameId,
		originalGameId: request.release.originalGameId,
		activeSessionId: request.sessionId,
		createdAt: now,
		updatedAt: now,
		installedFrom: packageInstalledFrom(request, now),
		editLock: true
	});
	const session = parseSession({
		schemaVersion: 1,
		id: request.sessionId,
		gameId: request.gameId,
		title: '첫 번째 세션',
		createdAt: now,
		updatedAt: now
	});
	return { request, now, game, session, verified };
}

/** Every state-dependent decision and all four writes share the caller's transaction. */
export function installGame(db: Database.Database, prepared: PreparedInstall): StorageReply {
	const { request, game, session, verified, now } = prepared;
	requirePackage(!db.prepare('SELECT id FROM games WHERE id=?').get(game.id));
	const identity = {
		originalGameId: request.release.originalGameId,
		contentVersion: effectiveContentVersion(request)
	};
	const conflict = packageConflictDecision(
		{
			...identity,
			incomingHash: verified.contentHash,
			existingHashes: packageConflictHashes(db, identity, verified.contentHash)
		},
		request.conflictAcknowledgement
	);
	if (conflict) {
		return { version: 0, records: [], installResult: conflict };
	}
	db.prepare('INSERT INTO games(id,value) VALUES (?,?)').run(game.id, JSON.stringify(game));
	db.prepare('INSERT INTO sessions(id,game_id,value) VALUES (?,?,?)').run(
		session.id,
		game.id,
		JSON.stringify(session)
	);
	const release = storePackageRelease(db, request, verified.content, now);
	selectPackageRelease(db, game.id, release.id);
	requirePackage(
		db
			.prepare(
				`SELECT s.id FROM sessions s JOIN games g ON g.id=s.game_id
		WHERE g.id=? AND s.id=json_extract(g.value,'$.activeSessionId')`
			)
			.get(game.id)
	);
	const versioning = gameReleases(db, {
		kind: 'versioning',
		action: 'read',
		gameId: game.id
	}).versioning!;
	requirePackage(
		versioning.contentHash === verified.contentHash && !versioning.modified,
		'integrity'
	);
	return {
		version: 0,
		records: [],
		installResult: { kind: 'installed', gameId: game.id, versioning }
	};
}

/** Preview is advisory; install always repeats the query while holding the write lock. */
export function installPreview(
	db: Database.Database,
	request: InstallPreviewRequest
): StorageReply {
	const hasDraftTable = Boolean(
		db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='editor_drafts'").get()
	);
	const rows = db
		.prepare(
			`SELECT g.id, g.value, s.release_id AS selectedReleaseId FROM games g
		LEFT JOIN game_release_selection s ON s.game_id=g.id
		WHERE json_extract(g.value,'$.originalGameId')=? AND json_extract(g.value,'$.trashedAt') IS NULL
		ORDER BY g.id LIMIT 10001`
		)
		.all(request.originalGameId) as {
		id: string;
		value: string;
		selectedReleaseId: string | null;
	}[];
	requirePackage(rows.length <= 10000, 'limit');
	const histories = previewReleaseHistories(db, request.originalGameId);
	return {
		version: 0,
		records: [],
		installPreview: rows.map((row) => {
			const game = parseGame(JSON.parse(row.value));
			const versioning = readGameVersioning(
				db,
				game,
				histories.get(row.id) ?? [],
				row.selectedReleaseId
			);
			return {
				gameId: row.id,
				title: game.title,
				versioning,
				hasDraft:
					hasDraftTable &&
					Boolean(
						db
							.prepare('SELECT 1 FROM editor_drafts WHERE game_id=? AND value IS NOT NULL')
							.get(row.id)
					),
				existingHashes: [
					...new Set(
						versioning.releases
							.filter((release) => release.contentVersion === request.contentVersion)
							.map((release) => release.contentHash)
					)
				].sort()
			};
		})
	};
}

/** One release query serves every active installation, preserving per-game insertion order. */
function previewReleaseHistories(db: Database.Database, originalGameId: string) {
	const rows = db
		.prepare(
			`SELECT r.game_id AS gameId, r.id, r.original_game_id AS originalGameId,
		r.content_version AS contentVersion, r.content_hash AS contentHash, r.created_at AS createdAt
		FROM game_releases r JOIN games g ON g.id=r.game_id
		WHERE json_extract(g.value,'$.originalGameId')=? AND json_extract(g.value,'$.trashedAt') IS NULL
		ORDER BY r.game_id, r.rowid`
		)
		.iterate(originalGameId) as Iterable<GameReleaseSummary & { gameId: string }>;
	const histories = new Map<string, GameReleaseSummary[]>();
	for (const { gameId, ...release } of rows) {
		const releases = histories.get(gameId) ?? [];
		requirePackage(releases.length < 10000, 'limit');
		releases.push(release);
		histories.set(gameId, releases);
	}
	return histories;
}
