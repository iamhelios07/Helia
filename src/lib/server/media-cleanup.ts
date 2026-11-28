import type Database from 'better-sqlite3';

import { setImmediate as nextTurn } from 'node:timers/promises';

import type { StorageCleanupResult } from '#lib/storage/protocol.js';

import { blobId, record } from '#lib/games/state/model.js';

import { deadline, type MediaLifetime } from './media-lifetime.js';

class UnreadableRootsError extends Error {}

/** Only decoding/validation failures belong to unreadable; database I/O stays outside. */
function extractRoots(
	text: string,
	roots: Set<string>,
	extract: (value: unknown, roots: Set<string>) => void
) {
	try {
		extract(JSON.parse(text), roots);
	} catch (cause) {
		throw new UnreadableRootsError('Could not read stored media roots', { cause });
	}
}

function resourceRoots(resources: unknown, roots: Set<string>) {
	const prefix = 'helia-asset:';
	for (const entry of Object.values(record(resources))) {
		const { data } = record(entry);
		if (typeof data === 'string' && data.startsWith(prefix)) {
			roots.add(blobId(data.slice(prefix.length)));
		} else if (typeof data !== 'string' || !data.startsWith('data:')) {
			throw Error('Unknown stored media reference');
		}
	}
}

function contentRoots(content: unknown, roots: Set<string>) {
	const { resources } = record(content);
	if (resources !== undefined) {
		resourceRoots(resources, roots);
	}
}

function draftRoots(draft: unknown, roots: Set<string>) {
	const { baseContent, documents } = record(draft);
	contentRoots(baseContent, roots);
	const { assets } = record(documents);
	if (typeof assets !== 'string') {
		throw Error('Missing draft asset document');
	}
	resourceRoots(JSON.parse(assets), roots);
}

/** These are the persisted root locations, not a search of arbitrary JSON or runtime aliases. */
function collectRoots(db: Database.Database, game: string, now: string, value: string) {
	const roots = new Set<string>();
	extractRoots(value, roots, contentRoots);
	for (const draft of db
		.prepare('SELECT value FROM editor_drafts WHERE game_id=? AND value IS NOT NULL')
		.pluck()
		.iterate(game)) {
		extractRoots(draft as string, roots, draftRoots);
	}
	for (const release of db
		.prepare('SELECT content FROM game_releases WHERE game_id=?')
		.pluck()
		.iterate(game)) {
		extractRoots(release as string, roots, contentRoots);
	}
	const snapshotRows = db.prepare('SELECT value FROM snapshot_resources WHERE game_id=?').pluck();
	const completions = db
		.prepare(
			"SELECT result FROM media_uploads WHERE scope=? AND state='completed' AND expires_at>?"
		)
		.pluck();
	for (const rows of [snapshotRows.iterate(game), completions.iterate(game, now)]) {
		for (const row of rows) {
			extractRoots(row as string, roots, (value, roots) => {
				roots.add(blobId(record(value).blobId));
			});
		}
	}
	return roots;
}

function sweepBlobs(db: Database.Database, game: string, roots: Set<string>) {
	const rows = db
		.prepare(
			`SELECT id, json_extract(value,'$.object') AS object FROM blobs
		WHERE game_id=? AND json_extract(value,'$.schemaVersion')=2`
		)
		.all(game) as { id: string; object: unknown }[];
	const kept = new Set<string>();
	const removed = new Set<string>();
	const deleteAliases = db.prepare('DELETE FROM runtime_assets WHERE game_id=? AND blob_id=?');
	const deleteBlob = db.prepare('DELETE FROM blobs WHERE game_id=? AND id=?');
	let count = 0;
	for (const row of rows) {
		const sha = blobId(row.object);
		if (roots.has(row.id)) {
			kept.add(sha);
			continue;
		}
		deleteAliases.run(game, row.id);
		if (deleteBlob.run(game, row.id).changes !== 1) {
			throw Error('Could not remove blob');
		}
		removed.add(sha);
		count++;
	}
	return { kept, removed, count };
}

function cleanGame(db: Database.Database, game: string) {
	const now = deadline(0);
	const editing = db
		.prepare(
			"SELECT 1 FROM media_leases WHERE game_id=? AND kind='editor' AND expires_at>? LIMIT 1"
		)
		.get(game, now);
	if (editing) {
		return 'editing' as const;
	}
	const value = db.prepare('SELECT value FROM games WHERE id=?').pluck().get(game) as
		string | undefined;
	if (value === undefined) {
		return undefined; // Purged after the game list was read.
	}
	const blobs = sweepBlobs(db, game, collectRoots(db, game, now, value));
	const objects = db
		.prepare(
			`SELECT id, sha256, size FROM media_objects WHERE game_id=? AND state='ready'
		AND id NOT IN (SELECT object_id FROM media_leases WHERE object_id IS NOT NULL AND kind='read' AND expires_at>?)`
		)
		.safeIntegers()
		.all(game, now) as { id: string; sha256: string; size: bigint }[];
	const mark = db.prepare("UPDATE media_objects SET state='deleting' WHERE id=?");
	let queuedObjects = 0,
		cleanedFiles = blobs.count,
		bytes = 0n;
	for (const { id, sha256, size } of objects) {
		if (blobs.kept.has(sha256)) {
			continue;
		}
		if (mark.run(id).changes !== 1) {
			throw Error('Could not queue media object');
		}
		queuedObjects++;
		// A physical object already counted through a removed blob isn't another file.
		cleanedFiles += Number(!blobs.removed.has(sha256));
		bytes += size;
	}
	return { cleanedFiles, removedBlobs: blobs.count, queuedObjects, bytes };
}

/** Explicit settings action only. Each game commits independently; the queue owns chunk I/O. */
export async function cleanStorage(
	db: Database.Database,
	lifetime: MediaLifetime
): Promise<StorageCleanupResult> {
	const cleanup = db.transaction((game: string) => cleanGame(db, game));
	const games = db.prepare('SELECT id FROM games ORDER BY id').pluck().all() as string[];
	const totals = {
		cleanedFiles: 0,
		removedBlobs: 0,
		queuedObjects: 0,
		skippedEditing: 0,
		skippedUnreadable: 0,
		skippedFailed: 0
	};
	let bytes = 0n;
	for (const game of games) {
		try {
			const result = cleanup.immediate(game);
			if (result === 'editing') {
				totals.skippedEditing++;
			} else if (result) {
				totals.cleanedFiles += result.cleanedFiles;
				totals.removedBlobs += result.removedBlobs;
				totals.queuedObjects += result.queuedObjects;
				bytes += result.bytes;
			}
		} catch (error) {
			if (error instanceof UnreadableRootsError) {
				totals.skippedUnreadable++;
			} else {
				totals.skippedFailed++;
			}
		}
		await nextTurn();
	}
	lifetime.wake();
	return { ...totals, reclaimableBytes: bytes.toString() };
}
