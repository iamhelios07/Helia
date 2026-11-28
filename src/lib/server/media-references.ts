import type Database from 'better-sqlite3';

import type { GameResources } from '#lib/games/resources.js';

import { requirePackage } from '#lib/games/package/limits.js';
import { parseBlob } from '#lib/storage/protocol.js';

/** A stored blob row owned by this exact game. Missing or foreign rows are `missingAsset`. */
export function ownedBlob(db: Database.Database, gameId: string, blobId: string) {
	const row = db.prepare('SELECT value FROM blobs WHERE game_id=? AND id=?').get(gameId, blobId) as
		{ value: string } | undefined;
	requirePackage(row, 'missingAsset');
	const blob = parseBlob(JSON.parse(row.value));
	requirePackage(blob.gameId === gameId && blob.id === blobId, 'missingAsset');
	return blob;
}

/** Every `helia-asset:` reference must point at a same-game blob with the same MIME (§2.4). */
export function assertOwnedResources(
	db: Database.Database,
	gameId: string,
	resources: GameResources
): void {
	for (const asset of Object.values(resources)) {
		if (!asset.data.startsWith('helia-asset:')) {
			continue;
		}
		const blob = ownedBlob(db, gameId, asset.data.slice(12));
		requirePackage(blob.mime === asset.mime, 'mediaType');
	}
}

/**
 * Drafts keep the working asset document as text. `baseContent.resources` is always
 * structured; the `documents.assets` string may be unfinished JSON while editing, so
 * its references are only checked when it parses into an object.
 */
export function assertOwnedDraftReferences(
	db: Database.Database,
	gameId: string,
	draft: { baseContent: { resources?: GameResources }; documents: { assets?: string } }
): void {
	assertOwnedResources(db, gameId, draft.baseContent.resources ?? {});
	const text = draft.documents.assets;
	if (typeof text !== 'string') {
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return;
	}
	for (const value of Object.values(parsed)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		const row = value as Record<string, unknown>;
		if (typeof row.data !== 'string' || !row.data.startsWith('helia-asset:')) {
			continue;
		}
		const blob = ownedBlob(db, gameId, row.data.slice(12));
		if (typeof row.mime === 'string') {
			requirePackage(blob.mime === row.mime, 'mediaType');
		}
	}
}
