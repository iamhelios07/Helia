import type {
	CreateGameReleaseResult,
	GameRelease,
	GameReleaseSummary,
	GameVersioning
} from './versioning.js';

import { parseGame } from './model.js';
import { gameReleaseContent } from './release-content.js';
import { originalGameId, parseSemVer } from './versioning.js';

export const CONTENT_NODE_LIMIT = 100000;
export const CONTENT_CHARACTER_LIMIT = 16 * 1024 * 1024;
export const CONTENT_DEPTH_LIMIT = 64;

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
function boundContent(value: unknown, budget = { nodes: 0, characters: 0 }, depth = 0): void {
	budget.nodes++;
	if (depth > CONTENT_DEPTH_LIMIT || budget.nodes > CONTENT_NODE_LIMIT) {
		throw Error('Release content too complex');
	}
	if (typeof value === 'string') {
		budget.characters += value.length;
	}
	if (budget.characters > CONTENT_CHARACTER_LIMIT) {
		throw Error('Release content too large');
	}
	if (typeof value === 'object' && value) {
		for (const item of Object.values(value)) {
			boundContent(item, budget, depth + 1);
		}
	}
}
export function parseGameRelease(value: unknown): GameRelease {
	const row = object(value),
		summary = parseGameReleaseSummary(row);
	boundContent(row.content);
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
	return { ...summary, content: gameReleaseContent(game) };
}

export function validateGameReleaseContent(value: unknown): void {
	boundContent(value);
}
