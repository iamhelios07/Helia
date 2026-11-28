import type { InstalledFrom } from '#lib/games/installed-from.js';
import type { PackageRelease } from '#lib/games/package/manifest.js';
import type { GameVersioning } from '#lib/games/versioning.js';

import { GamePackageError, packageObject, requirePackage } from '#lib/games/package/limits.js';
import { packageOriginalGameId, validatePackageRelease } from '#lib/games/package/manifest.js';
import { ResourceListBudgetError } from '#lib/games/resources.js';
import {
	contentVersion,
	parseGameVersioning,
	releaseHash,
	validateGameReleaseContent
} from '#lib/games/versioning-validation.js';
import { originalGameId } from '#lib/games/versioning.js';

export interface ConflictAcknowledgement {
	originalGameId: string;
	contentVersion: string;
	incomingHash: string;
	existingHashes: string[];
}
export interface InstallRequest {
	kind: 'install';
	gameId: string;
	sessionId: string;
	release: PackageRelease & { content: unknown };
	packageFormatVersion: 1;
	installContentVersion?: string;
	conflictAcknowledgement?: ConflictAcknowledgement;
}
export interface PackageVersionSelection {
	release: PackageRelease;
	installContentVersion?: string;
}
export interface InstallPreviewRequest {
	kind: 'installPreview';
	originalGameId: string;
	contentVersion: string;
}
export interface InstallPreviewEntry {
	gameId: string;
	title: string;
	versioning: GameVersioning;
	hasDraft: boolean;
	existingHashes: string[];
}
export type InstallResult =
	| { kind: 'installed'; gameId: string; versioning: GameVersioning }
	| ({ kind: 'conflict' } & ConflictAcknowledgement);

export function parseExistingHashes(value: unknown, incomingHash?: string): string[] {
	requirePackage(Array.isArray(value) && value.length <= 10000);
	const hashes = value.map(releaseHash);
	requirePackage(
		hashes.every(
			(hash, index) => hash !== incomingHash && (index === 0 || hashes[index - 1] < hash)
		)
	);
	return hashes;
}
export function parseConflictAcknowledgement(value: unknown): ConflictAcknowledgement {
	const row = packageObject(value);
	const incomingHash = releaseHash(row.incomingHash);
	return {
		originalGameId: packageOriginalGameId(row.originalGameId),
		contentVersion: contentVersion(row.contentVersion),
		incomingHash,
		existingHashes: parseExistingHashes(row.existingHashes, incomingHash)
	};
}

export function effectiveContentVersion(request: PackageVersionSelection): string {
	const source = contentVersion(request.release.contentVersion);
	if (request.installContentVersion === undefined) {
		return source;
	}
	const version = contentVersion(request.installContentVersion);
	requirePackage(version !== source);
	return version;
}

/** Preserve raw content for the authoritative B1 verification, never normalize it here. */
function readInstallRequest(value: unknown): InstallRequest | InstallPreviewRequest {
	const row = packageObject(value);
	if (row.kind === 'installPreview') {
		return {
			kind: 'installPreview',
			originalGameId: packageOriginalGameId(row.originalGameId),
			contentVersion: contentVersion(row.contentVersion)
		};
	}
	requirePackage(row.kind === 'install' && row.packageFormatVersion === 1);
	const release = packageObject(row.release);
	// Raw complexity precedes all parsers that could strip fields.
	try {
		validateGameReleaseContent(release.content);
		releaseHash(release.contentHash);
	} catch (error) {
		if (error instanceof ResourceListBudgetError) {
			throw new GamePackageError('limit', error);
		}
		throw new GamePackageError('content');
	}
	const { content, ...summary } = release;
	const request: InstallRequest = {
		kind: 'install',
		gameId: originalGameId(row.gameId),
		sessionId: originalGameId(row.sessionId),
		release: { ...validatePackageRelease(summary), content },
		packageFormatVersion: 1,
		...(row.installContentVersion === undefined
			? {}
			: { installContentVersion: contentVersion(row.installContentVersion) }),
		...(row.conflictAcknowledgement === undefined
			? {}
			: { conflictAcknowledgement: parseConflictAcknowledgement(row.conflictAcknowledgement) })
	};
	effectiveContentVersion(request);
	return request;
}

export function parseInstallRequest(value: unknown): InstallRequest | InstallPreviewRequest {
	try {
		return readInstallRequest(value);
	} catch (error) {
		if (error instanceof GamePackageError) {
			throw error;
		}
		throw new GamePackageError('format');
	}
}

export function parseInstallResult(value: unknown): InstallResult {
	const row = packageObject(value);
	if (row.kind === 'installed') {
		return {
			kind: 'installed',
			gameId: originalGameId(row.gameId),
			versioning: parseGameVersioning(row.versioning)
		};
	}
	requirePackage(row.kind === 'conflict');
	const conflict = parseConflictAcknowledgement(row);
	requirePackage(conflict.existingHashes.length > 0);
	return { kind: 'conflict', ...conflict };
}

export function parseInstallPreview(value: unknown): InstallPreviewEntry[] {
	requirePackage(Array.isArray(value) && value.length <= 10000);
	return value.map((item) => {
		const row = packageObject(item);
		requirePackage(typeof row.title === 'string' && typeof row.hasDraft === 'boolean');
		return {
			gameId: originalGameId(row.gameId),
			title: row.title,
			hasDraft: row.hasDraft,
			versioning: parseGameVersioning(row.versioning),
			existingHashes: parseExistingHashes(row.existingHashes)
		};
	});
}

/** Shared with upgrade: provenance always describes the unchanged package release. */
export function packageInstalledFrom(
	request: PackageVersionSelection & { packageFormatVersion: number },
	now: string
): InstalledFrom {
	const { contentVersion, contentHash, createdAt } = request.release;
	return {
		kind: 'package',
		packageFormatVersion: request.packageFormatVersion,
		packageRelease: { contentVersion, contentHash, createdAt },
		versionChanged: effectiveContentVersion(request) !== contentVersion,
		installedAt: now
	};
}
