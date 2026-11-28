import type {
	CreateGameReleaseResult,
	GameRelease,
	GameReleaseAsset,
	GameReleaseSummary,
	GameVersioning,
	ReleaseVerification
} from './versioning.js';

import { parseGame } from './model.js';
import { gameReleaseContent } from './release-content.js';
import {
	MEDIA_MIMES,
	parseResources,
	RESOURCE_LIMITS,
	RESOURCE_LIST_BYTES,
	validateResourceListBudget
} from './resources.js';
import { originalGameId, parseSemVer } from './versioning.js';

export const CONTENT_NODE_LIMIT = 100000;
export const CONTENT_CHARACTER_LIMIT = 16 * 1024 * 1024;
export const CONTENT_DEPTH_LIMIT = 64;
// Every stored reference uses at least 77 JSON bytes. Allow 32 bytes per possible
// inline entry for the data URI prefix and individual base64 padding.
const INLINE_RESOURCE_ALLOWANCE =
	4n * ((BigInt(RESOURCE_LIMITS.totalBytes) + 2n) / 3n) + 32n * (RESOURCE_LIST_BYTES / 77n);
export const DOCUMENT_OPERATION_LIMITS = {
	draftSave: 3n * BigInt(CONTENT_CHARACTER_LIMIT) + 5n * RESOURCE_LIST_BYTES + 65536n,
	commit:
		6n * BigInt(CONTENT_CHARACTER_LIMIT) +
		RESOURCE_LIST_BYTES +
		INLINE_RESOURCE_ALLOWANCE +
		32n * BigInt(CONTENT_NODE_LIMIT) +
		65536n,
	releaseCreate:
		6n * BigInt(CONTENT_CHARACTER_LIMIT) +
		RESOURCE_LIST_BYTES +
		INLINE_RESOURCE_ALLOWANCE +
		32n * BigInt(CONTENT_NODE_LIMIT) +
		65536n
} as const;

export function validateDocumentOperationBytes(
	operation: keyof typeof DOCUMENT_OPERATION_LIMITS,
	bytes: bigint
): void {
	if (bytes < 0n || bytes > DOCUMENT_OPERATION_LIMITS[operation]) {
		throw Error('저장할 내용이 너무 커요');
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw Error('Invalid versioning object');
	}
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.length || value.length > max) {
		throw Error('Invalid versioning text');
	}
	return value;
}
export function releaseHash(value: unknown): string {
	const hash = text(value, 64);
	if (!/^[a-f0-9]{64}$/.test(hash)) {
		throw Error('Invalid release hash');
	}
	return hash;
}
export function contentVersion(value: unknown): string {
	const version = text(value, 256);
	parseSemVer(version);
	return version;
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 10000) {
		throw Error('Invalid release list');
	}
	return value;
}
export function parseGameReleaseSummary(value: unknown): GameReleaseSummary {
	const row = object(value),
		createdAt = text(row.createdAt, 64);
	if (!Number.isFinite(Date.parse(createdAt))) {
		throw Error('Invalid release timestamp');
	}
	return {
		id: originalGameId(row.id),
		originalGameId: originalGameId(row.originalGameId),
		contentVersion: contentVersion(row.contentVersion),
		contentHash: releaseHash(row.contentHash),
		createdAt
	};
}
export function parseGameVersioning(value: unknown): GameVersioning {
	const row = object(value),
		origin = originalGameId(row.originalGameId),
		hash = releaseHash(row.contentHash);
	const releases = list(row.releases).map(parseGameReleaseSummary);
	if (
		new Set(releases.map((release) => release.id)).size !== releases.length ||
		releases.some((release) => release.originalGameId !== origin)
	) {
		throw Error('Invalid release ownership');
	}
	const currentRelease =
		row.currentRelease === null ? null : parseGameReleaseSummary(row.currentRelease);
	if (
		currentRelease &&
		!releases.some((release) => JSON.stringify(release) === JSON.stringify(currentRelease))
	) {
		throw Error('Invalid selected release');
	}
	if (
		typeof row.modified !== 'boolean' ||
		row.modified !== (currentRelease !== null && currentRelease.contentHash !== hash)
	) {
		throw Error('Invalid modified status');
	}
	return {
		originalGameId: origin,
		contentHash: hash,
		releases,
		currentRelease,
		modified: row.modified
	};
}
export function parseCreateGameReleaseResult(value: unknown): CreateGameReleaseResult {
	const row = object(value);
	if (row.kind === 'released') {
		return { kind: 'released', state: parseGameVersioning(row.state) };
	}
	if (row.kind !== 'conflict') {
		throw Error('Invalid release result');
	}
	const existingHashes = list(row.existingHashes).map(releaseHash),
		incomingHash = releaseHash(row.incomingHash);
	if (
		!existingHashes.length ||
		existingHashes.includes(incomingHash) ||
		new Set(existingHashes).size !== existingHashes.length
	) {
		throw Error('Invalid release conflict');
	}
	return {
		kind: 'conflict',
		contentVersion: contentVersion(row.contentVersion),
		existingHashes,
		incomingHash
	};
}

