import { contentVersion, releaseHash } from '../versioning-validation.js';
import { originalGameId } from '../versioning.js';
import {
	checkPackageSize,
	GamePackageError,
	packageObject,
	PACKAGE_LIMITS,
	parsePackageJson,
	requirePackage,
	serializePackageJson
} from './limits.js';

export interface PackageRelease {
	originalGameId: string;
	contentVersion: string;
	contentHash: string;
	createdAt: string;
}

export interface GamePackageManifest {
	format: 'helia-game-package';
	formatVersion: 1;
	release: PackageRelease;
	content: { size: number; sha256: string };
}

function exactKeys(row: Record<string, unknown>, keys: string[]): void {
	requirePackage(Object.keys(row).sort().join(',') === keys.sort().join(','));
}

export function packageTimestamp(value: unknown): string {
	requirePackage(
		typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	);
	requirePackage(!value.startsWith('0000') && Number.isFinite(Date.parse(value)));
	requirePackage(new Date(value).toISOString() === value);
	return value;
}

export function packageOriginalGameId(value: unknown): string {
	try {
		const id = originalGameId(value);
		requirePackage(id === id.toLowerCase());
		return id;
	} catch {
		throw new GamePackageError('format');
	}
}

export function validatePackageRelease(input: unknown): PackageRelease {
	const row = packageObject(input);
	exactKeys(row, ['originalGameId', 'contentVersion', 'contentHash', 'createdAt']);
	try {
		return {
			originalGameId: packageOriginalGameId(row.originalGameId),
			contentVersion: contentVersion(row.contentVersion),
			contentHash: releaseHash(row.contentHash),
			createdAt: packageTimestamp(row.createdAt)
		};
	} catch {
		throw new GamePackageError('format');
	}
}

function validateManifest(input: unknown): GamePackageManifest {
	const row = packageObject(input);
	// Check the format and version header before the key set: a newer writer may
	// add or change keys, and the user still needs the "newer Helia" message.
	requirePackage(row.format === 'helia-game-package');
	requirePackage(Number.isInteger(row.formatVersion));
	if (row.formatVersion !== 1) {
		throw new GamePackageError(Number(row.formatVersion) > 1 ? 'newerHeliaRequired' : 'version');
	}
	exactKeys(row, ['format', 'formatVersion', 'release', 'content']);
	const content = packageObject(row.content);
	exactKeys(content, ['size', 'sha256']);
	requirePackage(typeof content.size === 'number');
	checkPackageSize(content.size, PACKAGE_LIMITS.content);
	try {
		return {
			format: 'helia-game-package',
			formatVersion: 1,
			release: validatePackageRelease(row.release),
			content: { size: content.size, sha256: releaseHash(content.sha256) }
		};
	} catch {
		throw new GamePackageError('format');
	}
}

export function encodeManifest(manifest: GamePackageManifest): Uint8Array {
	const bytes = new TextEncoder().encode(serializePackageJson(validateManifest(manifest)));
	checkPackageSize(bytes.length, PACKAGE_LIMITS.manifest);
	return bytes;
}

export function decodeManifest(bytes: Uint8Array): GamePackageManifest {
	checkPackageSize(bytes.length, PACKAGE_LIMITS.manifest);
	const manifest = validateManifest(parsePackageJson(bytes));
	const expected = encodeManifest(manifest);
	requirePackage(
		expected.length === bytes.length && expected.every((byte, index) => byte === bytes[index])
	);
	return manifest;
}