/** Bound traversal before model parsers recurse or inspect large media/source documents. */
function boundContent(
	value: unknown,
	budget = { nodes: 0n, characters: 0n },
	depth = 0,
	write = true
): void {
	budget.nodes++;
	if (depth > CONTENT_DEPTH_LIMIT || budget.nodes > BigInt(CONTENT_NODE_LIMIT)) {
		throw Error('Release content too complex');
	}
	if (typeof value === 'string') {
		budget.characters += BigInt(value.length);
	}
	if (typeof value === 'object' && value) {
		boundObject(value, budget, depth, write);
	}
	if (budget.characters > BigInt(CONTENT_CHARACTER_LIMIT)) {
		throw Error('Release content too large');
	}
}

function boundObject(
	value: object,
	budget: { nodes: bigint; characters: bigint },
	depth: number,
	write: boolean
) {
	for (const [key, item] of Object.entries(value)) {
		if (!Array.isArray(value)) {
			budget.characters += BigInt(key.length);
		}
		if (depth === 0 && key === 'resources') {
			checkReleaseResources(item, write);
			continue;
		}
		boundContent(item, budget, depth + 1, write);
	}
}

function checkReleaseResources(value: unknown, write: boolean) {
	if (write) {
		validateResourceListBudget(value);
	}
	parseResources(value, { packageReferences: true });
}
export function parseGameRelease(value: unknown): GameRelease {
	const row = object(value),
		summary = parseGameReleaseSummary(row);
	boundContent(row.content, undefined, 0, false);
	// Legacy release inputs ignore install-only provenance, even when malformed.
	const { installedFrom: _ignored, ...content } = object(row.content);
	void _ignored;
	const game = parseGame({
		...content,
		scripts: content.scripts ?? {},
		schemaVersion: 2,
		id: summary.id,
		originalGameId: summary.originalGameId,
		activeSessionId: summary.id,
		createdAt: summary.createdAt,
		updatedAt: summary.createdAt
	});
	// Stored releases may keep `helia-asset:` references; the host confirms their bytes.
	const stored = gameReleaseContent(game, (reference) => reference);
	const assets = row.assets === undefined ? undefined : parseGameReleaseAssets(row.assets, stored);
	return { ...summary, content: stored, ...(assets === undefined ? {} : { assets }) };
}

/** Each reference in the stored content must carry host-confirmed {mime, size, sha256}. */
function parseGameReleaseAssets(
	value: unknown,
	content: ReturnType<typeof gameReleaseContent>
): Record<string, GameReleaseAsset> {
	const rows = object(value);
	const referenced = new Set(
		Object.values(content.resources ?? {})
			.map((asset) => asset.data)
			.filter((data) => data.startsWith('helia-asset:'))
			.map((data) => data.slice(12))
	);
	const result: Record<string, GameReleaseAsset> = {};
	for (const [blobId, raw] of Object.entries(rows)) {
		if (!referenced.has(blobId) || !/^[a-f0-9]{64}$/.test(blobId)) {
			throw Error('Invalid release asset reference');
		}
		const item = object(raw);
		const mime = text(item.mime, 200);
		if (!MEDIA_MIMES.has(mime)) {
			throw Error('Invalid release asset MIME');
		}
		const size = item.size;
		if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
			throw Error('Invalid release asset size');
		}
		result[blobId] = { mime, size, sha256: releaseHash(item.sha256) };
	}
	if (Object.keys(result).length !== referenced.size) {
		throw Error('Missing release asset metadata');
	}
	return result;
}

export function parseReleaseVerification(value: unknown): ReleaseVerification {
	const input = object(value);
	if (typeof input.valid !== 'boolean') {
		throw Error('Invalid release verification');
	}
	return { contentHash: releaseHash(input.contentHash), valid: input.valid };
}

export function validateGameReleaseContent(
	value: unknown,
	{ write = true }: { write?: boolean } = {}
): void {
	boundContent(value, undefined, 0, write);
}
